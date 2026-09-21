/**
 * The training-crop cutter (agent/harvest.mjs): turning one recurring false
 * detection (contracts/fixtures.ts) into a folder of labelled crops.
 *
 * THE FEARED FAILURES this suite exists to catch:
 * - a red rectangle burned onto a "raw" training crop, which would teach a
 *   classifier to find red rectangles instead of the object under one;
 * - a harvest that quietly returns 40 crops when 43 were asked for, with no
 *   word about the missing 3;
 * - a `--label` that reaches the filesystem before it is checked;
 * - a manifest line that does not actually describe the file sitting next
 *   to it;
 * - cutting crops fast enough to compete with recording for CPU/disk.
 *
 * ffprobe and ffmpeg are always a fake `spawnFn` here — never the real
 * binaries — so these checks run anywhere Node runs, exactly like
 * harness/eventCrop.harness.mjs (agent/harvest.mjs shares its spawn/probe/
 * bounded-concurrency shape on purpose).
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHarvester, cropRect, cropFileStem, isValidLabel, isValidOutDir, orderFixturesNewestFirst, PAD_FRACTION,
} from "../agent/harvest.mjs";
import { check, eq, same, report } from "./_assert.mjs";

console.log("harvest");

// ---------- fakes: the same shapes harness/eventCrop.harness.mjs uses ----------

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
 * ffprobe answers `probeJson` (or exits 1 if null), instantly. ffmpeg exits
 * `ffmpegExit` after `delayMs`, writing a fake JPEG to its output path first
 * unless it is failing. `calls` collects every { cmd, args } invocation, so a
 * check can inspect exactly what would have been run.
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

function makeEventsDb(events) {
  const rows = new Map(events.map((e) => [e.id, e]));
  return {
    all: () => [...rows.values()],
    getById: (id) => rows.get(id) ?? null,
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

/** Mirrors segindex.mjs's split, the same way eventCrop.harness.mjs's does:
 *  `forCamera`/`gapsFor` are resolvePlayback's IndexedSegment/IndexedGap
 *  view; `getByKey` hands back the full row, `root` included. */
function makeIndex({ segments = [], gaps = [] } = {}) {
  return {
    forCamera: (cameraId) => segments.filter((s) => s.cameraId === cameraId),
    gapsFor: (cameraId) => gaps.filter((g) => g.cameraId === cameraId),
    getByKey: (cameraId, startMs) =>
      segments.find((s) => s.cameraId === cameraId && Date.parse(s.startUtc) === startMs) ?? null,
  };
}

function ev(id, cameraId, kind, bestUtc, box, opts = {}) {
  const event = {
    id,
    cameraId,
    kind,
    firstUtc: bestUtc,
    lastUtc: bestUtc,
    count: 1,
    bestConfidence: opts.confidence ?? 0.9,
    bestBox: box,
    bestUtc,
    finished: true,
  };
  if (opts.species !== undefined) event.species = opts.species;
  return event;
}

const CONFIG = { storeRoots: ["/srv/camplat/disk0", "/srv/camplat/disk1"] };
function driveMap(entries) { return new Map(entries); }

const T0 = Date.parse("2026-09-20T09:00:00.000Z");
const at = (mins) => new Date(T0 + mins * 60_000).toISOString();
const BOX = { x: 0.4, y: 0.35, w: 0.1, h: 0.2 };

let tmpDirs = [];
async function makeOutDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "harvest-"));
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

// ---------- pure pieces: no fs, no spawn ----------

check("cropRect pads ~15% of the box on each side, in whole pixels", () => {
  // box -> pixels first (0.4*1000=400, 0.35*500=175, 0.1*1000=100, 0.2*500=100),
  // then padded by 15% of THAT box's own w/h (15 px each side).
  const rect = cropRect({ x: 0.4, y: 0.35, w: 0.1, h: 0.2 }, { width: 1000, height: 500 });
  eq(rect, { ok: true, x: 385, y: 160, w: 130, h: 130 }, "padded and centred on the detection box");
});

