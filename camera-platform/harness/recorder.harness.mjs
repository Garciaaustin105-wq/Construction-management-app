/**
 * Integration: record → seal → index → evict → crash → recover, against a real
 * filesystem. ffmpeg is replaced by a fake producer that writes the same files
 * in the same places, so the whole loop is exercised with no camera and no
 * ffmpeg — which is also what makes it deterministic.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIndex } from "../agent/segindex.mjs";
import { assignCamerasToDrives, indexPathFor, XFS_MOUNT_OPTIONS } from "../agent/config.mjs";
import { scanDisk, applyEviction, applyRecovery, ensureCameraDirs, removeStore, quarantineUsage, INPROGRESS, QUARANTINE }
  from "../agent/segstore.mjs";
import { createCameraRecorder, ffmpegArgs, detectionArgs, RTSP_TIMEOUT_US } from "../agent/recorder.mjs";
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

// A connection that dies without a reset -- the box sleeping and waking, a
// camera rebooting, a cable replugged -- leaves ffmpeg waiting on it forever
// unless its socket has a timeout: no exit, so no restart and no gap recorded.
// Proven on the bench laptop (ffmpeg 6.1.1) against a peer that accepts and
// then says nothing: 30 s and still waiting without one, gone in 5 s with one.
// Found after a suspend left recording silent for 13 minutes (FIELD-NOTES).
check("THE FEARED ONE: a camera connection that goes silent fails in seconds instead of hanging forever", () => {
  eq(RTSP_TIMEOUT_US, 10_000_000, "10 s, in microseconds: ffmpeg's unit for this option");
  for (const [what, args] of [
    ["recording", ffmpegArgs("rtsp://x", "/out/%s.mp4", 60)],
    ["recording with audio", ffmpegArgs("rtsp://x", "/out/%s.mp4", 60, { audio: true })],
    ["detection", detectionArgs("rtsp://x")],
    ["detection, software decode", detectionArgs("rtsp://x", { hwaccel: false })],
  ]) {
    const t = args.indexOf("-timeout");
    eq(t >= 0, true, what + ": has a socket timeout");
    eq(t < args.indexOf("-i"), true, what + ": set before the input it applies to, or ffmpeg ignores it");
    eq(args[t + 1], String(RTSP_TIMEOUT_US), what + ": the agreed value");
  }
});

// A box that sleeps records nothing, and while it sleeps nothing on it can say
// so. install.sh is a root-on-a-bare-box script and cannot be run here, so this
// holds its text: the targets must be MASKED, which no lid, power key, idle
// timer or stray "systemctl suspend" can start. Found when the bench laptop
// suspended mid-recording (FIELD-NOTES, 2026-09-18).
check("THE FEARED ONE: an installed box can never sleep", () => {
  const install = readFileSync(join(import.meta.dirname, "..", "setup", "install.sh"), "utf8").replaceAll("\r\n", "\n");
  const mask = install.split("\n").find((l) => /^\s*systemctl mask\b/.test(l)) ?? "";
  for (const target of ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target",
    "suspend-then-hibernate.target"]) {
    eq(mask.split(/\s+/).includes(target), true, target + " is masked by install.sh");
  }
});

// D6: stores run audio on, and cameras send G.711, G.726, G.722, MP2, L16, AAC
// or Opus. Copied into mp4, the first four write nothing at all, video included.
check("THE FEARED ONE: audio on converts to AAC, so any camera's audio still records; audio off is unchanged", () => {
  const off = ffmpegArgs("rtsp://x", "/out/%s.mp4", 60);
  eq(ffmpegArgs("rtsp://x", "/out/%s.mp4", 60, { audio: false }), off, "audio:false is today's arguments exactly");
  eq(off.includes("-an"), true, "audio off by default");
  const on = ffmpegArgs("rtsp://x", "/out/%s.mp4", 60, { audio: true });
  const joined = on.join(" ");
  eq(on.includes("-an"), false, "no -an with audio on");
  eq(joined.includes("-c:v copy") && joined.includes("-c:a aac"), true, `video copied, audio to AAC: ${joined}`);
  eq(joined.includes("-map 0:v:0") && joined.includes("-map 0:a:0?"), true, "a camera with no audio track still records");
  if (joined.includes("-c copy")) throw new Error("-c copy would copy G.711 into mp4 and write nothing");
  eq(on.slice(-1), off.slice(-1), "same output pattern last");
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


// D6: a camera whose audio ffmpeg cannot decode makes the AAC conversion fail,
// and with it the video. The recorder must fall back to video only, but a camera
// that is simply offline must not lose its audio setting.
function audioScriptSpawn(plan) {
  const children = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 5000 + children.length;
    child.audio = !args.includes("-an");
    child.kill = () => { setImmediate(() => child.emit("exit", null)); return true; };
    const exitAfter = plan(child, children.length);
    children.push(child);
    if (exitAfter !== null) setTimeout(() => child.emit("exit", 1), exitAfter);
    return child;
  };
  return { spawnFn, children };
}
async function audioRecorder(name, spawnFn) {
  const events = [];
  const idx = openIndex(path.join(await mkdtemp(path.join(tmpdir(), `camplat-${name}-`)), "index.db"));
  const rec = createCameraRecorder({
    root, cameraId: `cam-${name}`, url: "rtsp://u:p@10.0.0.8:554/x", index: idx, segmentSeconds: SEG, pollMs: 100_000,
    spawnFn, onEvent: (e) => events.push(e), audio: true, restartDelayMs: 20, audioProbeMs: 300, stopTimeoutMs: 500,
  });
  await rec.start();
  return { rec, events, idx };
}

await check("THE FEARED ONE: audio ffmpeg cannot handle falls back to video only, and says so", async () => {
  // With audio, ffmpeg dies at once; without it, it records.
  const { spawnFn, children } = audioScriptSpawn((child) => (child.audio ? 10 : null));
  const { rec, events, idx } = await audioRecorder("badaudio", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 900));
    eq(children.map((c) => c.audio), [true, true, false], "two audio failures, then one video-only run that stays up");
    const dropped = events.filter((e) => e.kind === "audio_dropped");
    eq(dropped.length, 1, "audio_dropped reported once");
    eq(dropped[0]?.cameraId, "cam-badaudio", "naming the camera");
    if (JSON.stringify(events).includes(":p@")) throw new Error("password leaked in an event");
  } finally {
    await rec.stop();
    idx.close();
  }
});

await check("THE FEARED ONE: an offline camera keeps its audio; only a video-only run that works drops it", async () => {
  // Every run dies at once, audio or not: the camera is down, not its audio.
  const { spawnFn, children } = audioScriptSpawn(() => 10);
  const { rec, events, idx } = await audioRecorder("offline", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 900));
    eq(events.some((e) => e.kind === "audio_dropped"), false, "no audio_dropped for a camera that is down");
    const runs = children.map((c) => c.audio);
    eq(runs.length >= 5, true, `kept retrying (${runs.length} runs)`);
    for (let i = 1; i < runs.length; i++) {
      if (!runs[i] && !runs[i - 1]) throw new Error(`two video-only runs in a row: ${JSON.stringify(runs)}`);
    }
    const trial = runs.indexOf(false);
    eq(trial >= 0 && runs[trial + 1] === true, true, `audio back on after a failed video-only trial: ${JSON.stringify(runs)}`);
  } finally {
    await rec.stop();
    idx.close();
  }
});

await check("a single drop, or drops between long runs, never turns audio off", async () => {
  // fast fail, a long run, fast fail, then stays up.
  const { spawnFn, children } = audioScriptSpawn((child, n) => [10, 400, 10, null][n] ?? null);
  const { rec, events, idx } = await audioRecorder("flaky", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 900));
    eq(children.map((c) => c.audio), [true, true, true, true], "every run keeps audio");
    eq(events.some((e) => e.kind === "audio_dropped"), false, "nothing dropped");
  } finally {
    await rec.stop();
    idx.close();
  }
});

// Like audioScriptSpawn, but each run chooses its own exit code: the recorder
// must tell "the camera is unreachable" (a network errno) from anything else.
// plan(child, n) -> null to stay up, or { afterMs, code }.
function codedSpawn(plan, { ignoreSigterm = false } = {}) {
  const children = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 6000 + children.length;
    child.audio = !args.includes("-an");
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (ignoreSigterm && signal === "SIGTERM") return true;
      setImmediate(() => child.emit("exit", null));
      return true;
    };
    const step = plan(child, children.length);
    children.push(child);
    if (step !== null) setTimeout(() => child.emit("exit", step.code), step.afterMs);
    return child;
  };
  return { spawnFn, children };
}

await check("THE FEARED ONE: a camera that is unreachable never costs its audio", async () => {
  // The 2026-09-18 unplug test, in exit codes: 146 (connect timed out), then
  // 143 (no route to host) while the camera boots, then it records.
  const codes = [146, 143, 143, 145, 143];
  const { spawnFn, children } = codedSpawn((child, n) => (n < codes.length ? { afterMs: 10, code: codes[n] } : null));
  const { rec, events, idx } = await audioRecorder("unreachable", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 900));
    eq(children.length, codes.length + 1, "retried through the outage");
    eq(children.map((c) => c.audio).every(Boolean), true, `every run kept audio: ${JSON.stringify(children.map((c) => c.audio))}`);
    eq(events.some((e) => e.kind === "audio_dropped"), false, "no audio_dropped for a camera that was unreachable");
  } finally {
    await rec.stop();
    idx.close();
  }
});

await check("THE FEARED ONE: dropped audio is tried again on the next reconnect, and says when it is back", async () => {
  // Two quick audio failures, a video-only trial that records (so audio is
  // dropped), then the camera drops; the reconnect tries audio and it holds.
  const plan = [{ afterMs: 10, code: 1 }, { afterMs: 10, code: 1 }, { afterMs: 500, code: 1 }];
  const { spawnFn, children } = codedSpawn((child, n) => plan[n] ?? null);
  const { rec, events, idx } = await audioRecorder("comeback", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 1200));
    eq(children.map((c) => c.audio), [true, true, false, true], "audio tried again after the video-only run ended");
    const kinds = events.filter((e) => e.kind === "audio_dropped" || e.kind === "audio_restored").map((e) => e.kind);
    eq(kinds, ["audio_dropped", "audio_restored"], "dropped, then restored");
    const dropped = events.find((e) => e.kind === "audio_dropped");
    if (/until the service restarts/.test(dropped?.reason ?? "")) throw new Error(`the drop still claims to be permanent: ${dropped.reason}`);
  } finally {
    await rec.stop();
    idx.close();
  }
});

// Bench 2026-09-19: a one-minute unplug left a dozen gap rows, one per retry,
// each covering only the 2 s between tries, with the seconds of each failed
// try covered by nothing. One outage is one gap: open from the first failure,
// stretched on every retry, closed when video flows again.
await check("THE FEARED ONE: a camera down across many retries is ONE gap, from the drop to when video resumes", async () => {
  const t0 = Date.now();
  const plan = [0, 1, 2, 3].map(() => ({ afterMs: 10, code: 143 }));
  const { spawnFn, children } = codedSpawn((child, n) => plan[n] ?? null);
  const { rec, events, idx } = await audioRecorder("outage", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 300));
    eq(children.length, 5, "four failed tries, then a run that stays up");
    const during = idx.gapsFor("cam-outage");
    eq(during.length, 1, "one gap while the camera is still down, not one per retry");
    eq(during[0].reason, "camera_offline", "reason");
    const start = Date.parse(during[0].startUtc);
    eq(start >= t0 && start - t0 < 200, true, `it starts at the first drop (${start - t0} ms after start)`);
    eq(Date.parse(during[0].endUtc) > start + 50, true, "and has been stretched by the retries");
    // Video flows again: the run writes its first segment file.
    const resumedSec = Math.ceil(Date.now() / 1000);
    await writeFile(path.join(root, "cam-outage", INPROGRESS, `${resumedSec}.mp4`), Buffer.alloc(100, 7));
    await rec.poll();
    const after = idx.gapsFor("cam-outage");
    eq(after.length, 1, "still one gap");
    eq(Date.parse(after[0].endUtc), resumedSec * 1000, "closed where the new video starts");
    eq(Date.parse(after[0].startUtc), start, "and still starts at the drop");
    eq(events.filter((e) => e.kind === "gap_recorded").length, 1, "one gap_recorded event for the outage");
  } finally {
    await rec.stop();
    idx.close();
  }
});

await check("THE FEARED ONE: a camera still down when the service stops keeps its gap up to the stop", async () => {
  const { spawnFn } = codedSpawn(() => ({ afterMs: 10, code: 146 }));
  const { rec, idx } = await audioRecorder("downatstop", spawnFn);
  let stoppedAt;
  try {
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    stoppedAt = Date.now();
    await rec.stop();
  }
  const gaps = idx.gapsFor("cam-downatstop");
  eq(gaps.length, 1, "one gap");
  eq(Date.parse(gaps[0].endUtc) >= stoppedAt - 50, true, "running up to the stop, not to the last retry");
  idx.close();
});

await check("THE FEARED ONE: restartStuck restarts a hung ffmpeg and records an honest gap", async () => {
  // The run never exits by itself: a stream stuck with no data.
  const { spawnFn, children } = codedSpawn(() => null);
  const { rec, events, idx } = await audioRecorder("stuck", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 50));
    const beforeKill = Date.now();
    // Last sealed well before this run started: the gap starts at the run, not before.
    const ok = await rec.restartStuck({ sinceUtc: new Date(beforeKill - 3_600_000).toISOString() });
    eq(ok, true, "restartStuck reports it acted");
    await new Promise((r) => setTimeout(r, 150));
    eq(children.length, 2, "the stuck run was replaced");
    eq(children[0].signals[0], "SIGTERM", "asked politely first");
    eq(children[1].audio, true, "the restart kept audio");
    const gaps = idx.gapsFor("cam-stuck");
    eq(gaps.length, 1, "one gap recorded");
    eq(gaps[0].reason, "unknown", "reason is unknown, not camera_offline: nobody knows the camera was off");
    const startMs = Date.parse(gaps[0].startUtc);
    eq(startMs >= beforeKill - 1000 && startMs <= beforeKill, true, `gap starts when this run started, not an hour back (${gaps[0].startUtc})`);
    eq(events.some((e) => e.kind === "restarted_stuck" && e.cameraId === "cam-stuck"), true, "restarted_stuck reported");
  } finally {
    await rec.stop();
    idx.close();
  }
});

await check("THE FEARED ONE: repeated stuck restarts never count as audio failures", async () => {
  const { spawnFn, children } = codedSpawn(() => null);
  const { rec, events, idx } = await audioRecorder("stuck2", spawnFn);
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 40));
      await rec.restartStuck({ sinceUtc: null });
    }
    await new Promise((r) => setTimeout(r, 100));
    eq(children.length, 4, "three restarts, four runs");
    eq(children.map((c) => c.audio).every(Boolean), true, `audio on every run: ${JSON.stringify(children.map((c) => c.audio))}`);
    eq(events.some((e) => e.kind === "audio_dropped"), false, "nothing dropped");
  } finally {
    await rec.stop();
    idx.close();
  }
});

await check("an ffmpeg that ignores SIGTERM on a stuck restart is killed, and a stopped recorder refuses", async () => {
  const { spawnFn, children } = codedSpawn(() => null, { ignoreSigterm: true });
  const { rec, idx } = await audioRecorder("deaf", spawnFn);
  try {
    await new Promise((r) => setTimeout(r, 40));
    await rec.restartStuck({ sinceUtc: null });
    await new Promise((r) => setTimeout(r, 100));
    eq(children[0].signals, ["SIGTERM", "SIGKILL"], "escalated to SIGKILL");
    eq(children.length, 2, "and replaced");
  } finally {
    await rec.stop();
    idx.close();
  }
  eq(await rec.restartStuck({ sinceUtc: null }), false, "a stopped recorder does not restart");
});

// Build a 28-byte ftyp box: 4 (size) + 4 (type) + 4 (major) + 4 (minor) + 4 (brand) + 4 (brand)
function makeEmptyFtypBox() {
  const buf = Buffer.alloc(28);
  buf.writeUInt32BE(28, 0);              // size
  buf.write("ftyp", 4);                  // type
  buf.write("isom", 8);                  // major_brand
  buf.writeUInt32BE(0x00000200, 12);     // minor_version
  buf.write("isom", 16);                 // compatible_brand_1
  buf.write("iso2", 20);                 // compatible_brand_2
  return buf;
}

await check("THE FEARED ONE: a 28-byte ftyp stub is quarantined, not sealed as a real segment", async () => {
  const emptyRoot = await mkdtemp(path.join(tmpdir(), "camplat-empty-"));
  const emptyIndex = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-empty-state-")), "index.db"));
  const emptyEvents = [];
  const emptyCam = "cam-empty";
  const emptyRec = createCameraRecorder({
    root: emptyRoot, cameraId: emptyCam, url: "rtsp://u:p@10.0.0.6:554/x",
    index: emptyIndex, segmentSeconds: SEG, pollMs: 100_000, bitrateKbps: 2000,
    spawnFn: fakeSpawn, onEvent: (e) => emptyEvents.push(e),
  });
  await emptyRec.start();
  try {
    // Create files so that the empty ftyp stub is NOT the newest (so it gets sealed/processed)
    await mkdir(path.join(emptyRoot, emptyCam, INPROGRESS), { recursive: true });
    const T_empty = 1_757_500_000;
    const T_normal = 1_757_500_060;
    const T_open = 1_757_500_120;  // This will be the open (newest) file
    await writeFile(path.join(emptyRoot, emptyCam, INPROGRESS, `${T_empty}.mp4`), makeEmptyFtypBox());
    await writeFile(path.join(emptyRoot, emptyCam, INPROGRESS, `${T_normal}.mp4`), Buffer.alloc(SIZE));
    await writeFile(path.join(emptyRoot, emptyCam, INPROGRESS, `${T_open}.mp4`), Buffer.alloc(SIZE));

    await emptyRec.poll();

    // Both the normal and empty files should have been processed
    // The normal one should be sealed, the empty one should be quarantined
    const sealed = emptyIndex.withState("sealed");
    eq(sealed.length, 1, "one sealed segment (the normal one)");
    eq(sealed[0].path, `${emptyCam}/${T_normal * 1000}.mp4`, "the normal segment is sealed");

    // The empty and open files: empty should be quarantined, open should be in index
    const open = emptyIndex.withState("open");
    eq(open.length, 1, "one open (the newest)");
    eq(open[0].path, `${emptyCam}/${INPROGRESS}/${T_open}.mp4`, "the open file is the newest");

    // Check quarantine: the empty stub should be quarantined
    const quarantined = await readdir(path.join(emptyRoot, QUARANTINE)).catch(() => []);
    eq(quarantined.length, 1, "one file quarantined (the empty ftyp)");

    // Check the event: should have empty_segment event
    const emptyEvents_found = emptyEvents.filter((e) => e.kind === "empty_segment");
    eq(emptyEvents_found.length > 0, true, "empty_segment event emitted");
    if (emptyEvents_found.length > 0) {
      eq(emptyEvents_found[0].cameraId, emptyCam, "event names the camera");
    }
  } finally {
    await emptyRec.stop();
    emptyIndex.close();
    await removeStore(emptyRoot);
  }
});

await check("a file 0–7 bytes is also treated as empty and quarantined", async () => {
  const tinyRoot = await mkdtemp(path.join(tmpdir(), "camplat-tiny-"));
  const tinyIndex = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-tiny-state-")), "index.db"));
  const tinyCam = "cam-tiny";
  const tinyRec = createCameraRecorder({
    root: tinyRoot, cameraId: tinyCam, url: "rtsp://u:p@10.0.0.6:554/x",
    index: tinyIndex, segmentSeconds: SEG, pollMs: 100_000, bitrateKbps: 2000,
    spawnFn: fakeSpawn,
  });
  await tinyRec.start();
  try {
    await mkdir(path.join(tinyRoot, tinyCam, INPROGRESS), { recursive: true });
    const T_small = 1_757_500_000;
    const T_normal = 1_757_500_060;
    const T_open = 1_757_500_120;
    await writeFile(path.join(tinyRoot, tinyCam, INPROGRESS, `${T_small}.mp4`), Buffer.alloc(5)); // 5 bytes, too small
    await writeFile(path.join(tinyRoot, tinyCam, INPROGRESS, `${T_normal}.mp4`), Buffer.alloc(SIZE));
    await writeFile(path.join(tinyRoot, tinyCam, INPROGRESS, `${T_open}.mp4`), Buffer.alloc(SIZE));

    await tinyRec.poll();

    // The normal segment should be sealed
    const sealed = tinyIndex.withState("sealed");
    eq(sealed.length, 1, "one sealed segment");

    // The tiny segment should be quarantined
    const quarantined = await readdir(path.join(tinyRoot, QUARANTINE)).catch(() => []);
    eq(quarantined.length, 1, "tiny file quarantined");
  } finally {
    await tinyRec.stop();
    tinyIndex.close();
    await removeStore(tinyRoot);
  }
});

await check("a small file WITH video boxes (mdat, moof, moov) is sealed normally", async () => {
  const smallRoot = await mkdtemp(path.join(tmpdir(), "camplat-small-video-"));
  const smallIndex = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-small-state-")), "index.db"));
  const smallCam = "cam-small";
  const smallRec = createCameraRecorder({
    root: smallRoot, cameraId: smallCam, url: "rtsp://u:p@10.0.0.6:554/x",
    index: smallIndex, segmentSeconds: SEG, pollMs: 100_000, bitrateKbps: 2000,
    spawnFn: fakeSpawn,
  });
  await smallRec.start();
  try {
    await mkdir(path.join(smallRoot, smallCam, INPROGRESS), { recursive: true });
    const T_small = 1_757_500_000;
    const T_normal = 1_757_500_060;
    const T_open = 1_757_500_120;

    // Create a minimal mdat box (no video content, just the box header + minimal data)
    const mdatBuf = Buffer.alloc(200);
    mdatBuf.writeUInt32BE(200, 0);        // size = 200
    mdatBuf.write("mdat", 4);             // type
    // fill with some dummy data
    await writeFile(path.join(smallRoot, smallCam, INPROGRESS, `${T_small}.mp4`), mdatBuf);

    await writeFile(path.join(smallRoot, smallCam, INPROGRESS, `${T_normal}.mp4`), Buffer.alloc(SIZE));
    await writeFile(path.join(smallRoot, smallCam, INPROGRESS, `${T_open}.mp4`), Buffer.alloc(SIZE));

    await smallRec.poll();

    // Both the normal and the small mdat segments should be sealed, not quarantined
    const sealed = smallIndex.withState("sealed");
    eq(sealed.length, 2, "two sealed segments (normal and small with mdat)");

    const quarantined = await readdir(path.join(smallRoot, QUARANTINE)).catch(() => []);
    eq(quarantined.length, 0, "nothing quarantined");
  } finally {
    await smallRec.stop();
    smallIndex.close();
    await removeStore(smallRoot);
  }
});

report("recorder integration");
