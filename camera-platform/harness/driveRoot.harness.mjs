/**
 * Each segment records the drive (store root) its file is on.
 *
 * Which drive a camera writes to is positional (assignCamerasToDrives), so it
 * moves when the camera list changes or a drive is refused. Deriving a file's
 * drive from the camera's assignment *now* went wrong both ways:
 *
 * Feared: eviction for a full drive deletes "the oldest" rows from the other
 * drive, gets ENOENT, drops them from the index anyway, and never frees the
 * full drive; playback and export look on the wrong drive after a reorder.
 */
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openIndex } from "../agent/segindex.mjs";
import { planEvictionScalable } from "../agent/evict.mjs";
import { applyEviction } from "../agent/segstore.mjs";
import { createApiServer } from "../agent/api-server.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("drive root");

const tmp = await mkdtemp(join(tmpdir(), "camplat-root-"));
const d0 = join(tmp, "disk0");
const d1 = join(tmp, "disk1");
const exists = (p) => stat(p).then(() => true, () => false);
const T0 = Date.parse("2026-09-11T10:00:00Z");
const seg = (cameraId, i, root, extra = {}) => ({
  cameraId,
  startUtc: new Date(T0 + i * 60_000).toISOString(),
  endUtc: new Date(T0 + (i + 1) * 60_000).toISOString(),
  path: `${cameraId}/${T0 + i * 60_000}.mp4`,
  bytes: 1000, state: "sealed", hold: false, pendingUpload: false, bitrateKbps: null,
  root, ...extra,
});
const writeSeg = async (root, s, body = `seg ${s.path}`) => {
  await mkdir(join(root, s.cameraId), { recursive: true });
  await writeFile(join(root, s.path), body);
};

try {
  await check("an index made before roots were recorded gains the column; its rows read null", () => {
    const file = join(tmp, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE segments (camera_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER,
      path TEXT NOT NULL UNIQUE, bytes INTEGER, state TEXT NOT NULL, hold INTEGER NOT NULL DEFAULT 0,
      pending_upload INTEGER NOT NULL DEFAULT 0, bitrate_kbps INTEGER, PRIMARY KEY (camera_id, start_ms))`);
    old.prepare("INSERT INTO segments VALUES ('cam-1', ?, ?, 'cam-1/a.mp4', 10, 'sealed', 0, 0, NULL)").run(T0, T0 + 60_000);
    old.close();
    const index = openIndex(file);
    try {
      eq(index.get("cam-1/a.mp4").root, null);
      eq(index.oldestEvictable(10).length, 1, "still offered without a root (single-drive callers)");
      eq(index.oldestEvictable(10, d0).length, 0, "FEARED: never offered for a named drive");
      eq(index.assignRoot(d0, ["cam-1/a.mp4", "cam-1/nope.mp4"]), 1);
      eq(index.assignRoot(d0, ["cam-1/a.mp4"]), 0, "already right: nothing changes");
      eq(index.get("cam-1/a.mp4").root, d0);
    } finally {
      index.close();
    }
    const again = openIndex(file);   // opening twice does not re-add the column
    eq(again.get("cam-1/a.mp4").root, d0);
    again.close();
  });

  await check("an update without a root keeps the recorded one", () => {
    const index = openIndex(join(tmp, "keep.db"));
    try {
      index.put(seg("cam-1", 0, d1));
      index.put({ ...seg("cam-1", 0, undefined), hold: true });
      eq([index.get("cam-1/" + T0 + ".mp4").root, index.get("cam-1/" + T0 + ".mp4").hold], [d1, true]);
    } finally {
      index.close();
    }
  });

  await check("FEARED: evicting for a full drive never touches the other drive's footage", async () => {
    const index = openIndex(join(tmp, "evict.db"));
    try {
      // drive 1's rows are the oldest overall; drive 0 is the full one.
      const older = [seg("cam-2", 0, d1), seg("cam-2", 1, d1)];
      const newer = [seg("cam-1", 5, d0), seg("cam-1", 6, d0)];
      const legacy = seg("cam-3", -5, null);
      for (const s of older) await writeSeg(d1, s);
      for (const s of newer) await writeSeg(d0, s);
      index.putMany([...older, ...newer, legacy]);
      const plan = planEvictionScalable(index, 1500, { root: d0 });
      eq(plan.evict.map((c) => c.segment.path), newer.map((s) => s.path));
      const { deleted, bytesFreed } = await applyEviction(d0, plan);
      eq([deleted.length, bytesFreed], [2, 2000]);
      for (const s of older) eq(await exists(join(d1, s.path)), true, "drive 1 file kept");
      for (const s of newer) eq(await exists(join(d0, s.path)), false, "drive 0 file freed");
      eq(planEvictionScalable(index, 1500, { root: d1 }).evict.map((c) => c.segment.path), older.map((s) => s.path));
      eq(planEvictionScalable(index, 500).evict[0].segment.path, legacy.path, "no root: the old behaviour");
    } finally {
      index.close();
    }
  });

  await check("FEARED: playback and export read the drive the segment recorded, after a reorder", async () => {
    const stateDir = join(tmp, "state");
    await mkdir(stateDir, { recursive: true });
    const index = openIndex(join(stateDir, "index.db"));
    // cam-1 -> drive 0, cam-2 -> drive 1 now; cam-2's footage was written to drive 0.
    const config = {
      siteId: "bench", storeRoots: [d0, d1], credentials: null,
      cameras: [{ cameraId: "cam-1", url: "rtsp://10.0.0.5/a" }, { cameraId: "cam-2", url: "rtsp://10.0.0.6/a" }],
    };
    const moved = seg("cam-2", 20, d0, { bytes: 16 });
    const legacy = seg("cam-2", 21, null, { bytes: 17 });          // unknown: where cam-2 is assigned now
    const gone = seg("cam-2", 22, join(tmp, "unplugged"), { bytes: 15 });   // no longer configured: same fallback
    await writeSeg(d0, moved, "MOVED-ON-DRIVE-0");
    await writeSeg(d1, legacy, "LEGACY-ON-DRIVE-1");
    await writeSeg(d1, gone, "GONE-ON-DRIVE-1");
    index.putMany([moved, legacy, gone]);
    const auth = { principalOf: () => ({ kind: "user", username: "tech", role: "installer" }), handle: async () => false, audit: () => {} };
    const server = createApiServer({ stateDir, config, index, auth, now: () => new Date("2026-09-11T12:00:00Z") });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const [s, body] of [[moved, "MOVED-ON-DRIVE-0"], [legacy, "LEGACY-ON-DRIVE-1"], [gone, "GONE-ON-DRIVE-1"]]) {
        const res = await fetch(`${base}/segments/cam-2.${Date.parse(s.startUtc)}`);
        eq([res.status, await res.text()], [200, body], s.path);
      }
      const res = await fetch(`${base}/export?camera=cam-2&start=2026-09-11T10:20:10Z&end=2026-09-11T10:22:50Z`);
      const zip = Buffer.from(await res.arrayBuffer()).toString("latin1");
      eq(res.status, 200);
      for (const marker of ["MOVED-ON-DRIVE-0", "LEGACY-ON-DRIVE-1", "GONE-ON-DRIVE-1"]) {
        eq(zip.includes(marker), true, `export carries ${marker}`);
      }
    } finally {
      await new Promise((r) => server.close(r));
      index.close();
    }
  });
} finally {
  await rm(tmp, { recursive: true, force: true });
}

report("drive root");
