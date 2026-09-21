#!/usr/bin/env node
/**
 * Turns a recurring false detection into a labelled training set.
 *
 * WHY THIS EXISTS: the owner's detector reports a child's bicycle as a
 * "vehicle" 163 times a day and a spray bottle as a "person" 77 times in 13
 * hours. Each of those is a mislabelled object that recurs endlessly, which
 * makes it a training set that labels itself: contracts/fixtures.ts finds the
 * recurring cluster, a human looks at ONE of them and says what it really is,
 * and this file cuts a crop for every sighting so one decision yields
 * hundreds of labelled images for the owner's RTX 4060 laptop to train on.
 *
 * `list` groups events into fixtures and shows what was found — and, just as
 * important, what was NOT offered (build rule 16: say what you could not use,
 * and why). `cut` takes one fixture and a human-supplied label and produces
 * `<out>/<label>/*.jpg` plus a manifest line per crop.
 *
 * THE FEARED FAILURES, in the order the brief gave them:
 * 1. A red rectangle burned onto a training image teaches the classifier to
 *    find red rectangles, not the object under one. agent/event-crop.mjs
 *    draws on its thumbnails on purpose, for a human; this file must never
 *    reuse that path. The ffmpeg filter here is `crop=...` and NOTHING else.
 * 2. A crop framed exactly on the box teaches the classifier the object never
 *    touches its own edges. ~15% padding per side, clamped to the frame.
 * 3. A frame size that is assumed rather than measured is wrong the moment a
 *    camera's resolution differs from the one the code was written against.
 * 4. Cutting crops must never compete meaningfully with recording: at most
 *    `maxConcurrent` (2) ffmpeg/ffprobe children at once, niced where the
 *    platform allows it, and every read is of a SEALED segment — the same
 *    refusal event-crop.mjs makes for a segment still being written.
 * 5. A harvest that quietly cuts 40 crops when 43 were asked for, with no
 *    word about the missing 3, teaches the owner the wrong number of examples
 *    exist. Every refusal is counted and reported by reason, never dropped.
 * 6. `--label` becomes a directory name and `--out` the root it is written
 *    under; neither may be built from anything the detector reported.
 * 7. Re-running `cut` (a retry, a second label pass, tomorrow) must reuse the
 *    same file for the same event — a random or incrementing name would
 *    leave orphaned duplicates every time the tool is re-run.
 *
 * WHAT THIS FILE DOES NOT DO: it renders no verdict on what a fixture is
 * (build rule 11) and applies no label automatically (build rule 13) — the
 * whole design is "suggest, show the evidence, let a human type the label".
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, posix as posixPath, sep as pathSep } from "node:path";
import os from "node:os";

import { resolvePlayback } from "../dist/indexCoverage.js";
import { markRect } from "../dist/eventThumb.js";
import { parseFfprobeJson } from "../dist/ffprobe.js";
import { groupFixtures } from "../dist/fixtures.js";

import { openEventsDb } from "./events-db.mjs";
import { openIndex } from "./segindex.mjs";
import { loadConfig } from "./recorder-service.mjs";
import { DEFAULT_PATHS, indexPathFor, assignCamerasToDrives } from "./config.mjs";

// ---------------------------------------------------------------------------
// Pure pieces: no I/O, no clock, no spawn. Exported so the harness can drive
// every rule above without touching a filesystem or a process (build rule 2).
// ---------------------------------------------------------------------------

/** How much of the box's own width/height to add on EACH side (rule 2 above). */
export const PAD_FRACTION = 0.15;

/**
 * The crop rectangle for one event: the detection box padded ~15% a side,
 * clamped to the frame, in whole pixels ffmpeg's `crop` filter can use.
 *
 * Reuses markRect's box/frame validation and its box-to-pixel conversion
 * (contracts/eventThumb.ts) rather than re-deriving it: that module already
 * carries the tested rule for turning a fractional box into whole, clamped
 * pixels, and a second, slightly different implementation of the same rule
 * is exactly how two call sites quietly disagree. It marks an OUTLINE for a
 * human; this pads that same rectangle outward and returns a CROP instead.
 */
