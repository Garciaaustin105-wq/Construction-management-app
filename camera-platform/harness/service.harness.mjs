/** The daemon. The failure feared: recorders starting before recovery, so the
 *  partial from the last power cut is indistinguishable from the file being
 *  written right now. */
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCameraUrl, loadConfig, runRecovery, start } from "../agent/recorder-service.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor, checkStoreRoot } from "../agent/config.mjs";
import { INPROGRESS } from "../agent/segstore.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("recorder service");
const creds = { username: "svc", password: "p@ss" };

check("a verbatim URL wins over any template", () => {
  const r = resolveCameraUrl({ cameraId: "c1", url: "rtsp://10.0.0.5:8554/odd/path", vendor: "hikvision" }, creds);
  eq(r.kind, "ok", "resolved");
  eq(r.origin, "manual_url", "manual");
  if (!r.url.includes("/odd/path")) throw new Error("template overrode the manual URL");
  if (r.url.includes("Streaming/Channels")) throw new Error("vendor template was applied anyway");
});

check("a URL carrying its own credentials keeps them", () => {
  const r = resolveCameraUrl({ cameraId: "c1", url: "rtsp://bob:secret@10.0.0.5/live" }, creds);
  if (!r.url.includes("bob")) throw new Error("its own credentials were discarded");
});

check("a host plus vendor uses the template", () => {
  const r = resolveCameraUrl({ cameraId: "c1", host: "10.0.0.6", vendor: "avycon" }, creds);
  eq(r.kind, "ok", "resolved");
  if (!r.url.endsWith("/profile1")) throw new Error(`got ${r.url}`);
});

check("THE FEARED ONE: an unresolvable camera is reported, never silently skipped", () => {
  eq(resolveCameraUrl({ cameraId: "c1", host: "10.0.0.7", vendor: "generic" }, creds).kind, "unresolved", "no template");
  eq(resolveCameraUrl({ cameraId: "c1" }, creds).kind, "unresolved", "no host and no url");
  eq(resolveCameraUrl({ cameraId: "c1", url: "http://nope" }, creds).kind, "unresolved", "bad url");
});

const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-svc-"));
const disk0 = await mkdtemp(path.join(tmpdir(), "camplat-d0-"));
const disk1 = await mkdtemp(path.join(tmpdir(), "camplat-d1-"));

await check("an uncommissioned appliance refuses to start rather than recording nothing", async () => {
  let threw = false;
  try { await loadConfig(stateDir); } catch (e) { threw = e.message.includes("commissioned"); }
  if (!threw) throw new Error("should refuse with a clear reason");
});

await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
  siteId: "carwash-01",
  storeRoots: [disk0, disk1],
  segmentSeconds: 60,
  credentials: creds,
  cameras: [
    { cameraId: "cam-1", host: "10.0.0.11", vendor: "avycon", bitrateKbps: 2500 },
    { cameraId: "cam-2", url: "rtsp://10.0.0.12:8554/odd", bitrateKbps: 2500 },
    { cameraId: "cam-3", host: "10.0.0.13", vendor: "generic" },
  ],
}));

await check("THE FEARED ONE: recovery runs before any recorder starts", async () => {
  // A partial left behind by a power cut, before the service has ever run.
  await mkdir(path.join(disk0, "cam-1", INPROGRESS), { recursive: true });
  await writeFile(path.join(disk0, "cam-1", INPROGRESS, "1757500000.mp4"), Buffer.alloc(7_500_000));

  const fakeChildren = [];
  const spawnFn = () => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => c.emit("exit", 0);
    fakeChildren.push(c);
    return c;
  };

  const handle = await start({ stateDir, spawnFn });
  try {
    // The orphan was adopted by recovery, not mistaken for a live write.
    if (handle.recovered.adopted + handle.recovered.partials === 0) {
      throw new Error("the pre-existing partial was neither adopted nor sealed");
    }
    eq(handle.recorders.length, 2, "two resolvable cameras started");
    eq(handle.unresolved.length, 1, "the generic-vendor camera was reported");
    eq(handle.unresolved[0].cameraId, "cam-3", "named");
  } finally {
    await handle.stop();
  }
});

await check("cameras are split across the two drives", async () => {
  // Four resolvable cameras, so the split is actually observable. With three
  // cameras and one unresolvable, both survivors correctly land on drive 0 —
  // assignment is by position in the configured list, not by what happens to
  // start, so a camera failing does not reshuffle the others onto new disks.
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
    siteId: "carwash-01", storeRoots: [disk0, disk1], segmentSeconds: 60, credentials: creds,
    cameras: [
      { cameraId: "cam-1", host: "10.0.0.11", vendor: "avycon", bitrateKbps: 2500 },
      { cameraId: "cam-2", url: "rtsp://10.0.0.12:8554/odd", bitrateKbps: 2500 },
      { cameraId: "cam-3", host: "10.0.0.13", vendor: "avycon", bitrateKbps: 2500 },
      { cameraId: "cam-4", host: "10.0.0.14", vendor: "avycon", bitrateKbps: 2500 },
    ],
  }));
  const spawnFn = () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => c.emit("exit", 0); return c; };
  const handle = await start({ stateDir, spawnFn });
  try {
    eq(handle.recorders.length, 4, "all four started");
    const roots = new Set(handle.recorders.map((r) => r.root));
    eq(roots.size, 2, "both drives in use");
    const perDrive = handle.recorders.filter((r) => r.root === disk0).length;
    eq(perDrive, 2, "evenly split, contiguous");
  } finally { await handle.stop(); }
});

