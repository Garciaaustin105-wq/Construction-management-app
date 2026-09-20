/**
 * The event thumbnail cutter (agent/event-crop.mjs): turning an event id into
 * a JPEG cut from the recording at that event's best moment.
 *
 * THE FEARED FAILURES this suite exists to catch:
 * - serving a crop that answers for the WRONG moment once an event has grown
 *   past the sighting it was first cut for;
 * - reading a segment the recorder is still writing;
 * - a Review page open on a busy day spawning one ffmpeg per tile with no
 *   ceiling;
 * - an ffmpeg that fails partway being served as if it were a real thumbnail.
 *
 * ffprobe and ffmpeg are always a fake `spawnFn` here — never the real
 * binaries — so these checks run anywhere Node runs.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createEventCrops } from "../agent/event-crop.mjs";
import { openEventsDb } from "../agent/events-db.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("event crop");

// ---------- fakes ----------

const GOOD_PROBE_JSON = {
  streams: [{ codec_type: "video", codec_name: "h264", width: 2560, height: 1440 }],
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 999_999; // never a real pid: os.setPriority on it must fail silently
  return child;
}

/**
 * A fake spawnFn. ffprobe answers `probeJson` (or exits 1 if null). ffmpeg
 * exits `ffmpegExit` (or the result of calling it with the args) after
 * `delayMs`, writing a fake JPEG to its output path first UNLESS it is
 * failing — a real failed ffmpeg leaves nothing usable behind either.
 * `calls` (if given) collects every { cmd, args } invocation.
 */
function makeSpawnFn({ probeJson = GOOD_PROBE_JSON, ffmpegExit = 0, delayMs = 0, calls, onRunningChange } = {}) {
  let running = 0;
  return function spawnFn(cmd, args) {
    calls?.push({ cmd, args });
    const child = fakeChild();
    if (cmd === "ffprobe") {
      queueMicrotask(() => {
        if (probeJson === null) {
          child.emit("close", 1);
        } else {
          child.stdout.emit("data", Buffer.from(JSON.stringify(probeJson)));
          child.emit("close", 0);
        }
      });
    } else if (cmd === "ffmpeg") {
      running += 1;
      onRunningChange?.(running);
      const outPath = args[args.length - 1];
      const finish = async () => {
        const code = typeof ffmpegExit === "function" ? ffmpegExit(args) : ffmpegExit;
        if (code === 0) {
          try { await writeFile(outPath, "fake-jpeg-bytes"); } catch { /* directory races are not this test's concern */ }
        }
        running -= 1;
        onRunningChange?.(running);
        child.emit("close", code);
      };
      if (delayMs > 0) setTimeout(finish, delayMs);
      else queueMicrotask(finish);
    } else {
      queueMicrotask(() => child.emit("close", 1));
    }
    return child;
  };
}

function makeEventsDb(initial) {
  const rows = new Map(initial.map((e) => [e.id, e]));
  return {
    getById: (id) => rows.get(id) ?? null,
    set: (id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
  };
}

function sealedSegment(cameraId, startMs, durationMs, filePath, root) {
  return {
    cameraId,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + durationMs).toISOString(),
    path: filePath,
    bytes: 5_000_000,
    state: "sealed",
    bitrateKbps: 2048,
    root,
  };
}

function openSegment(cameraId, startMs, filePath, root) {
  return {
    cameraId,
    startUtc: new Date(startMs).toISOString(),
    endUtc: null,
    path: filePath,
    bytes: null,
    state: "open",
    bitrateKbps: null,
    root,
  };
}

/** `segments`/`gaps` as full rows (with `root`); `forCamera`/`gapsFor` hand
 *  resolvePlayback its IndexedSegment/IndexedGap view of the same rows, and
 *  `getByKey` hands agent/event-crop.mjs the `root` that view leaves out —
 *  the same split real segindex.mjs makes. */