check("cropRect clamps padding at the frame edge rather than going negative", () => {
  // A box already touching the top-left corner: padding must not push x/y
  // below 0, which a naive box.x - pad would do.
  const rect = cropRect({ x: 0, y: 0, w: 0.05, h: 0.1 }, { width: 800, height: 600 });
  eq(rect, { ok: true, x: 0, y: 0, w: 46, h: 69 }, "clamped to the frame, not into negative pixels");
});

check("cropRect refuses an unreadable box or frame rather than guessing", () => {
  const badBox = cropRect({ x: 0.1, y: 0.1, w: 0, h: 0.1 }, { width: 800, height: 600 });
  eq(badBox.ok, false, "refused");
  eq(badBox.reason, "bad_box", "bad_box");
  const badFrame = cropRect({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { width: 0, height: 600 });
  eq(badFrame.ok, false, "refused");
  eq(badFrame.reason, "bad_frame", "bad_frame");
});

check("PAD_FRACTION is the documented ~15%", () => {
  eq(PAD_FRACTION, 0.15, "matches the brief");
});

check("isValidLabel accepts letters/digits/dash/underscore and refuses everything else", () => {
  eq(isValidLabel("spray_bottle"), true, "underscore ok");
  eq(isValidLabel("bike-163"), true, "dash and digits ok");
  eq(isValidLabel(""), false, "empty refused");
  eq(isValidLabel("../etc"), false, "path traversal refused");
  eq(isValidLabel("a/b"), false, "slash refused");
  eq(isValidLabel("has space"), false, "space refused");
  eq(isValidLabel("a".repeat(65)), false, "over length refused");
  eq(isValidLabel(null), false, "non-string refused");
});

check("isValidOutDir wants a real, bounded, plain path", () => {
  eq(isValidOutDir("/srv/training"), true, "a plain path is fine");
  eq(isValidOutDir(""), false, "empty refused");
  eq(isValidOutDir("a\0b"), false, "embedded NUL refused");
  eq(isValidOutDir(null), false, "non-string refused");
});

check("cropFileStem is deterministic per event and never collides across events", () => {
  const a = ev("cam1:1000:1", "cam1", "person", at(0), BOX);
  const b = ev("cam1:1000:2", "cam1", "person", at(0), BOX); // same everything except id
  eq(cropFileStem(a), cropFileStem(a), "same event, called twice, same stem");
  eq(cropFileStem(a) === cropFileStem(b), false, "different event ids never collide");
});

check("orderFixturesNewestFirst sorts by lastUtc, then a deterministic tie-break", () => {
  const fx = (cameraId, kind, lastUtc, firstUtc) => ({
    cameraId, kind, box: BOX, eventIds: ["e"], firstUtc, lastUtc,
    spanMs: 0, confidenceMax: 0.9, species: null, speciesSeen: [],
  });
  const older = fx("cam2", "person", at(0), at(-60));
  const newest = fx("cam1", "person", at(60), at(30));
  const tiedWithOlder = fx("cam1", "vehicle", at(0), at(-45)); // ties `older` on lastUtc
  const ordered = orderFixturesNewestFirst([older, newest, tiedWithOlder]);
  eq(ordered.map((f) => `${f.cameraId}:${f.kind}`), ["cam1:person", "cam1:vehicle", "cam2:person"],
    "newest first, ties broken by cameraId then kind");
});

// ---------- integration: createHarvester, fake spawnFn, real temp files ----------

function threeEventFixtureDb(opts = {}) {
  return makeEventsDb([
    ev("e0", "cam1", "person", at(0), BOX, { species: "person", confidence: 0.81, ...opts.e0 }),
    ev("e20", "cam1", "person", at(20), BOX, { species: "person", confidence: 0.93, ...opts.e20 }),
    ev("e40", "cam1", "person", at(40), BOX, { confidence: 0.77, ...opts.e40 }), // deliberately no species
  ]);
}

await check("crops are cut for every event of a fixture", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 55 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls }),
  });

  const { fixtures, ungrouped, rejected } = await harvester.listFixtures();
  eq(fixtures.length, 1, "exactly one fixture formed from the three events");
  eq(fixtures[0].eventIds.length, 3, "all three events grouped into it");
  eq(ungrouped.length, 0, "nothing left over");
  eq(rejected.length, 0, "nothing rejected");

  const outDir = await makeOutDir();
  const result = await harvester.cutFixture(fixtures, 1, { label: "spray_bottle", outDir });
  eq(result.ok, true, `cutFixture succeeded: ${JSON.stringify(result)}`);
  eq(result.total, 3, "three events total");
  eq(result.cut, 3, "THE ONE: a crop for every event, not a subset");
  eq(result.failures.length, 0, "no failures");
  for (const file of result.files) {
    eq(await fileExists(file), true, `crop file really exists on disk: ${file}`);
  }
});

