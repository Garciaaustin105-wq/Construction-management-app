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
import { mkdtemp, mkdir, writeFile, rm, stat, unlink as realUnlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openIndex } from "../agent/segindex.mjs";
import { planEvictionScalable } from "../agent/evict.mjs";
import { applyEviction } from "../agent/segstore.mjs";
import { runAgeEviction, runEviction } from "../agent/recorder-service.mjs";
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

  await check("FEARED: a failing unlink in the middle of a plan does not abort the rest, and only deleted rows are dropped", async () => {
    const index = openIndex(join(tmp, "partialFail.db"));
    try {
      const segs = [seg("cam-4", 30, d0), seg("cam-4", 31, d0), seg("cam-4", 32, d0)];
      for (const s of segs) await writeSeg(d0, s);
      index.putMany(segs);
      const plan = { evict: segs.map((s) => ({ segment: s, bytes: s.bytes })) };
      const badPath = join(d0, segs[1].path);
      const unlinkOverride = async (p) => {
        if (p === badPath) { const e = new Error("access denied"); e.code = "EACCES"; throw e; }
        return realUnlink(p);
      };
      const { deleted, failed, bytesFreed } = await applyEviction(d0, plan, { unlink: unlinkOverride });
      eq(deleted, [segs[0].path, segs[2].path], "the good ones deleted; the loop did not abort mid-plan");
      eq(failed, [{ path: segs[1].path, code: "EACCES" }], "the bad one recorded, never thrown");
      eq(bytesFreed, segs[0].bytes + segs[2].bytes, "freed only what was actually deleted");
      eq(await exists(join(d0, segs[0].path)), false);
      eq(await exists(join(d0, segs[1].path)), true, "the failed file is untouched on disk");
      eq(await exists(join(d0, segs[2].path)), false);
      // The caller's exact pattern (runEviction / runAgeEviction): remove rows
      // only for what was actually deleted.
      index.removeMany(deleted);
      eq(index.get(segs[0].path), null, "deleted row gone");
      eq(index.get(segs[1].path) !== null, true, "FEARED: a row must never be removed before its file is gone (EVENTS-RETENTION-SPEC.md)");
      eq(index.get(segs[2].path), null, "deleted row gone");
    } finally {
      index.close();
    }
  });

  await check("FEARED: runAgeEviction never lets a bad root's failure skip the age pass on the next drive", async () => {
    const DAY = 86_400_000;
    const stateDir = join(tmp, "ageState");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "recording.json"), JSON.stringify({ maxDays: 1 }));
    const realIndex = openIndex(join(tmp, "ageRootFail.db"));
    try {
      const bad = seg("cam-5", 40, d0);
      const good = seg("cam-5", 41, d1);
      await writeSeg(d0, bad);
      await writeSeg(d1, good);
      realIndex.putMany([bad, good]);
      // Stands in for a drive that throws mid-pass (a corrupt read, a locked
      // table...) rather than failing one file at a time.
      const wrapped = {
        ...realIndex,
        olderThan(cutoffMs, root, limit) {
          if (root === d0) throw new Error("simulated: drive 0 unreadable this pass");
          return realIndex.olderThan(cutoffMs, root, limit);
        },
      };
      const logs = [];
      const result = await runAgeEviction(wrapped, [d0, d1], stateDir, {
        now: () => new Date(T0 + 400 * DAY),
        log: (level, msg, extra) => logs.push({ level, msg, extra }),
      });
      eq(result, { segments: 1, bytesFreed: good.bytes }, "only the healthy drive's segment was freed");
      eq(await exists(join(d0, bad.path)), true, "bad drive's file untouched");
      eq(await exists(join(d1, good.path)), false, "good drive's file freed");
      eq(realIndex.get(bad.path) !== null, true, "bad drive's row kept: its file was never touched");
      eq(realIndex.get(good.path), null, "good drive's row removed");
      if (!logs.some((l) => l.level === "error" && l.extra.root === d0)) {
        throw new Error("the failure on drive 0 must be logged, not swallowed silently");
      }
    } finally {
      realIndex.close();
    }
  });

  await check("FEARED: runAgeEviction's paging loop does not spin forever when a whole page fails", async () => {
    const DAY = 86_400_000;
    const stateDir = join(tmp, "ageStuck");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "recording.json"), JSON.stringify({ maxDays: 1 }));
    const index = openIndex(join(tmp, "ageStuck.db"));
    try {
      const segs = [seg("cam-7", 60, d0), seg("cam-7", 61, d0), seg("cam-7", 62, d0)];
      for (const s of segs) await writeSeg(d0, s);
      index.putMany(segs);
      let unlinkCalls = 0;
      const alwaysFails = async () => { unlinkCalls++; const e = new Error("stuck"); e.code = "EBUSY"; throw e; };
      const result = await runAgeEviction(index, [d0], stateDir, {
        now: () => new Date(T0 + 400 * DAY),
        log: () => {},
        pageSize: 2,
        unlink: alwaysFails,
      });
      eq(result, { segments: 0, bytesFreed: 0 }, "nothing could be deleted");
      eq(unlinkCalls, 2, "stopped after the one failed page — never re-reads it forever");
      for (const s of segs) {
        eq(await exists(join(d0, s.path)), true, `${s.path} still on disk`);
        eq(index.get(s.path) !== null, true, `${s.path} row kept for the next pass`);
      }
    } finally {
      index.close();
    }
  });

  await check("FEARED: runEviction never lets a bad root's failure skip eviction on the next drive", async () => {
    const realIndex = openIndex(join(tmp, "evictRootFail.db"));
    try {
      const bad = seg("cam-6", 50, d0);
      const good = seg("cam-6", 51, d1);
      await writeSeg(d0, bad);
      await writeSeg(d1, good);
      realIndex.putMany([bad, good]);
      const wrapped = {
        ...realIndex,
        oldestEvictable(limit, root) {
          if (root === d0) throw new Error("simulated: drive 0 index read failed");
          return realIndex.oldestEvictable(limit, root);
        },
      };
      const logs = [];
      const fakeDiskUsage = async () => ({ total: 1_000_000, used: 999_000 });   // both roots read as 99.9% full
      await runEviction(wrapped, [d0, d1], (level, msg, extra) => logs.push({ level, msg, extra }), { diskUsage: fakeDiskUsage });
      eq(await exists(join(d0, bad.path)), true, "bad drive's file untouched");
      eq(await exists(join(d1, good.path)), false, "good drive's file freed");
      eq(realIndex.get(bad.path) !== null, true, "bad drive's row kept");
      eq(realIndex.get(good.path), null, "good drive's row removed");
      if (!logs.some((l) => l.level === "error" && l.extra.root === d0)) {
        throw new Error("the failure on drive 0 must be logged, not swallowed silently");
      }
    } finally {
      realIndex.close();
    }
  });

  await check("runEviction's log line reports failed counts and codes, not just what succeeded", async () => {
    const index = openIndex(join(tmp, "evictLog.db"));
    try {
      const a = seg("cam-8", 70, d0);
      const b = seg("cam-8", 71, d0);
      await writeSeg(d0, a);
      await writeSeg(d0, b);
      index.putMany([a, b]);
      const badPath = join(d0, b.path);
      const unlinkOverride = async (p) => {
        if (p === badPath) { const e = new Error("busy"); e.code = "EBUSY"; throw e; }
        return realUnlink(p);
      };
      const logs = [];
      await runEviction(index, [d0], (level, msg, extra) => logs.push({ level, msg, extra }), {
        diskUsage: async () => ({ total: 1_000_000, used: 999_000 }),
        unlink: unlinkOverride,
      });
      const evicted = logs.find((l) => l.msg === "evicted");
      if (!evicted) throw new Error("expected an 'evicted' log line");
      eq([evicted.extra.segments, evicted.extra.failed, evicted.extra.codes], [1, 1, ["EBUSY"]], "counts and codes reported, nothing silent");
      eq(index.get(a.path), null, "the deleted one's row is gone");
      eq(index.get(b.path) !== null, true, "the failed one's row stays for retry");
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