function makeIndex({ segments = [], gaps = [] } = {}) {
  return {
    forCamera: (cameraId) => segments.filter((s) => s.cameraId === cameraId),
    gapsFor: (cameraId) => gaps.filter((g) => g.cameraId === cameraId),
    getByKey: (cameraId, startMs) =>
      segments.find((s) => s.cameraId === cameraId && Date.parse(s.startUtc) === startMs) ?? null,
  };
}

function ev(id, cameraId, bestUtc, bestBox = { x: 0.4, y: 0.4, w: 0.1, h: 0.2 }) {
  return {
    id,
    cameraId,
    kind: "person",
    firstUtc: bestUtc,
    lastUtc: bestUtc,
    count: 1,
    bestConfidence: 0.9,
    bestBox,
    bestUtc,
    finished: true,
  };
}

const CONFIG = { storeRoots: ["/srv/camplat/disk0", "/srv/camplat/disk1"] };
function driveMap(entries) { return new Map(entries); }

let tmpDirs = [];
async function makeStateDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "eventcrop-"));
  tmpDirs.push(dir);
  return dir;
}
async function cleanupTmpDirs() {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  tmpDirs = [];
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ---------- checks ----------

check("events-db gained getById, and an unknown id is null rather than a crash", () => {
  const db = openEventsDb(":memory:");
  db.upsert({ id: "e1", event: ev("e1", "cam1", "2026-09-20T10:00:00.000Z") }, true);
  eq(db.getById("e1")?.id, "e1", "found");
  eq(db.getById("e1")?.bestBox, { x: 0.4, y: 0.4, w: 0.1, h: 0.2 }, "the box round-trips");
  eq(db.getById("does-not-exist"), null, "unknown id");
  db.close();
});

await check("THE FEARED ONE: an unknown event id is refused, never guessed at", async () => {
  const calls = [];
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([]),
    index: makeIndex(),
    config: CONFIG,
    driveAssignment: driveMap([]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ calls }),
  });
  const r = await cutter.get("nope");
  eq(r, { ok: false, status: 404, code: "no_such_event", message: "no event with that id" }, "404 no_such_event");
  eq(calls.length, 0, "nothing was spawned for an id that does not exist");
});

await check("THE FEARED ONE: a moment whose footage is gone is refused, not silently skipped", async () => {
  const calls = [];
  const bestUtc = "2026-09-20T08:00:00.000Z"; // no segment anywhere near this
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([ev("e1", "cam1", bestUtc)]),
    index: makeIndex({ segments: [] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ calls }),
  });
  const r = await cutter.get("e1");
  eq(r.ok, false, "refused");
  eq(r.status, 409, "409");
  eq(r.code, "footage_gone", "footage_gone");
  eq(calls.length, 0, "no ffmpeg for footage that is not there");
});

