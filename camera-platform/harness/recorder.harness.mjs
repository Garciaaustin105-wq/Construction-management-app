/**
 * Integration: record → seal → index → evict → crash → recover, against a real
 * filesystem. ffmpeg is replaced by a fake producer that writes the same files
 * in the same places, so the whole loop is exercised with no camera and no
 * ffmpeg — which is also what makes it deterministic.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIndex } from "../agent/segindex.mjs";
import { assignCamerasToDrives, indexPathFor, XFS_MOUNT_OPTIONS } from "../agent/config.mjs";
import { scanDisk, applyEviction, applyRecovery, ensureCameraDirs, removeStore, quarantineUsage, INPROGRESS, QUARANTINE }
  from "../agent/segstore.mjs";
import { createCameraRecorder, ffmpegArgs } from "../agent/recorder.mjs";
import { planRecovery } from "../dist/recovery.js";
import { planEviction } from "../dist/eviction.js";
import { check, eq, close, report } from "./_assert.mjs";

console.log("recorder integration");

const root = await mkdtemp(path.join(tmpdir(), "camplat-store-"));
// The index goes on the OS NVMe, never inside the store root — see
// agent/config.mjs. Here that is a separate temp dir standing in for it.
const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-state-"));
const index = openIndex(path.join(stateDir, "index.db"));
const CAM = "cam-1";
const SEG = 60;
const SIZE = 15_000_000;          // 60s at 2000 kbps

// Stands in for ffmpeg: same output path, same naming, same units (epoch seconds).
const fakeChildren = [];
function fakeSpawn() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", 0);
  fakeChildren.push(child);
  return child;
}
async function produceSegment(epochSeconds, bytes = SIZE) {
  await mkdir(path.join(root, CAM, INPROGRESS), { recursive: true });
  await writeFile(path.join(root, CAM, INPROGRESS, `${epochSeconds}.mp4`), Buffer.alloc(bytes));
}

const events = [];
const recorder = createCameraRecorder({
  root, cameraId: CAM, url: "rtsp://u:p@10.0.0.5:554/profile1",
  index, segmentSeconds: SEG, pollMs: 100_000, bitrateKbps: 2000,
  spawnFn: fakeSpawn, onEvent: (e) => events.push(e),
});
await recorder.start();

const T0 = 1_757_500_000;   // arbitrary epoch seconds, aligned

check("ffmpeg is invoked with stream-copy and fragmented mp4", () => {
  const args = ffmpegArgs("rtsp://x", "/out/%s.mp4", 60).join(" ");
  if (!args.includes("-c copy")) throw new Error("transcoding would cut camera count by four");
  if (!args.includes("frag_keyframe")) throw new Error("a truncated plain mp4 is unplayable in full");
  if (!args.includes("-rtsp_transport tcp")) throw new Error("UDP RTSP under-reports on a loaded network");
  if (!args.includes("-an")) throw new Error("audio must be off by default — all-party consent states");
});

check("the URL never reaches an event with its password", () => {
  const started = events.find((e) => e.kind === "started");
  if (started.url.includes("p@") || started.url.includes(":p:")) throw new Error("password leaked");
  if (!started.url.includes(":***@")) throw new Error("not redacted");
});

await check("a completed segment is sealed and indexed; the open one is not", async () => {
  await produceSegment(T0);
  await produceSegment(T0 + SEG);
  await recorder.poll();

  const sealed = index.withState("sealed");
  eq(sealed.length, 1, "one sealed");
  eq(sealed[0].path, `${CAM}/${T0 * 1000}.mp4`, "seconds converted to ms in the path");
  eq(sealed[0].bytes, SIZE, "byte count from the filesystem");
  eq(index.withState("open").length, 1, "the newest file is still open");
});

check("THE FEARED ONE: an open segment has bytes null, not 0", () => {
  const open = index.withState("open")[0];
  eq(open.bytes, null, "bytes");
  eq(open.endUtc, null, "end time unknown while open");
  if (open.bytes === 0) throw new Error("SQLite coerced NULL to 0 — blank became a zero");
});

check("a null bitrate survives the round trip through SQLite", () => {
  index.put({ cameraId: "cam-x", startUtc: "2026-09-10T00:00:00.000Z", endUtc: null,
    path: "cam-x/1.mp4", bytes: null, state: "open", hold: false, pendingUpload: false, bitrateKbps: null });
  const back = index.get("cam-x/1.mp4");
  eq(back.bitrateKbps, null, "bitrateKbps");
  eq(back.bytes, null, "bytes");
  index.remove("cam-x/1.mp4");
});

await check("more segments seal in order, leaving exactly one open", async () => {
  await produceSegment(T0 + SEG * 2);
  await produceSegment(T0 + SEG * 3);
  await recorder.poll();
  eq(index.withState("sealed").length, 3, "sealed");
  eq(index.withState("open").length, 1, "always exactly one open");
  close(index.totalBytes(), 3 * SIZE, 1, "totalBytes counts only sealed");
});

await check("scanDisk separates sealed files from the in-progress one", async () => {
  const scan = await scanDisk(root);
  eq(scan.sealed.length, 3, "sealed on disk");
  eq(scan.inProgress.length, 1, "one in progress");
  if (!scan.inProgress[0].path.includes(INPROGRESS)) throw new Error("in-progress not identified structurally");
});

await check("THE FEARED ONE: a power cut leaves a partial that recovery seals and gaps", async () => {
  // A power cut truncates the file being written. Half a segment's bytes is
  // half a segment's video — 30s of a 60s segment. The appliance then stays
  // down until someone notices, so the boundary is well past that.
  const openFile = path.join(root, CAM, INPROGRESS, `${T0 + SEG * 3}.mp4`);
  await writeFile(openFile, Buffer.alloc(SIZE / 2));

  const scan = await scanDisk(root);
  const indexed = index.all().filter((s) => s.cameraId === CAM);
  const onDisk = [...scan.sealed, ...scan.inProgress];
  const boundary = new Date((T0 + SEG * 6) * 1000).toISOString();

  const plan = planRecovery(indexed, onDisk, boundary);
  eq(plan.summary.confirmed, 3, "three sealed segments confirmed");
  eq(plan.summary.partials, 1, "the in-progress file is a partial");
  eq(plan.summary.lost, 0, "nothing lost");

  const partial = plan.actions.find((a) => a.kind === "seal_partial");
  eq(partial.needsMediaValidation, true, "flagged for a real probe");
  eq(partial.actualBytes, SIZE / 2, "truncated size taken from disk, not the index");
  // Half the bytes at 2000 kbps is 30s of video, so the segment ends 30s in.
  eq(partial.estimatedEndUtc, new Date((T0 + SEG * 3 + 30) * 1000).toISOString(),
     "end estimated from the bytes actually on disk");

  eq(plan.gaps.length, 1, "one gap");
  eq(plan.gaps[0].startUtc, partial.estimatedEndUtc, "gap starts where the video stopped");
  eq(plan.gaps[0].endUtc, boundary, "and runs to the scan, not to the segment boundary");
  eq(plan.gaps[0].reason, "appliance_offline", "reason");
  index.addGap(plan.gaps[0]);
  eq(index.gapsFor(CAM).length, 1, "gap persisted");
});

await check("an orphan file is adopted, junk is quarantined, empties are dropped", async () => {
  await writeFile(path.join(root, CAM, `${(T0 + SEG * 5) * 1000}.mp4`), Buffer.alloc(9_000_000));
  await writeFile(path.join(root, CAM, "ffmpeg-scratch.tmp"), Buffer.alloc(0));
  await writeFile(path.join(root, CAM, "mystery.dat"), Buffer.alloc(1234));

  const scan = await scanDisk(root);
  const plan = planRecovery(index.all().filter((s) => s.cameraId === CAM), scan.sealed,
    new Date((T0 + SEG * 6) * 1000).toISOString());
  eq(plan.summary.adopted, 1, "the orphan segment is kept");
  eq(plan.summary.dropped, 1, "the zero-byte file is dropped");
  eq(plan.summary.quarantined, 1, "the unrecognised file is set aside, not deleted");

  const applied = await applyRecovery(root, plan);
  eq(applied.quarantined.length, 1, "moved to quarantine");
  const quarantined = await readdir(path.join(root, QUARANTINE));
  eq(quarantined.length, 1, "quarantine holds it");
  const stillThere = await stat(path.join(root, QUARANTINE, quarantined[0]));
  eq(stillThere.size, 1234, "quarantined file is intact — nothing was destroyed");
});

await check("THE FEARED ONE: quarantining the same path twice keeps both files", async () => {
  const qroot = await mkdtemp(path.join(tmpdir(), "camplat-q1-"));
  await mkdir(path.join(qroot, CAM), { recursive: true });
  const junk = { path: `${CAM}/mystery.dat`, bytes: 0 };
  const plan = { actions: [{ kind: "quarantine", file: junk, reason: "unrecognised" }] };

  await writeFile(path.join(qroot, CAM, "mystery.dat"), Buffer.alloc(111));
  const first = await applyRecovery(qroot, plan);
  await writeFile(path.join(qroot, CAM, "mystery.dat"), Buffer.alloc(222));
  const second = await applyRecovery(qroot, plan);

  const held = await readdir(path.join(qroot, QUARANTINE));
  eq(held.length, 2, "both boots' files are in quarantine");
  const sizes = (await Promise.all(held.map((n) => stat(path.join(qroot, QUARANTINE, n))))).map((s) => s.size).sort((a, b) => a - b);
  eq(sizes, [111, 222], "neither file replaced the other");
  eq(first.quarantined[0].movedTo !== second.quarantined[0].movedTo, true, "each move reports its own target");
});

await check("a quarantine move that fails is reported as failed, not as quarantined", async () => {
  const qroot = await mkdtemp(path.join(tmpdir(), "camplat-q1-"));
  const plan = { actions: [{ kind: "quarantine", file: { path: `${CAM}/gone.dat`, bytes: 0 }, reason: "unrecognised" }] };
  const applied = await applyRecovery(qroot, plan);
  eq(applied.quarantined.length, 0, "nothing claimed as quarantined");
  eq(applied.failed.length, 1, "the failure is reported");
  eq(applied.failed[0].path, `${CAM}/gone.dat`, "names the file");
});

await check("quarantineUsage measures what quarantine holds, and a store with none reads zero", async () => {
  const qroot = await mkdtemp(path.join(tmpdir(), "camplat-q2-"));
  eq(await quarantineUsage(qroot), { files: 0, bytes: 0 }, "no quarantine directory yet");
  await mkdir(path.join(qroot, QUARANTINE), { recursive: true });
  await writeFile(path.join(qroot, QUARANTINE, "a.dat"), Buffer.alloc(111));
  await writeFile(path.join(qroot, QUARANTINE, "b.dat"), Buffer.alloc(222));
  eq(await quarantineUsage(qroot), { files: 2, bytes: 333 }, "two files, sizes summed");
});

await check("quarantineUsage refuses rather than reading an unreadable quarantine as empty", async () => {
  const qroot = await mkdtemp(path.join(tmpdir(), "camplat-q2-"));
  await writeFile(path.join(qroot, QUARANTINE), "a file where the directory should be");
  let threw = false;
  try { await quarantineUsage(qroot); } catch { threw = true; }
  eq(threw, true, "an error that is not absence is not a zero");
});

await check("THE FEARED ONE: eviction deletes oldest first and spares a held segment", async () => {
  const all = index.all().filter((s) => s.state === "sealed" && s.cameraId === CAM);
  const held = all[0];
  index.put({ ...held, hold: true });

  const segments = index.all().filter((s) => s.cameraId === CAM);
  const plan = planEviction(segments, SIZE * 2);
  if (plan.evict.some((c) => c.segment.path === held.path)) {
    throw new Error("evidence under hold was selected for deletion");
  }

  const result = await applyEviction(root, plan);
  index.removeMany(result.deleted);

  const scan = await scanDisk(root);
  const remaining = scan.sealed.map((f) => f.path);
  if (!remaining.includes(held.path)) throw new Error("held segment was deleted from disk");
  eq(index.get(held.path) !== null, true, "held segment still indexed");
});

await check("evicting a file that is already gone is not an error", async () => {
  const segments = index.all().filter((s) => s.state === "sealed");
  if (segments.length === 0) throw new Error("nothing left to test with");
  const ghost = { ...segments[0], path: `${CAM}/999999999999.mp4` };
  const result = await applyEviction(root, { evict: [{ segment: ghost, bytes: 1 }] });
  eq(result.deleted, [ghost.path], "reported so the index can drop it");
  eq(result.bytesFreed, 0, "but no space was actually freed");
});

await recorder.stop();
index.close();
await removeStore(root);
await check("the index is never placed on a recording drive", async () => {
  const scan = await scanDisk(root);
  const all = [...scan.sealed, ...scan.inProgress].map((f) => f.path);
  if (all.some((p) => p.endsWith(".db") || p.includes("index"))) {
    throw new Error("the SQLite index landed on the recording drive it must avoid");
  }
  // indexPathFor uses path.join, so on Windows it returns \var\lib\camplat\index.db.
  // Compare against the same join; a hard-coded "/" prefix failed on every Windows run.
  if (!indexPathFor("/var/lib/camplat").startsWith(path.join("/var/lib/camplat"))) {
    throw new Error("default index path must be on the OS drive");
  }
});

check("cameras are assigned whole to drives, in contiguous blocks", () => {
  const ids = Array.from({ length: 16 }, (_, i) => `cam-${i + 1}`);
  const map = assignCamerasToDrives(ids, 2);
  eq(map.get("cam-1"), 0, "first camera on drive 0");
  eq(map.get("cam-8"), 0, "eighth still on drive 0");
  eq(map.get("cam-9"), 1, "ninth moves to drive 1");
  eq(map.get("cam-16"), 1, "last on drive 1");
  const counts = [0, 0];
  for (const drive of map.values()) counts[drive]++;
  eq(counts, [8, 8], "evenly split");
});

check("an odd camera count still fits, with no camera unassigned", () => {
  const ids = Array.from({ length: 17 }, (_, i) => `c${i}`);
  const map = assignCamerasToDrives(ids, 2);
  eq(map.size, 17, "every camera assigned");
  for (const drive of map.values()) {
    if (drive < 0 || drive > 1) throw new Error(`camera assigned to nonexistent drive ${drive}`);
  }
});

check("XFS is mounted with a large allocsize — the anti-fragmentation setting", () => {
  if (!XFS_MOUNT_OPTIONS.includes("allocsize=")) {
    throw new Error("without allocsize, 8 concurrent writers fragment the platter");
  }
  if (!XFS_MOUNT_OPTIONS.includes("noatime")) throw new Error("atime turns every read into a write");
});

// The appliance clock steps back (NTP correcting a dead RTC battery) and ffmpeg
// names a new segment with a start time already on disk. POSIX rename replaces
// the target without a word, so the old footage is gone and its index row now
// describes a different file. Found by the Linux audit, 2026-09-14.
await check("THE FEARED ONE: a clock step back never overwrites sealed footage", async () => {
  const stepRoot = await mkdtemp(path.join(tmpdir(), "camplat-clockstep-"));
  const stepIndex = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-clockstep-state-")), "index.db"));
  const stepEvents = [];
  const stepCam = "cam-clock";
  const wip = async (epochSeconds, bytes) => {
    await mkdir(path.join(stepRoot, stepCam, INPROGRESS), { recursive: true });
    await writeFile(path.join(stepRoot, stepCam, INPROGRESS, `${epochSeconds}.mp4`), Buffer.alloc(bytes));
  };
  const stepRec = createCameraRecorder({
    root: stepRoot, cameraId: stepCam, url: "rtsp://u:p@10.0.0.8:554/x",
    index: stepIndex, segmentSeconds: SEG, pollMs: 100_000, bitrateKbps: 2000,
    spawnFn: fakeSpawn, onEvent: (e) => stepEvents.push(e),
  });
  await stepRec.start();
  try {
    await wip(T0, 1000);
    await wip(T0 + SEG, 500);
    await stepRec.poll();
    const sealedRel = `${stepCam}/${T0 * 1000}.mp4`;
    eq((await stat(path.join(stepRoot, sealedRel))).size, 1000, "the first segment sealed");

    // The clock stepped back: a new recording carries the same start time.
    await wip(T0, 2000);
    await stepRec.poll();
    eq((await stat(path.join(stepRoot, sealedRel))).size, 1000, "the sealed file on disk is the original");
    eq(stepIndex.get(sealedRel)?.bytes, 1000, "the index row still describes the original");
    const failed = stepEvents.filter((e) => e.kind === "seal_failed" && e.file === `${T0}.mp4`);
    eq(failed.length, 1, "the collision is reported once");
    const setAside = await readdir(path.join(stepRoot, QUARANTINE)).catch(() => []);
    eq(setAside.length, 1, "the new recording is set aside, not destroyed");
    eq((await stat(path.join(stepRoot, QUARANTINE, setAside[0]))).size, 2000, "and it is intact");
    const left = await readdir(path.join(stepRoot, stepCam, INPROGRESS));
    eq(left.includes(`${T0}.mp4`), false, "it no longer sits in .inprogress to fail on every poll");

    await stepRec.poll();
    eq(stepEvents.filter((e) => e.kind === "seal_failed").length, 1, "a later poll does not report it again");
  } finally {
    await stepRec.stop();
    stepIndex.close();
  }
});

// A child that fails to spawn (ffmpeg missing or not executable) emits 'error',
// and may or may not emit 'exit' after it. With no 'error' listener Node throws,
// which on the appliance takes down every camera's recorder at once.
await check("THE FEARED ONE: ffmpeg failing to spawn is retried, never a crash, never two writers", async () => {
  const spawned = [];
  const script = [["error"], ["error", "exit"]];
  let threw = null;
  const failingSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const steps = script[spawned.length] ?? [];
    spawned.push(child);
    setImmediate(() => {
      try {
        for (const step of steps) {
          if (step === "error") child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT rtsp://u:p@10.0.0.9/x"), { code: "ENOENT" }));
          else child.emit("exit", null);
        }
      } catch (err) {
        threw = err;
      }
    });
    return child;
  };
  const failEvents = [];
  // The shared index above is already closed by now; this check owns its own.
  const failIndex = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-nospawn-")), "index.db"));
  const failing = createCameraRecorder({
    root, cameraId: "cam-nospawn", url: "rtsp://u:p@10.0.0.9:554/x",
    index: failIndex, segmentSeconds: SEG, pollMs: 100_000, spawnFn: failingSpawn, onEvent: (e) => failEvents.push(e),
  });
  await failing.start();
  try {
    await new Promise((r) => setTimeout(r, 4_500));
    if (threw) throw new Error(`the spawn error was unhandled: ${threw.message}`);
    eq(spawned.length, 3, "one relaunch per failure: error alone, then error followed by exit");
    const failed = failEvents.filter((e) => e.kind === "spawn_failed");
    eq(failed.length, 2, "each failure reported as spawn_failed");
    if (failed.some((e) => String(e.error).includes(":p@"))) throw new Error("password leaked in spawn_failed");
    if (failIndex.gapsFor("cam-nospawn").length === 0) throw new Error("no gap recorded for the time ffmpeg was down");
  } finally {
    await failing.stop();
    failIndex.close();
  }
});

// L13: systemd stops the service with SIGTERM and waits TimeoutStopSec (30s)
// before SIGKILL. If stop() returns before ffmpeg has written its last fragment,
// the process exits under it and the newest segment is cut mid-write on every
// update, reboot and power-button press.
function stoppableSpawn(onKill) {
  const children = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4000 + children.length;
    child.signals = [];
    child.exited = false;
    child.once("exit", () => { child.exited = true; });
    child.kill = (signal) => { child.signals.push(signal); onKill(child, signal); return true; };
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}
async function stoppableRecorder(name, spawnFn, extra = {}) {
  const stopEvents = [];
  const stopIndex = openIndex(path.join(await mkdtemp(path.join(tmpdir(), `camplat-${name}-`)), "index.db"));
  const rec = createCameraRecorder({
    root, cameraId: `cam-${name}`, url: "rtsp://u:p@10.0.0.7:554/x",
    index: stopIndex, segmentSeconds: SEG, pollMs: 100_000, spawnFn, onEvent: (e) => stopEvents.push(e), ...extra,
  });
  await rec.start();
  return { rec, stopEvents, stopIndex };
}
const settle = (promise, ms) => Promise.race([
  promise.then(() => "resolved"),
  new Promise((r) => setTimeout(() => r("hung"), ms)),
]);

await check("THE FEARED ONE: stop waits for ffmpeg to finish its last fragment before returning", async () => {
  const { spawnFn, children } = stoppableSpawn((child, signal) => {
    if (signal === "SIGTERM") setTimeout(() => child.emit("exit", 0), 150);
  });
  const { rec, stopEvents, stopIndex } = await stoppableRecorder("graceful", spawnFn, { stopTimeoutMs: 5_000 });
  try {
    const outcome = await settle(rec.stop(), 3_000);
    eq(outcome, "resolved", "stop returned");
    eq(children.length, 1, "one ffmpeg");
    eq(children[0].signals, ["SIGTERM"], "asked politely, once");
    eq(children[0].exited, true, "ffmpeg had exited by the time stop returned");
    eq(stopEvents.some((e) => e.kind === "stop_killed"), false, "no kill reported for a clean exit");
  } finally {
    stopIndex.close();
  }
});

await check("THE FEARED ONE: an ffmpeg that ignores SIGTERM is killed, and stop still returns inside the timeout", async () => {
  const { spawnFn, children } = stoppableSpawn(() => { /* hung on a dead RTSP read: ignores every signal */ });
  const { rec, stopEvents, stopIndex } = await stoppableRecorder("hung", spawnFn, { stopTimeoutMs: 200 });
  try {
    const began = Date.now();
    const outcome = await settle(rec.stop(), 3_000);
    const took = Date.now() - began;
    eq(outcome, "resolved", "stop returned even though ffmpeg never exited");
    eq(children[0].signals, ["SIGTERM", "SIGKILL"], "SIGTERM, then SIGKILL after the timeout");
    eq(took >= 150, true, `waited for the timeout before killing (${took}ms)`);
    const killed = stopEvents.filter((e) => e.kind === "stop_killed");
    eq(killed.length, 1, "the kill is reported");
    eq(killed[0]?.cameraId, "cam-hung", "naming the camera");
    if (JSON.stringify(killed).includes(":p@")) throw new Error("password leaked in stop_killed");
  } finally {
    stopIndex.close();
  }
});

await check("a camera whose ffmpeg already exited does not hold up stop", async () => {
  const { spawnFn, children } = stoppableSpawn(() => { /* would never exit if signalled */ });
  const { rec, stopEvents, stopIndex } = await stoppableRecorder("gone", spawnFn, { stopTimeoutMs: 5_000 });
  try {
    children[0].emit("exit", 1);
    await new Promise((r) => setTimeout(r, 20));
    const began = Date.now();
    const outcome = await settle(rec.stop(), 3_000);
    eq(outcome, "resolved", "stop returned");
    eq(Date.now() - began < 1_000, true, "without waiting out the timeout");
    eq(children[0].signals.includes("SIGKILL"), false, "nothing to kill");
    eq(stopEvents.some((e) => e.kind === "stop_killed"), false, "no kill reported");
  } finally {
    stopIndex.close();
  }
});

report("recorder integration");
