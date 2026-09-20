/**
 * Turns an event id into a JPEG thumbnail, cut from the recording at that
 * event's most confident moment, so an operator can see WHAT fired without
 * playing the clip.
 *
 * WHY: on a real morning a spray bottle on a shelf was reported as a person 77
 * times in 13 hours. Working out that it was a bottle cost an ffmpeg cut, a
 * file copy and someone looking at the picture. With the crop on the tile it
 * is a glance. contracts/cropPlan.ts decides the rectangle; this file does the
 * cutting and the caching around it.
 *
 * THE FEARED FAILURES:
 * - serving a crop cut from the WRONG moment: an event keeps growing while it
 *   happens, so its bestUtc/bestBox can move on; the moment is baked into the
 *   cache file's name so a stale crop can never answer for a new one, and the
 *   stale file is removed once its replacement lands.
 * - reading a segment while the recorder is still writing it: refused
 *   (segment_open), never read half-written.
 * - a Review page open on 500 events spawning 500 ffmpegs at once: bounded by
 *   maxConcurrent, with a hard cap on how much work can queue behind it.
 * - a bad crop rectangle or an ffmpeg that fails partway producing a
 *   zero-byte or truncated file that LOOKS like a thumbnail: every failure
 *   path refuses instead of renaming a partial result into place.
 * - leaking where footage lives: client-facing messages are fixed strings,
 *   never ffmpeg's stderr or a filesystem path (ffmpeg here reads a local
 *   FILE, not an rtsp URL with a password in it, but the same discipline
 *   applies to paths).
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { resolvePlayback } from '../dist/indexCoverage.js';
import { planCrop } from '../dist/cropPlan.js';
import { parseFfprobeJson } from '../dist/ffprobe.js';

const CROPS_DIR = 'crops';

/** Requests allowed to wait once every ffmpeg slot is taken. Beyond this a
 *  Review page loading a busy day refuses rather than growing without limit. */
const MAX_QUEUE = 32;

const MESSAGES = {
  no_such_event: 'no event with that id',
  footage_gone: 'the recording for that moment is no longer on this recorder',
  segment_open: 'the recording for that moment is still being written',
  crop_failed: 'the thumbnail could not be cut',
  busy: 'too many thumbnails are already being cut; try again shortly',
};

function refuse(status, code, message = MESSAGES[code] ?? code) {
  return { ok: false, status, code, message };
}

/** `<eventId>__<bestMs>.jpg`. bestMs is part of the name on purpose: an event
 *  is still growing while it happens, so its bestUtc can move to a later,
 *  better sighting, and a crop cached under the old moment must never be
 *  handed out for the new one — a different file name is how that is true
 *  without ever comparing timestamps at read time. */