await check("THE FEARED ONE: a still-open segment is refused rather than read while being written", async () => {
  const calls = [];
  const startMs = Date.parse("2026-09-20T11:55:00.000Z");
  const bestUtc = "2026-09-20T11:58:00.000Z"; // inside the still-open segment
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([ev("e1", "cam1", bestUtc)]),
    index: makeIndex({ segments: [openSegment("cam1", startMs, "cam1/open.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ calls }),
  });
  const r = await cutter.get("e1");
  eq(r.ok, false, "refused");
  eq(r.status, 409, "409");
  eq(r.code, "segment_open", "segment_open");
  eq(calls.length, 0, "never opened the file being written");
});

await check("a sealed segment produces a crop file, and a cache hit does not spawn a second time", async () => {
  const calls = [];
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const bestUtc = "2026-09-20T09:05:00.000Z";
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([ev("e1", "cam1", bestUtc)]),
    index: makeIndex({
      segments: [sealedSegment("cam1", startMs, 600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")],
    }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ calls }),
  });

  const first = await cutter.get("e1");
  eq(first.ok, true, `cut succeeded: ${JSON.stringify(first)}`);
  eq(await fileExists(first.file), true, "the file is really there");
  const ffmpegCallsAfterFirst = calls.filter((c) => c.cmd === "ffmpeg").length;
  eq(ffmpegCallsAfterFirst, 1, "one ffmpeg for the cut");

  const second = await cutter.get("e1");
  eq(second, first, "THE FEARED ONE: the cache hit answers the same file");
  eq(calls.filter((c) => c.cmd === "ffmpeg").length, ffmpegCallsAfterFirst, "and spawns nothing new");
});

await check("THE FEARED ONE: an event whose bestUtc changed gets a fresh crop, and the old file is removed", async () => {
  const calls = [];
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const db = makeEventsDb([ev("e1", "cam1", "2026-09-20T09:01:00.000Z")]);
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: db,
    index: makeIndex({
      // one long segment so both the old and the new "best" moment fall inside it
      segments: [sealedSegment("cam1", startMs, 3_600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")],
    }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ calls }),
  });

  const before = await cutter.get("e1");
  eq(before.ok, true, "first cut ok");
  eq(await fileExists(before.file), true, "old crop exists");

  // the event grew: a later, better sighting moved bestUtc and bestBox on
  db.set("e1", { bestUtc: "2026-09-20T09:45:00.000Z", bestBox: { x: 0.1, y: 0.1, w: 0.05, h: 0.1 } });

  const after = await cutter.get("e1");
  eq(after.ok, true, "second cut ok");
  eq(after.file === before.file, false, "a different moment gets a different cache file");
  eq(await fileExists(after.file), true, "new crop exists");
  eq(await fileExists(before.file), false, "the STALE crop was removed, so it can never answer for the new moment");
  eq(calls.filter((c) => c.cmd === "ffmpeg").length, 2, "the change forced a real re-cut, not a cache hit");
});