export function cropRect(box, frame) {
  const marked = markRect(box, frame);
  if (!marked.ok) return marked;
  const fw = Math.floor(frame.width);
  const fh = Math.floor(frame.height);
  const padX = marked.w * PAD_FRACTION;
  const padY = marked.h * PAD_FRACTION;
  const x0 = Math.max(0, Math.floor(marked.x - padX));
  const y0 = Math.max(0, Math.floor(marked.y - padY));
  const x1 = Math.min(fw, Math.ceil(marked.x + marked.w + padX));
  const y1 = Math.min(fh, Math.ceil(marked.y + marked.h + padY));
  return { ok: true, x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Letters, digits, dash, underscore, 1-64 characters. Rule 6: a bad label is
 *  refused whole, never trimmed or escaped into something "close enough". */
const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidLabel(label) {
  return typeof label === "string" && LABEL_PATTERN.test(label);
}

/**
 * `--out` is never built from anything a detector reported (rule 6) — it is
 * the operator's own argument, used as a plain path. The check here is
 * therefore about SHAPE, not content: a real, bounded string with no NUL
 * byte (which no filesystem accepts and which some C-based tools truncate
 * on, silently writing somewhere shorter than what was asked for).
 */
export function isValidOutDir(dir) {
  return typeof dir === "string" && dir.length > 0 && dir.length <= 4096 && !dir.includes("\0");
}

/**
 * The crop's file name (no extension): deterministic in the event, and
 * collision-free across every other event this box will ever record (rule
 * 7). `cameraId` is sanitised for display only — the actual uniqueness comes
 * from hashing the event's own id, which upstream (contracts/detectStream.ts)
 * is already `${cameraId}:${atMs}:${seq}` and unique for the life of the
 * appliance. Hashing it rather than sanitising it in place means two ids that
 * sanitise to the same string (say, one used ":" and another "_" on purpose)
 * can never collide.
 */
export function cropFileStem(event) {
  const safeCamera = event.cameraId.replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha256").update(event.id).digest("hex").slice(0, 12);
  return `${safeCamera}_${event.kind}_${Date.parse(event.bestUtc)}_${hash}`;
}

/**
 * Fixtures newest-first, with a fully deterministic tie-break. `list` and
 * `cut` must agree on what "index 3" means within one invocation of each —
 * an ordering that depends on object insertion order (clusters form in the
 * order groupFixtures happens to walk the events) would make the same
 * fixture print at a different index than it sorts to.
 */
export function orderFixturesNewestFirst(fixtures) {
  return [...fixtures].sort((a, b) => {
    const byLast = Date.parse(b.lastUtc) - Date.parse(a.lastUtc);
    if (byLast !== 0) return byLast;
    if (a.cameraId !== b.cameraId) return a.cameraId < b.cameraId ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return Date.parse(a.firstUtc) - Date.parse(b.firstUtc);
  });
}

/** Human text for contracts/fixtures.ts's Rejected.reason, for `list`'s output. */
const REJECT_REASONS = {
  too_few: "fewer than 3 sightings",
  too_brief: "spanned less than 30 minutes",
  size_spread: "sizes varied too much to be one recurring object",
};

/** Human text for a cut refusal's reason, for `cut`'s summary. */
const CUT_MESSAGES = {
  event_missing: "the event no longer exists in events.db",
  footage_gone: "the recording for that moment is no longer on this recorder",
  segment_open: "the recording for that moment is still being written",
  probe_failed: "the frame size could not be measured",
  bad_box: "the detection box could not be read",
  cut_failed: "the crop could not be cut",
};

// ---------------------------------------------------------------------------
// I/O pieces. `spawnFn` is injectable throughout, and the real `ffmpeg` /
// `ffprobe` binaries are never touched by anything above this line.
// ---------------------------------------------------------------------------

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The drive a segment is on. Mirrors agent/event-crop.mjs's `rootOf` exactly
 * — that file is not this one's to edit and exports nothing here to share,
 * so the small pure calculation is kept in step by hand rather than imported.
 */
function rootOf(segment, cameraId, { config, driveAssignment }) {
  if (typeof segment?.root === "string" && config.storeRoots.includes(segment.root)) {
    return segment.root;
  }
  return config.storeRoots[driveAssignment.get(cameraId) ?? 0];
}

/** Run a child process via the injected spawnFn and collect its output. Never
 *  the real `spawn` directly, so a harness can fake ffprobe/ffmpeg. Mirrors
 *  agent/event-crop.mjs's `run` for the same reason as `rootOf` above. */
function run(spawnFn, command, args) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({ code: -1, stdout: "", stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.once("error", (err) => resolvePromise({ code: -1, stdout, stderr: String(err?.message ?? err) }));
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** The recorded frame's width and height, MEASURED (rule 3) — never assumed.
 *  Null on anything ffprobe cannot answer. */
async function probeFrameSize(spawnFn, absPath) {
  const { code, stdout } = await run(spawnFn, "ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    absPath,
  ]);
  if (code !== 0) return null;
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = parseFfprobeJson(json);
  if (parsed.kind !== "ok") return null;
  return { width: parsed.stream.width, height: parsed.stream.height };
}

/**
 * Cut one frame at `offsetSeconds` into `absPath`, CROPPED to `rect`, into
 * `tmpPath`. THE FEARED ONE lives here: the `-vf` value is `crop=...` and
 * nothing else ever gets appended to it — no drawbox, no mark, no scale.
 * Resolves `true` only on a zero exit AND a file actually written.
 */
async function cutCropFile(spawnFn, { absPath, offsetSeconds, rect, tmpPath }) {
  const args = [
    "-ss", String(offsetSeconds),
    "-i", absPath,
    "-frames:v", "1",
    "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`,
    "-q:v", "2",
    "-f", "image2",
    "-update", "1",
    "-y", tmpPath,
  ];
  let child;
  const donePromise = new Promise((resolvePromise) => {
    child = spawnFn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.once("error", () => resolvePromise(false));
    child.once("close", (code) => resolvePromise(code === 0));
  });
  // Best effort, same as event-crop.mjs: a training-crop cut competing with
  // recording and detection for CPU should lose that fight. Not every
  // platform grants this; a refusal here is swallowed rather than failing
  // the whole cut (rule 4: reading footage only, never disturbing recording,
  // but niceness itself is not load-bearing for correctness).
  try {
    if (child?.pid !== undefined) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch { /* niceness is not available everywhere */ }
  const exitedClean = await donePromise;
  return exitedClean && (await exists(tmpPath));
}

/** Run `worker` over `items`, never more than `limit` at once. A finite,
 *  known list rather than a live queue (unlike event-crop.mjs's server-side
 *  scheduler): `cutFixture` always knows the whole harvest up front, and
 *  there is no caller to refuse "busy" to — it either runs, bounded, or the
 *  process is not running it yet. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

/**
 * The harvester behind the CLI below. `eventsDb`, `index`, `config` and
 * `driveAssignment` are the same shapes agent/event-crop.mjs takes, so a
 * harness can build them the same way. `spawnFn` and `now` are injectable so
 * the harness never spawns a real ffmpeg or ffprobe.
 */
export function createHarvester({ eventsDb, index, config, driveAssignment, now = () => new Date(), spawnFn = spawn, maxConcurrent = 2 }) {
  let tmpCounter = 0;

  /** Group every event currently in events.db, newest fixture first. Never
   *  drops a cluster silently — `rejected` and `ungrouped` travel with the
   *  fixtures themselves (build rule 16). */
  async function listFixtures() {
    const grouping = groupFixtures(eventsDb.all());
    return { ...grouping, fixtures: orderFixturesNewestFirst(grouping.fixtures) };
  }

  /** Steps for one event: resolve its footage, measure the frame, crop it. */
  async function cutOneEvent(event, { outDir, label }) {
    const resolution = resolvePlayback(
      event.cameraId,
      index.forCamera(event.cameraId),
      index.gapsFor(event.cameraId),
      event.bestUtc,
      now().toISOString(),
    );
    if (resolution.kind === "gap" || resolution.kind === "future") {
      return { eventId: event.id, ok: false, reason: "footage_gone" };
    }
    if (resolution.kind === "recording") {
      return { eventId: event.id, ok: false, reason: "segment_open" };
    }
    const startMs = Date.parse(resolution.segmentStartUtc);
    const row = index.getByKey(event.cameraId, startMs);
    if (!row) {
      return { eventId: event.id, ok: false, reason: "footage_gone" };
    }
    if (row.state === "open") {
      return { eventId: event.id, ok: false, reason: "segment_open" };
    }
    const absPath = join(rootOf(row, event.cameraId, { config, driveAssignment }), row.path);

    const size = await probeFrameSize(spawnFn, absPath);
    if (size === null) {
      return { eventId: event.id, ok: false, reason: "probe_failed" };
    }
    const rect = cropRect(event.bestBox, size);
    if (!rect.ok) {
      return { eventId: event.id, ok: false, reason: "bad_box" };
    }

    const stem = cropFileStem(event);
    const labelDir = join(outDir, label);
    await mkdir(labelDir, { recursive: true });
    const finalPath = join(labelDir, `${stem}.jpg`);
    const tmpPath = join(labelDir, `${stem}.${process.pid}.${tmpCounter++}.tmp`);

    const cut = await cutCropFile(spawnFn, { absPath, offsetSeconds: resolution.offsetSeconds, rect, tmpPath });
    if (!cut) {
      await rm(tmpPath, { force: true }).catch(() => {});
      return { eventId: event.id, ok: false, reason: "cut_failed" };
    }
    await rename(tmpPath, finalPath);

    const manifest = {
      // Relative to `outDir`, in POSIX form: the appliance is Linux, and a
      // manifest that only reads correctly on the box that wrote it is not
      // portable to the laptop doing the training.
      file: posixPath.join(label, `${stem}.jpg`),
      label,
      eventId: event.id,
      cameraId: event.cameraId,
      kind: event.kind,
      // Absent, never null, exactly as events-db.mjs stores it (build rule 5:
      // a blank is not a zero — here, "no species reported" is not "unknown
      // species", it is a field that is not there).
      ...(event.species !== undefined ? { species: event.species } : {}),
      bestConfidence: event.bestConfidence,
      bestUtc: event.bestUtc,
      box: event.bestBox,
    };
    return { eventId: event.id, ok: true, file: finalPath, manifest };
  }

  /**
   * Cut every event of `orderedFixtures[index1Based - 1]` into
   * `<outDir>/<label>/`, and append one manifest.jsonl line per crop.
   *
   * Refuses (without touching the filesystem) on a bad index, a bad label or
   * a bad out dir. Otherwise NEVER refuses the whole run for one bad event:
   * every event is attempted, every failure is counted and returned with its
   * reason, and the caller decides how to report a partial harvest — a short
   * harvest must be a REPORTED fact, never a silent one (rule 5).
   */
  async function cutFixture(orderedFixtures, index1Based, { label, outDir }) {
    if (!Number.isInteger(index1Based) || index1Based < 1 || index1Based > orderedFixtures.length) {
      return { ok: false, reason: "bad_index", message: `fixture index must be between 1 and ${orderedFixtures.length}` };
    }
    if (!isValidLabel(label)) {
      return { ok: false, reason: "bad_label", message: "--label must be 1-64 characters of letters, digits, '-' or '_'" };
    }
    if (!isValidOutDir(outDir)) {
      return { ok: false, reason: "bad_out", message: "--out must be a plain, non-empty path" };
    }

    const fixture = orderedFixtures[index1Based - 1];
    const results = await mapWithConcurrency(fixture.eventIds, maxConcurrent, async (eventId) => {
      const event = eventsDb.getById(eventId);
      if (!event) return { eventId, ok: false, reason: "event_missing" };
      return cutOneEvent(event, { outDir, label });
    });

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok).map((r) => ({ eventId: r.eventId, reason: r.reason }));

    if (successes.length > 0) {
      await mkdir(outDir, { recursive: true });
      const lines = successes.map((r) => JSON.stringify(r.manifest)).join("\n") + "\n";
      await appendFile(join(outDir, "manifest.jsonl"), lines, "utf8");
    }

    return {
      ok: true,
      label,
      outDir,
      total: fixture.eventIds.length,
      cut: successes.length,
      files: successes.map((r) => r.file),
      failures,
    };
  }

  return { listFixtures, cutFixture };
}

// ---------------------------------------------------------------------------
// CLI. Everything above this line is importable with no argv parsing and no
// process exit — this is the only part the harness never runs.
// ---------------------------------------------------------------------------

function boxStr(box) {
  return `x=${box.x.toFixed(2)} y=${box.y.toFixed(2)} w=${box.w.toFixed(2)} h=${box.h.toFixed(2)}`;
}

async function openHarvester(stateDir) {
  const config = await loadConfig(stateDir);
  const eventsFile = join(stateDir, "events.db");
  if (!existsSync(eventsFile)) {
    throw new Error(`no events.db at ${eventsFile} — the detector has never run on this box, so there is nothing to harvest`);
  }
  const eventsDb = openEventsDb(eventsFile);
  const index = openIndex(indexPathFor(stateDir));
  const driveAssignment = assignCamerasToDrives(config.cameras.map((c) => c.cameraId), config.storeRoots.length);
  const harvester = createHarvester({ eventsDb, index, config, driveAssignment });
  return { harvester, close: () => { eventsDb.close(); index.close(); } };
}

async function cmdList(stateDir) {
  const { harvester, close } = await openHarvester(stateDir);
  try {
    const { fixtures, ungrouped, rejected } = await harvester.listFixtures();
    if (fixtures.length === 0) {
      console.log("no fixtures yet: nothing has recurred often enough, or for long enough, to offer.");
    }
    fixtures.forEach((f, i) => {
      const idx = i + 1;
      const hours = (f.spanMs / 3_600_000).toFixed(1);
      const speciesLabel = f.species ?? "varies";
      const peakPct = Math.round(f.confidenceMax * 100);
      console.log(
        `[${idx}] ${f.cameraId}  ${f.kind}  ${speciesLabel}  ${f.eventIds.length} events  ${hours}h  peak ${peakPct}%  box ${boxStr(f.box)}`,
      );
    });
    console.log(`\n${ungrouped.length} event(s) left ungrouped; ${rejected.length} cluster(s) rejected and NOT offered:`);
    for (const r of rejected) {
      console.log(`  ${r.cameraId}  ${r.kind}  ${r.eventIds.length} sighting(s) — ${REJECT_REASONS[r.reason] ?? r.reason}`);
    }
  } finally {
    close();
  }
}

async function cmdCut(stateDir, fixtureIndex, label, outDir) {
  const { harvester, close } = await openHarvester(stateDir);
  try {
    const { fixtures } = await harvester.listFixtures();
    const result = await harvester.cutFixture(fixtures, fixtureIndex, { label, outDir });
    if (!result.ok) {
      console.error(`refused: ${result.message}`);
      process.exitCode = 2;
      return;
    }
    console.log(`cut ${result.cut} of ${result.total} crop(s) for fixture ${fixtureIndex} into ${join(outDir, label)}${pathSep}`);
    if (result.failures.length > 0) {
      const tally = new Map();
      for (const f of result.failures) tally.set(f.reason, (tally.get(f.reason) ?? 0) + 1);
      console.log(`${result.failures.length} of ${result.total} crop(s) could NOT be cut:`);
      for (const [reason, count] of tally) {
        console.log(`  ${count} ${reason} — ${CUT_MESSAGES[reason] ?? reason}`);
      }
    }
  } finally {
    close();
  }
}

function flagFrom(args, name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

async function main() {
  const [, , command, ...args] = process.argv;
  const stateDir = flagFrom(args, "state-dir") ?? process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;

  if (command === "list") {
    await cmdList(stateDir);
    return;
  }
  if (command === "cut") {
    const rawIndex = flagFrom(args, "fixture");
    const label = flagFrom(args, "label");
    const outDir = flagFrom(args, "out");
    if (rawIndex === null || label === null || outDir === null) {
      console.error("usage: harvest cut --fixture <index> --label <name> --out <dir>");
      process.exitCode = 2;
      return;
    }
    const fixtureIndex = /^\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;
    await cmdCut(stateDir, fixtureIndex, label, outDir);
    return;
  }

  console.log(`harvest <command>

  list [--state-dir D]                          group events.db into fixtures and list them
  cut --fixture N --label NAME --out DIR         cut every event of fixture N into DIR/NAME/
      [--state-dir D]

  --state-dir defaults to $CAMPLAT_STATE_DIR, else ${DEFAULT_PATHS.stateDir}

example:
  node agent/harvest.mjs list
  node agent/harvest.mjs cut --fixture 3 --label spray_bottle --out ./training`);
  process.exitCode = command ? 2 : 0;
}

if (process.argv[1]?.endsWith("harvest.mjs")) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exitCode = 1;
  });
}