function cropFileName(eventId, bestMs) {
  return `${eventId}__${bestMs}.jpg`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The drive a segment is on. Mirrors agent/api-server.mjs's rootOf exactly
 * (that file is not this file's to edit, and exports nothing here to share,
 * so the small pure calculation is kept in step rather than imported).
 */
function rootOf(segment, cameraId, { config, driveAssignment }) {
  if (typeof segment?.root === 'string' && config.storeRoots.includes(segment.root)) {
    return segment.root;
  }
  return config.storeRoots[driveAssignment.get(cameraId) ?? 0];
}

/**
 * Run a child process via the injected spawnFn and collect its output.
 * Never the real `spawn` directly, so a harness can fake ffprobe/ffmpeg and
 * assert on refusals without either binary installed.
 */
function run(spawnFn, command, args) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ code: -1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.once('error', (err) => resolvePromise({ code: -1, stdout, stderr: String(err?.message ?? err) }));
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** The recorded frame's width and height, measured — never assumed. Returns
 *  null on anything ffprobe cannot answer: a missing binary, a bad exit, JSON
 *  that will not parse, or a stream ffprobe cannot read. */
async function probeFrameSize(spawnFn, absPath) {
  const { code, stdout } = await run(spawnFn, 'ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
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
  if (parsed.kind !== 'ok') return null;
  return { width: parsed.stream.width, height: parsed.stream.height };
}

/**
 * Cut one frame at `offsetSeconds` into `absPath`, cropped to `rect` and
 * scaled to a 240px-wide thumbnail, into `tmpPath`. Resolves `true` only on a
 * zero exit AND a file actually written — ffmpeg exiting 0 with nothing
 * written is treated the same as a failure, never as an empty "crop".
 */
async function cutFrame(spawnFn, { absPath, offsetSeconds, rect, tmpPath }) {
  const args = [
    '-ss', String(offsetSeconds),
    '-i', absPath,
    '-frames:v', '1',
    '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=240:-2`,
    '-q:v', '5',
    // State the format. ffmpeg otherwise guesses it from the output's
    // extension, and we write to a temp name ending in ".tmp" so a half-cut
    // thumbnail can never be served — which made it refuse outright:
    // "Unable to choose an output format ... use a standard extension".
    // Measured on the laptop NVR 2026-09-20: exit 234, every real crop.
    // The unit checks passed throughout, because a fake ffmpeg does not care
    // what the file is called. Never let correctness rest on a filename.
    '-f', 'image2',
    // One picture, not a numbered sequence.
    '-update', '1',
    '-y', tmpPath,
  ];
  let child;
  const donePromise = new Promise((resolvePromise) => {
    child = spawnFn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', () => resolvePromise(false));
    child.once('close', (code) => resolvePromise(code === 0));
  });
  // Best effort: a thumbnail cut competing with recording and detection for
  // CPU should lose that fight. Not every platform grants this, so a refusal
  // here is silently ignored rather than failing the whole cut.
  try {
    if (child?.pid !== undefined) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch { /* niceness is not available everywhere */ }
  const exitedClean = await donePromise;
  return exitedClean && (await exists(tmpPath));
}

/**
 * The cutter behind the Review page's thumbnails.
 *
 * `get(eventId)` resolves to `{ ok: true, file }` (an absolute path to a JPEG
 * under `stateDir`) or a refusal `{ ok: false, status, code, message }`.
 * `close()` stops accepting new cuts and lets the ones already running finish
 * without starting any more from the queue.
 */
export function createEventCrops({
  stateDir,
  eventsDb,
  index,
  config,
  driveAssignment,
  now,
  spawnFn = spawn,
  maxConcurrent = 2,
  maxFiles = 2000,
}) {
  const cropsDir = join(stateDir, CROPS_DIR);
  let dirReady = null;
  function ensureDir() {
    if (dirReady === null) dirReady = mkdir(cropsDir, { recursive: true });
    return dirReady;
  }

  let active = 0;
  let closed = false;
  let tmpSeq = 0;
  const queue = [];

  /** Run `task` now if a slot is free, else queue it, else refuse busy. Never
   *  more than `maxConcurrent` tasks running, never more than MAX_QUEUE
   *  waiting behind them — the two together are the whole of the bound. */
  function schedule(task) {
    if (closed) return Promise.resolve(refuse(503, 'busy'));
    return new Promise((resolvePromise) => {
      const start = () => {
        active += 1;
        task().then(resolvePromise, () => resolvePromise(refuse(500, 'crop_failed')))
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) next.start();
          });
      };
      if (active < maxConcurrent) {
        start();
      } else if (queue.length < MAX_QUEUE) {
        queue.push({ start, resolvePromise });
      } else {
        resolvePromise(refuse(503, 'busy'));
      }
    });
  }

  /** Every cached crop file for this event except `keepName`, oldest or not —
   *  an event has exactly one current crop, cached under its current bestMs. */
  async function removeStaleCrops(eventId, keepName) {
    let names;
    try {
      names = await readdir(cropsDir);
    } catch {
      return;
    }
    const prefix = `${eventId}__`;
    await Promise.all(
      names
        .filter((n) => n.startsWith(prefix) && n !== keepName)
        .map((n) => rm(join(cropsDir, n), { force: true }).catch(() => {})),
    );
  }

  /** Keep the cache under maxFiles by deleting the oldest (by mtime) crops.
   *  Crops live only under stateDir, never on a recording drive, so this
   *  never touches config.storeRoots. */
  async function enforceMaxFiles() {
    let names;
    try {
      names = await readdir(cropsDir);
    } catch {
      return;
    }
    if (names.length <= maxFiles) return;
    const withTimes = await Promise.all(names.map(async (name) => {
      try {
        const st = await stat(join(cropsDir, name));
        return { name, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    }));
    const alive = withTimes.filter((v) => v !== null).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const overBy = alive.length - maxFiles;
    for (let i = 0; i < overBy; i += 1) {
      await rm(join(cropsDir, alive[i].name), { force: true }).catch(() => {});
    }
  }

  /** Steps 3-6 of the behaviour: resolve the frame, measure it, plan the crop
   *  and cut it. Runs only inside `schedule`, so it is never called more than
   *  `maxConcurrent` times at once. */
  async function cutCrop(event, bestMs) {
    const segmentsAll = index.forCamera(event.cameraId);
    const gapsAll = index.gapsFor(event.cameraId);
    const resolution = resolvePlayback(event.cameraId, segmentsAll, gapsAll, event.bestUtc, now().toISOString());

    if (resolution.kind === 'gap' || resolution.kind === 'future') {
      return refuse(409, 'footage_gone');
    }
    if (resolution.kind === 'recording') {
      return refuse(409, 'segment_open');
    }

    // resolution.kind === 'segment'. Re-fetch the row for its `root`, the way
    // api-server.mjs's /segments route does — resolvePlayback's own return
    // value carries no root, only the path relative to it.
    const startMs = Date.parse(resolution.segmentStartUtc);
    const row = index.getByKey(event.cameraId, startMs);
    if (!row) {
      return refuse(409, 'footage_gone');
    }
    if (row.state === 'open') {
      return refuse(409, 'segment_open');
    }
    const absPath = join(rootOf(row, event.cameraId, { config, driveAssignment }), row.path);

    const size = await probeFrameSize(spawnFn, absPath);
    if (size === null) {
      return refuse(500, 'crop_failed');
    }
    const rect = planCrop(event.bestBox, size);
    if (!rect.ok) {
      return refuse(500, 'crop_failed', rect.message);
    }

    await ensureDir();
    const finalName = cropFileName(event.id, bestMs);
    const finalPath = join(cropsDir, finalName);
    // pid + a per-process counter: unique across processes AND across two
    // concurrent cuts of the very same event within one process.
    const tmpPath = join(cropsDir, `${finalName}.${process.pid}.${tmpSeq++}.tmp`);

    const cut = await cutFrame(spawnFn, { absPath, offsetSeconds: resolution.offsetSeconds, rect, tmpPath });
    if (!cut) {
      await rm(tmpPath, { force: true }).catch(() => {});
      return refuse(500, 'crop_failed');
    }
    await rename(tmpPath, finalPath);
    await removeStaleCrops(event.id, finalName);
    await enforceMaxFiles();
    return { ok: true, file: finalPath };
  }

  async function get(eventId) {
    // A recorder with no detector has no events database at all (api-server
    // opens it lazily and leaves it null when the file does not exist). That
    // is an ordinary state, not a fault: answer "no such event" rather than
    // throwing, which the route would otherwise have to dress up as a 500.
    if (eventsDb === null || eventsDb === undefined) return refuse(404, 'no_such_event');
    const event = eventsDb.getById(eventId);
    if (!event) return refuse(404, 'no_such_event');

    const bestMs = Date.parse(event.bestUtc);
    const finalPath = join(cropsDir, cropFileName(event.id, bestMs));
    if (await exists(finalPath)) {
      return { ok: true, file: finalPath };
    }

    return schedule(() => cutCrop(event, bestMs));
  }

  /** Stop taking new work. Anything already running is left to finish;
   *  anything only queued is refused now, rather than left to hang forever
   *  waiting for a slot that will never open back up. */
  function close() {
    closed = true;
    while (queue.length > 0) {
      const waiting = queue.shift();
      waiting.resolvePromise(refuse(503, 'busy'));
    }
  }

  return { get, close };
}