await check("THE FEARED ONE: no more than maxConcurrent ffmpegs run at once, whatever the burst", async () => {
  let maxRunning = 0;
  const spawnFn = makeSpawnFn({ delayMs: 30, onRunningChange: (n) => { maxRunning = Math.max(maxRunning, n); } });
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const ids = ["a", "b", "c", "d", "e"];
  const db = makeEventsDb(ids.map((id) => ev(id, "cam1", "2026-09-20T09:05:00.000Z")));
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: db,
    index: makeIndex({ segments: [sealedSegment("cam1", startMs, 600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn,
    maxConcurrent: 2,
  });

  const results = await Promise.all(ids.map((id) => cutter.get(id)));
  eq(results.every((r) => r.ok === true), true, `every request eventually succeeds: ${JSON.stringify(results)}`);
  eq(maxRunning <= 2, true, `never more than maxConcurrent running at once, saw ${maxRunning}`);
  eq(maxRunning, 2, "and it did reach the cap rather than accidentally serialising to 1");
});

await check("THE FEARED ONE: past the queue limit, a request is refused busy rather than queued without bound", async () => {
  const calls = [];
  const spawnFn = makeSpawnFn({ calls, delayMs: 20 });
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const TOTAL = 37; // maxConcurrent(2) + MAX_QUEUE(32) + 3 that must be refused
  const ids = Array.from({ length: TOTAL }, (_, i) => `ev${i}`);
  const db = makeEventsDb(ids.map((id) => ev(id, "cam1", "2026-09-20T09:05:00.000Z")));
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: db,
    index: makeIndex({ segments: [sealedSegment("cam1", startMs, 600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn,
    maxConcurrent: 2,
  });

  const results = await Promise.all(ids.map((id) => cutter.get(id)));
  const busy = results.filter((r) => r.ok === false && r.code === "busy");
  const ok = results.filter((r) => r.ok === true);
  eq(busy.length, 3, `exactly the overflow was refused: ${busy.length} of ${TOTAL}`);
  eq(ok.length, 34, "everyone else, running or queued, still got their thumbnail");
  for (const r of busy) eq(r.status, 503, "503");
});

await check("THE FEARED ONE: an ffmpeg that exits non-zero is a refusal, never a zero-byte crop", async () => {
  const calls = [];
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([ev("e1", "cam1", "2026-09-20T09:05:00.000Z")]),
    index: makeIndex({ segments: [sealedSegment("cam1", startMs, 600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ calls, ffmpegExit: 1 }),
  });
  const r = await cutter.get("e1");
  eq(r.ok, false, "refused");
  eq(r.status, 500, "500");
  eq(r.code, "crop_failed", "crop_failed");
  eq(calls.some((c) => c.cmd === "ffmpeg"), true, "ffmpeg really was tried");
});

await check("an ffprobe that cannot read the frame is refused rather than assuming a resolution", async () => {
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([ev("e1", "cam1", "2026-09-20T09:05:00.000Z")]),
    index: makeIndex({ segments: [sealedSegment("cam1", startMs, 600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ probeJson: null }),
  });
  const r = await cutter.get("e1");
  eq(r.ok, false, "refused");
  eq(r.status, 500, "500");
  eq(r.code, "crop_failed", "crop_failed, not a guessed 2560x1440 frame");
});

await check("a box cropPlan refuses is a crop_failed, carrying the reason", async () => {
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([
      ev("e1", "cam1", "2026-09-20T09:05:00.000Z", { x: 0.1, y: 0.1, w: 0 /* no extent: bad_box */, h: 0.1 }),
    ]),
    index: makeIndex({ segments: [sealedSegment("cam1", startMs, 600_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn(),
  });
  const r = await cutter.get("e1");
  eq(r.ok, false, "refused");
  eq(r.status, 500, "500");
  eq(r.code, "crop_failed", "crop_failed");
  eq(typeof r.message === "string" && r.message.length > 0, true, "carries a reason");
});

await check("no client-facing message ever contains a filesystem path", async () => {
  const startMs = Date.parse("2026-09-20T09:00:00.000Z");
  const cutter = createEventCrops({
    stateDir: await makeStateDir(),
    eventsDb: makeEventsDb([ev("e1", "cam1", "2026-09-20T09:05:00.000Z")]),
    index: makeIndex({ segments: [sealedSegment("cam1", startMs, 600_000, "cam1/very-secret-camera-path.mp4", "/srv/camplat/disk0")] }),
    config: CONFIG,
    driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    spawnFn: makeSpawnFn({ ffmpegExit: 1 }),
  });
  const r = await cutter.get("e1");
  eq(r.ok, false, "refused");
  eq(r.message.includes("/srv/") || r.message.includes(".mp4"), false, "the path never leaked into the message");
});

await cleanupTmpDirs();


// Added after the build: a recorder with no detector has no events database
// at all. api-server opens it lazily and passes null. That is an ordinary
// state on a box where detection was never switched on, and it must answer
// "no such event" rather than throwing — a crash here reaches the operator as
// a 500 that reads like a broken recorder.
await check("THE FEARED ONE: no detector on this box answers 404, it does not throw", async () => {
  const crops = createEventCrops({
    stateDir: await mkdtemp(path.join(tmpdir(), "camplat-crop-null-")),
    eventsDb: null,
    index: { forCamera: () => [], gapsFor: () => [], getByKey: () => null },
    config: { storeRoots: ["/nowhere"], cameras: [] },
    driveAssignment: new Map(),
    now: () => new Date("2026-09-20T18:00:00Z"),
    spawnFn: () => { throw new Error("nothing should be spawned when there is no detector"); },
  });
  const r = await crops.get("cam1-main:1789926001000:1");
  eq(r.ok, false, "refused");
  eq([r.status, r.code], [404, "no_such_event"], "as a plain 404");
  crops.close();
});

report("event crop");
