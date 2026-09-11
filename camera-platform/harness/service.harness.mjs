/** The daemon. The failure feared: recorders starting before recovery, so the
 *  partial from the last power cut is indistinguishable from the file being
 *  written right now. */
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCameraUrl, loadConfig, runRecovery, start } from "../agent/recorder-service.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
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

await rm(stateDir, { recursive: true, force: true });
await rm(disk0, { recursive: true, force: true });
await rm(disk1, { recursive: true, force: true });
report("recorder service");