await check("THE FEARED ONE: the ffmpeg filter is a plain crop, never a drawn rectangle", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 55 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls }),
  });
  const { fixtures } = await harvester.listFixtures();
  const outDir = await makeOutDir();
  await harvester.cutFixture(fixtures, 1, { label: "thing", outDir });

  const ffmpegCalls = calls.filter((c) => c.cmd === "ffmpeg");
  eq(ffmpegCalls.length > 0, true, "ffmpeg really ran");
  for (const c of ffmpegCalls) {
    // Assert on the ARGUMENTS, not on the outcome: a mock ffmpeg will happily
    // accept any filter string, so the only honest check is what was asked
    // of it.
    const vfAt = c.args.indexOf("-vf");
    eq(vfAt >= 0, true, `-vf is present: ${JSON.stringify(c.args)}`);
    const filter = c.args[vfAt + 1];
    eq(/^crop=\d+:\d+:\d+:\d+$/.test(filter), true, `filter is exactly a crop: ${filter}`);
    eq(filter.toLowerCase().includes("draw"), false, "no drawing filter hiding in there");
    eq(c.args.every((a) => typeof a !== "string" || !a.toLowerCase().includes("drawbox")), true,
      "no drawbox anywhere in the whole argument list");
  }
});

await check("THE FEARED ONE: a bad --label is refused before anything touches the filesystem", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 55 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls }),
  });
  const { fixtures } = await harvester.listFixtures();
  // A path that does not exist yet, and must never come to exist.
  const outDir = path.join(tmpdir(), `harvest-untouched-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const result = await harvester.cutFixture(fixtures, 1, { label: "../../etc/passwd", outDir });
  eq(result.ok, false, "refused");
  eq(result.reason, "bad_label", "bad_label");
  eq(calls.length, 0, "nothing was spawned for a request that never should have started");
  eq(existsSync(outDir), false, "the out dir was never created");
});

await check("a bad --out and a bad fixture index are refused the same way, before touching the filesystem", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 55 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls }),
  });
  const { fixtures } = await harvester.listFixtures();

  const badOut = await harvester.cutFixture(fixtures, 1, { label: "ok_label", outDir: "" });
  eq(badOut.ok, false, "refused");
  eq(badOut.reason, "bad_out", "bad_out");

  const badIndexLow = await harvester.cutFixture(fixtures, 0, { label: "ok_label", outDir: "/tmp/whatever" });
  eq(badIndexLow.ok, false, "refused");
  eq(badIndexLow.reason, "bad_index", "bad_index below range");

  const badIndexHigh = await harvester.cutFixture(fixtures, fixtures.length + 1, { label: "ok_label", outDir: "/tmp/whatever" });
  eq(badIndexHigh.ok, false, "refused");
  eq(badIndexHigh.reason, "bad_index", "bad_index above range");

  eq(calls.length, 0, "none of these refusals spawned anything");
});

await check("THE FEARED ONE: evicted footage is skipped and COUNTED, never a silent short harvest", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  // This segment only covers -5..25 minutes: e0 (0min) and e20 (20min) are
  // inside it, but e40's moment falls in a hole nobody logged — footage that
  // has since been evicted by retention, or was simply never recorded.
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 30 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls }),
  });
  const { fixtures } = await harvester.listFixtures();
  eq(fixtures[0].eventIds.length, 3, "the fixture itself does not know or care about footage");

  const outDir = await makeOutDir();
  const result = await harvester.cutFixture(fixtures, 1, { label: "thing", outDir });
  eq(result.ok, true, "the run still completes");
  eq(result.total, 3, "the operator is told the real total: 3, not 2");
  eq(result.cut, 2, "two crops were actually cut");
  eq(result.failures.length, 1, "one failure, reported, not swallowed");
  eq(result.failures[0], { eventId: "e40", reason: "footage_gone" }, "the missing one is named and the reason is given");
});

await check("THE FEARED ONE: at most maxConcurrent ffmpeg children run at once, whatever the burst", async () => {
  let maxRunning = 0;
  const spawnFn = makeSpawnFn({ delayMs: 30, onRunningChange: (n) => { maxRunning = Math.max(maxRunning, n); } });
  const ids = ["a", "b", "c", "d", "e"];
  const eventsDb = makeEventsDb(ids.map((id, i) => ev(id, "cam1", "person", at(i * 8), BOX)));
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 60 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn, maxConcurrent: 2,
  });

  const { fixtures } = await harvester.listFixtures();
  eq(fixtures.length, 1, "one fixture of five");
  eq(fixtures[0].eventIds.length, 5, "all five sightings grouped");

  const outDir = await makeOutDir();
  const result = await harvester.cutFixture(fixtures, 1, { label: "thing", outDir });
  eq(result.cut, 5, "every event still gets cut, just not all at once");
  eq(maxRunning <= 2, true, `never more than maxConcurrent running at once, saw ${maxRunning}`);
  eq(maxRunning, 2, "and it actually reached the cap rather than accidentally serialising to 1");
});

await check("the manifest line for each crop matches the event AND the file really on disk", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  const events = eventsDb.all();
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 55 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls }),
  });
  const { fixtures } = await harvester.listFixtures();
  const outDir = await makeOutDir();
  const result = await harvester.cutFixture(fixtures, 1, { label: "spray_bottle", outDir });
  eq(result.cut, 3, "all three cut, so all three should be in the manifest");

  const manifestRaw = await readFile(path.join(outDir, "manifest.jsonl"), "utf8");
  const lines = manifestRaw.trim().split("\n").filter(Boolean);
  eq(lines.length, 3, "one manifest line per crop, no more, no fewer");

  const byId = new Map(events.map((e) => [e.id, e]));
  for (const line of lines) {
    const entry = JSON.parse(line);
    const source = byId.get(entry.eventId);
    eq(Boolean(source), true, `manifest line names a real event: ${entry.eventId}`);
    eq(entry.label, "spray_bottle", "label recorded");
    eq(entry.cameraId, source.cameraId, "cameraId matches the event");
    eq(entry.kind, source.kind, "kind matches the event");
    eq(entry.bestConfidence, source.bestConfidence, "bestConfidence matches the event");
    eq(entry.bestUtc, source.bestUtc, "bestUtc matches the event");
    same(entry.box, source.bestBox, "box matches the event's detection box exactly");
    eq("species" in entry, source.species !== undefined, "species present iff the event actually had one (never null)");
    if (source.species !== undefined) eq(entry.species, source.species, "species value matches");
    eq(await fileExists(path.join(outDir, entry.file)), true, `the crop the manifest points at really exists: ${entry.file}`);
  }
});

await check("an ffmpeg that exits non-zero is a counted failure, never a zero-byte crop", async () => {
  const calls = [];
  const eventsDb = threeEventFixtureDb();
  const index = makeIndex({ segments: [sealedSegment("cam1", T0 - 5 * 60_000, 55 * 60_000, "cam1/seg1.mp4", "/srv/camplat/disk0")] });
  const harvester = createHarvester({
    eventsDb, index, config: CONFIG, driveAssignment: driveMap([["cam1", 0]]),
    now: () => new Date(T0 + 120 * 60_000), spawnFn: makeSpawnFn({ calls, ffmpegExit: 1 }),
  });
  const { fixtures } = await harvester.listFixtures();
  const outDir = await makeOutDir();
  const result = await harvester.cutFixture(fixtures, 1, { label: "thing", outDir });
  eq(result.cut, 0, "nothing was cut");
  eq(result.total, 3, "but the real total is still reported");
  eq(result.failures.length, 3, "every one of them is a counted failure");
  eq(result.failures.every((f) => f.reason === "cut_failed"), true, "cut_failed, not silently absent");
});

await cleanupTmpDirs();
report("harvest");