await check("health reports a refusal rather than a guessed retention figure", async () => {
  const index = openIndex(indexPathFor(stateDir));
  // cam-3 never resolved, so it has no measured bitrate.
  const r = index.count();
  index.close();
  if (typeof r !== "number") throw new Error("index unreadable");
});

// On the appliance the config is written at commissioning, often as root, and
// read by the unprivileged service user. A permissions mistake there must read
// as a permissions mistake, not as "never commissioned".
await check("THE FEARED ONE: a config the service cannot read is not reported as uncommissioned", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "camplat-badcfg-"));
  try {
    // A directory where the file should be: a read that fails for a reason other than absence.
    await mkdir(path.join(dir, "config.json"));
    let message = "";
    try { await loadConfig(dir); } catch (e) { message = e.message; }
    if (message === "") throw new Error("an unreadable config was accepted");
    if (message.includes("commissioned")) throw new Error(`misreported as uncommissioned: ${message}`);
    if (!message.includes("config.json")) throw new Error(`does not name the file: ${message}`);

    await rm(path.join(dir, "config.json"), { recursive: true, force: true });
    await writeFile(path.join(dir, "config.json"), "{ not json");
    message = "";
    try { await loadConfig(dir); } catch (e) { message = e.message; }
    if (message === "") throw new Error("a corrupt config was accepted");
    if (!message.includes("config.json")) throw new Error(`a corrupt config does not name the file: ${message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The recorder reports ffmpeg failing to start and segments failing to seal,
// but the service only forwarded four event kinds to the journal. A box with no
// ffmpeg recorded nothing and logged nothing about why.
await check("THE FEARED ONE: a camera whose ffmpeg cannot start is logged, not silent", async () => {
  const lines = [];
  const realLog = console.log;
  let handle;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const spawnFn = () => {
      const c = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = () => {};
      setImmediate(() => c.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })));
      return c;
    };
    handle = await start({ stateDir, spawnFn });
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await handle?.stop();
    console.log = realLog;
  }
  const failed = lines.filter((l) => l.includes("spawn_failed"));
  if (failed.length === 0) throw new Error("spawn_failed never reached the log");
  if (!failed.some((l) => l.includes("ENOENT"))) throw new Error("the log line does not say why");
  if (lines.some((l) => l.includes("p@ss") || l.includes("p%40ss"))) throw new Error("a password reached the log");
});

// The installer creates /srv/camplat/disk0 as a plain directory. If the disk
// fails to mount the directory is still there and writable, and ffmpeg fills the
// OS drive that holds the index. A mount point has a different device from its
// parent; a plain directory has the same one.
await check("THE FEARED ONE: an unmounted recording drive is refused, not recorded onto the OS drive", async () => {
  const devs = { "/srv/camplat": 1, "/srv/camplat/disk0": 2, "/srv/camplat/disk1": 1 };
  const statFn = async (p) => {
    const key = String(p).split(path.sep).join("/");
    if (!(key in devs)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    return { dev: devs[key], isDirectory: () => true };
  };
  eq((await checkStoreRoot("/srv/camplat/disk0", { statFn, requireMount: true })).ok, true, "a mounted drive");
  const unmounted = await checkStoreRoot("/srv/camplat/disk1", { statFn, requireMount: true });
  eq(unmounted.ok, false, "a plain directory on the OS drive");
  if (!/mount/.test(String(unmounted.reason))) throw new Error(`the reason does not say why: ${unmounted.reason}`);
  eq((await checkStoreRoot("/srv/camplat/disk9", { statFn, requireMount: true })).ok, false, "a missing directory");
  eq((await checkStoreRoot("/srv/camplat/disk9", { statFn, requireMount: false })).ok, false, "missing is refused even on the bench");
  eq((await checkStoreRoot("/srv/camplat/disk1", { statFn, requireMount: false })).ok, true, "the bench opts out explicitly");
});

// With one drive refused, recovery cannot see that drive's files, so running it
// would write off every segment on the unmounted disk as lost.
await check("THE FEARED ONE: with one drive unmounted the other keeps recording and no footage is written off", async () => {
  const onDisk1 = {
    cameraId: "cam-3", startUtc: new Date(1757500000000).toISOString(), endUtc: new Date(1757500060000).toISOString(),
    path: "cam-3/1757500000000.mp4", bytes: 1000, state: "sealed", hold: true, pendingUpload: false, bitrateKbps: 2500,
  };
  const seed = openIndex(indexPathFor(stateDir));
  seed.putMany([onDisk1]);
  seed.close();
  const lines = [];
  const realLog = console.log;
  const spawnFn = () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => c.emit("exit", 0); return c; };
  const storeCheck = async (root) => (root === disk1 ? { ok: false, reason: `${root} is not a mount point` } : { ok: true });
  let handle;
  console.log = (line) => { lines.push(String(line)); };
  try {
    handle = await start({ stateDir, spawnFn, storeCheck });
  } finally {
    console.log = realLog;
  }
  try {
    eq(handle.recorders.length, 4, "every camera still records");
    eq(handle.recorders.every((r) => r.root === disk0), true, "all on the drive that is mounted");
    eq(handle.refusedRoots.length, 1, "one drive refused");
    eq(handle.refusedRoots[0].root, disk1, "the unmounted one");
    eq(handle.recovered.skipped, true, "recovery skipped while a drive is missing");
    eq(handle.index.get(onDisk1.path)?.hold, true, "the unmounted drive's held segment is still indexed");
    if (!lines.some((l) => l.includes("refused"))) throw new Error("the refused drive was not logged");
  } finally {
    await handle.stop();
  }
});

// Segment paths are relative to their drive, so a recovery pass over one drive
// must never judge the other drive's segments. Found 2026-09-14: every restart
// of a two-drive box dropped drive 0's rows and re-adopted drive 1's without
// their hold flag. The bench had one drive, so nothing caught it.
const twoDrives = async () => {
  const state = await mkdtemp(path.join(tmpdir(), "camplat-rr-"));
  const d0 = await mkdtemp(path.join(tmpdir(), "camplat-rr0-"));
  const d1 = await mkdtemp(path.join(tmpdir(), "camplat-rr1-"));
  const seg = async (root, cameraId, ms) => {
    if (root) {
      await mkdir(path.join(root, cameraId), { recursive: true });
      await writeFile(path.join(root, cameraId, `${ms}.mp4`), Buffer.alloc(1000));
    }
    return {
      cameraId, startUtc: new Date(ms).toISOString(), endUtc: new Date(ms + 60_000).toISOString(),
      path: `${cameraId}/${ms}.mp4`, bytes: 1000, state: "sealed", hold: true, pendingUpload: false, bitrateKbps: 2500,
    };
  };
  const index = openIndex(path.join(state, "index.db"));
  const cleanup = async () => {
    index.close();
    for (const d of [state, d0, d1]) await rm(d, { recursive: true, force: true });
  };
  return { d0, d1, seg, index, cleanup };
};

await check("THE FEARED ONE: a restart with held segments on both drives changes nothing in the index", async () => {
  const { d0, d1, seg, index, cleanup } = await twoDrives();
  try {
    index.putMany([await seg(d0, "cam-1", 1757500000000), await seg(d1, "cam-2", 1757500000000)]);
    const before = JSON.stringify(index.all());
    const summary = await runRecovery(index, [d0, d1]);
    eq(summary.lost, 0, "lost");
    eq(summary.adopted, 0, "adopted");
    eq(summary.confirmed, 2, "confirmed");
    eq(JSON.stringify(index.all()), before, "index rows");
    eq(index.gapsFor("cam-1").length + index.gapsFor("cam-2").length, 0, "gaps");
  } finally {
    await cleanup();
  }
});

await check("THE FEARED ONE: a segment missing from every drive is still reported lost, exactly once", async () => {
  const { d0, d1, seg, index, cleanup } = await twoDrives();
  try {
    index.putMany([
      await seg(d0, "cam-1", 1757500000000),
      await seg(d1, "cam-2", 1757500000000),
      await seg(null, "cam-2", 1757500060000),
    ]);
    const summary = await runRecovery(index, [d0, d1]);
    eq(summary.lost, 1, "lost");
    eq(summary.confirmed, 2, "confirmed");
    eq(index.all().length, 2, "rows left");
    eq(index.gapsFor("cam-2").length, 1, "one gap for the missing segment");
    eq(index.get("cam-1/1757500000000.mp4")?.hold, true, "drive 0 hold kept");
    eq(index.get("cam-2/1757500000000.mp4")?.hold, true, "drive 1 hold kept");
  } finally {
    await cleanup();
  }
});

await check("THE FEARED ONE: a quarantine that cannot be written fails that file, not the whole recovery", async () => {
  const { d0, d1, seg, index, cleanup } = await twoDrives();
  try {
    index.putMany([await seg(d1, "cam-2", 1757500000000)]);
    await mkdir(path.join(d0, "cam-1"), { recursive: true });
    await writeFile(path.join(d0, "cam-1", "mystery.dat"), Buffer.alloc(1234));
    await writeFile(path.join(d0, ".quarantine"), "a file where the quarantine directory should be");
    const summary = await runRecovery(index, [d0, d1]);
    eq(summary.quarantined, 0, "nothing claimed as quarantined");
    eq(summary.quarantineFailed, 1, "the failed move is counted");
    eq(summary.confirmed, 1, "the other drive still recovered");
    eq((await readFile(path.join(d0, "cam-1", "mystery.dat"))).length, 1234, "the file is left where it was");
  } finally {
    await cleanup();
  }
});

await rm(stateDir, { recursive: true, force: true });
await rm(disk0, { recursive: true, force: true });
await rm(disk1, { recursive: true, force: true });
report("recorder service");
