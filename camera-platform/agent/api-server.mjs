// agent/api-server.mjs
//
// This file implements the HTTP transport slice for A2.
// It follows the same style as recorder-service.mjs, using only Node built‑ins
// and the pure contracts from ../dist/*.js.  All responses are JSON
// envelopes; errors are mapped to the codes defined in the spec.  Unexpected
// errors are logged as a single JSON line (level: error) and returned as a
// generic server_error envelope.  No stack traces are sent to the client.

import { createServer } from 'node:http';
import { stat, readFile, writeFile, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';

import { loadConfig, resolveCameraUrl } from './recorder-service.mjs';
import { attachLive, closeAll } from './live.mjs';
import { openIndex } from './segindex.mjs';
import { readHealth, alertsResponse } from './alerts-run.mjs';
import { gatherHealthFacts, cameraFacts } from './healthfacts.mjs';
import { indexPathFor, DEFAULT_PATHS, assignCamerasToDrives } from './config.mjs';
import { runEventRetention, EVENT_RETENTION_INTERVAL_MS } from './event-retention.mjs';
import { startNetworkFacts } from './network-facts.mjs';
import { discoverSadp } from './sadp.mjs';
import { discoverOnvif } from './wsdiscovery.mjs';

// The pure contracts, compiled. Refusals are VALUES (ok === false), not
// exceptions — detect them by shape, never by instanceof (they are interfaces,
// with no runtime identity).
import { parseWindow, parseInstant, parseSegmentId, isCameraId } from '../dist/apiQuery.js';
import { parseEventKinds, parseEventLimit, EVENT_LIMIT_MAX } from '../dist/eventQuery.js';
import { openEventsDb, HIDDEN_MODES } from './events-db.mjs';
import { createKnownObjectsStore } from './known-objects.mjs';
import { knownObjectNotice, answerKnownObject } from '../dist/knownObjects.js';
import { planByteRange, ByteRangeError } from '../dist/httpRange.js';
import { coverageFromIndex, resolvePlayback, IndexCoverageError } from '../dist/indexCoverage.js';
import { cameraView } from '../dist/cameraView.js';
import { groupCamerasByDevice } from '../dist/cameraGroups.js';
import { siteHealth } from '../dist/siteHealth.js';
import { planExport } from '../dist/exportPlan.js';
import { streamExport } from './exportStream.mjs';
import { decideRoute, ruleFor, safeNext } from '../dist/routeAccess.js';
import { createAuth } from './auth.mjs';
import { createCameraSettings } from './camera-settings.mjs';
import { createRecordingSettings } from './recording-settings.mjs';
import { createClipLibrary, LIBRARY_FILE } from './clip-library.mjs';
import { createListeners } from './listeners.mjs';
import { checkLibrary } from '../dist/clipLibrary.js';
import { THUMB_WIDTH } from '../dist/eventThumb.js';
import { proposeTeachMoments, parseDay } from '../dist/teachCandidates.js';
// clipProgress is agent/ui/review-client.mjs's own pure export (zero imports,
// same file the Review page and its harness already load) -- reused as-is
// for GET /teach-moments' `library` totals rather than re-summing the answer
// key a second way.
import { clipProgress } from './ui/review-client.mjs';

// event-crop.mjs cuts the JPEG /event-crop serves (see contracts/eventThumb.ts
// for where the rectangle comes from). It is a sibling file another agent
// writes in parallel with this one, so the import is dynamic and tolerant: a
// static `import ... from './event-crop.mjs'` would throw at module load and
// take every route in this file down with it the moment that file does not
// exist yet. Missing, the route below degrades to "not installed" instead.
let defaultCreateEventCrops = null;
try {
  ({ createEventCrops: defaultCreateEventCrops } = await import('./event-crop.mjs'));
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

const isRefusal = (r) => r !== null && typeof r === 'object' && r.ok === false;

/**
 * The id detectStream.ts mints for a detection event: `<cameraId>:<atMs>:<seq>`.
 * This id reaches a file path in the crop cache (event-crop.mjs), so it is the
 * only shape /event-crop accepts — checked here, before the id is looked up
 * anywhere, never after. A camera id outside CAMERA_ID_PATTERN, a non-digit or
 * signed `atMs`, a zero or non-digit `seq`, an extra `:`-separated field or
 * trailing text are all refused rather than passed through and hoped about.
 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}:(?:0|[1-9][0-9]*):[1-9][0-9]*$/;

function isEventId(raw) {
  return typeof raw === 'string' && EVENT_ID_PATTERN.test(raw);
}

/**
 * The `hidden` param on GET /events: whether suppressed (known-object) events
 * are excluded, included, or the only ones shown. Validated the same shape as
 * parseEventKinds (contracts/eventQuery.ts) — a value this server does not
 * recognise is refused, never silently read as one of the three, because
 * "exclude" for an unrecognised mode would quietly hide events an operator
 * asked to see, and "include" for one would un-hide events they asked to have
 * filtered out. Blank or absent means "include", matching events-db.mjs's own
 * default (inRange) so every caller written before suppression existed keeps
 * seeing everything; the Review page passes "exclude" itself when it wants the
 * quieter view (agent/ui/review.html).
 */
function parseHiddenMode(raw) {
  if (raw === null || raw === undefined) return 'include';
  if (typeof raw !== 'string') {
    return { ok: false, status: 400, code: 'bad_hidden', message: `hidden must be a string, not a ${typeof raw}` };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return 'include';
  if (!HIDDEN_MODES.includes(trimmed)) {
    return { ok: false, status: 400, code: 'bad_hidden', message: `unknown hidden mode: ${JSON.stringify(trimmed)}; allowed: ${HIDDEN_MODES.join(', ')}` };
  }
  return trimmed;
}

const KNOWN_OBJECTS_BODY_BYTES = 16 * 1024;

/**
 * A JSON object body for POST /known-objects/answer, or a refusal already
 * sent (returns null). The same shape as the other owners' body readers
 * (agent/auth.mjs, agent/camera-settings.mjs) — this file duplicates it
 * rather than importing theirs, matching how each of those already
 * duplicates it rather than sharing one: one owner per file (rule 3), and a
 * shared helper would give this route a dependency on a module it does not
 * own.
 */
async function readKnownObjectsBody(req, res) {
  if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    sendError(res, 415, 'json_required', 'send application/json');
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > KNOWN_OBJECTS_BODY_BYTES) {
      sendError(res, 413, 'body_too_large', 'request body too large');
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    sendError(res, 400, 'bad_json', 'the request body is not JSON');
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'bad_json', 'the request body must be a JSON object');
    return null;
  }
  return body;
}

// The UI routes → files under agent/ui. A map, not string handling of the
// pathname: only these exact paths ever reach the filesystem.
const UI_FILES = {
  '/': 'index.html',
  '/ui/live-client.js': 'live-client.mjs',
  '/review': 'review.html',
  '/ui/review-client.js': 'review-client.mjs',
  '/teach': 'teach.html',
  '/ui/teach-client.js': 'teach-client.mjs',
  '/ui/alert-banner.js': 'alert-banner.mjs',
  '/system': 'system.html',
  '/ui/system-client.js': 'system-client.mjs',
  '/ui/wall-client.js': 'wall-client.mjs',
  '/login': 'login.html',
  '/ui/login-client.js': 'login-client.mjs',
  '/accounts-page': 'accounts.html',
  '/ui/accounts-client.js': 'accounts-client.mjs',
  '/cameras-page': 'cameras.html',
  '/recording-page': 'recording.html',
  '/network-page': 'network.html',
  '/ui/cameras-client.js': 'cameras-client.mjs',
  '/ui/recording-client.js': 'recording-client.mjs',
  '/ui/network-client.js': 'network-client.mjs',
  '/ui/session.js': 'session-bar.mjs',
};

// Compiled contracts the browser runs directly, served from dist rather than
// copied into ui. The live wall's layout maths has to be the SAME code the
// harness proves: a copy under ui would drift from it silently, and the first
// symptom would be a wall laying out cells the contract never agreed to. The
// relative path holds in both trees -- agent/../dist in the checkout, and
// /opt/camplat/agent/../dist on the appliance.
//
// Both are .mts so tsc emits ES modules: the rest of dist is CommonJS, which
// Node imports happily and a browser refuses ("exports is not defined"), and
// the Live page drew nothing at all.
const UI_CONTRACTS = {
  '/ui/grid-layout.js': 'gridLayout.mjs',
  '/ui/playback.js': 'playback.mjs',
};

const sendError = (res, status, code, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, code, message }));
};

// A person who followed a link to a page their account may not open gets a
// page that says so, not a line of JSON. Fixed text: nothing from the request
// is echoed into it.
const REFUSED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not for this account</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111317;color:#e8eaed;font:15px/1.5 system-ui,sans-serif}
main{max-width:320px;padding:16px;text-align:center}a{color:#8ab4f8}</style></head>
<body><main><h1 style="font-size:18px">This account cannot open that page</h1>
<p>Ask the installer if you need it.</p><p><a href="/">Back to live</a></p></main></body></html>
`;

/**
 * The shared first half of GET /export and GET /export/plan: read the query,
 * validate it and plan the export. It writes NOTHING to any response, so the
 * two routes cannot disagree about what a range holds.
 * `ctx` is { config, index, now, driveAssignment }, as createApiServer holds them.
 *
 * Returns either a refusal { ok: false, status, code, message } or
 * { ok: true, camera, effective, nowUtc, plan }, keys in those orders.
 *
 * 1. const nowUtc = ctx.now().toISOString(). Take the clock ONCE and use this
 *    value everywhere below.
 * 2. const camera = parsedUrl.searchParams.get('camera'). If !isCameraId(camera):
 *    return { ok: false, status: 400, code: 'bad_camera_id', message: 'Invalid camera id' }.
 * 3. const windowResult = parseWindow({ start, end, buckets: null }, nowUtc), with
 *    start and end from parsedUrl.searchParams.get. If isRefusal(windowResult):
 *    return { ok: false, status: windowResult.status, code: windowResult.code,
 *    message: windowResult.message }. Otherwise const effective = windowResult.effective.
 * 4. const segments = ctx.index.inRange(camera, effective.startUtc, effective.endUtc);
 *    const gaps = ctx.index.gapsFor(camera). (The same reads /timeline makes.)
 * 5. Call planExport(camera, segments, gaps, effective, nowUtc) inside try/catch.
 *    If it throws an IndexCoverageError (instanceof): return { ok: false,
 *    status: 500, code: 'index_state_invalid', message: e.message }. Rethrow
 *    any other error.
 * 6. If isRefusal(plan): return { ok: false, status: plan.status, code: plan.code,
 *    message: plan.message }.
 * 7. return { ok: true, camera, effective, nowUtc, plan }.
 */
function prepareExport(parsedUrl, ctx) {
  const nowUtc = ctx.now().toISOString();
  const camera = parsedUrl.searchParams.get('camera');
  if (!isCameraId(camera)) {
    return { ok: false, status: 400, code: 'bad_camera_id', message: 'Invalid camera id' };
  }
  const start = parsedUrl.searchParams.get('start');
  const end = parsedUrl.searchParams.get('end');
  const windowResult = parseWindow({ start, end, buckets: null }, nowUtc);
  if (isRefusal(windowResult)) {
    return { ok: false, status: windowResult.status, code: windowResult.code, message: windowResult.message };
  }
  const effective = windowResult.effective;
  const segments = ctx.index.inRange(camera, effective.startUtc, effective.endUtc);
  const gaps = ctx.index.gapsFor(camera);
  let plan;
  try {
    plan = planExport(camera, segments, gaps, effective, nowUtc);
  } catch (e) {
    if (e instanceof IndexCoverageError) {
      return { ok: false, status: 500, code: 'index_state_invalid', message: e.message };
    }
    throw e;
  }
  if (isRefusal(plan)) {
    return { ok: false, status: plan.status, code: plan.code, message: plan.message };
  }
  return { ok: true, camera, effective, nowUtc, plan };
}

/**
 * GET /export?camera=&start=&end= : one camera's range, downloaded as a
 * store-only ZIP of whole segments plus manifest.json. See EXPORT-SPEC.md §3.
 * `ctx` is { config, index, now, driveAssignment }, as createApiServer holds them.
 *
 * THE FEARED FAILURE: a download that completes as a valid-looking archive
 * while carrying less than it claims. So every refusal goes out as a JSON
 * envelope BEFORE the ZIP's headers, and once the ZIP has begun, any failure
 * destroys the response instead of ending it.
 *
 * 1. const prep = prepareExport(parsedUrl, ctx). If prep.ok is false:
 *    sendError(res, prep.status, prep.code, prep.message) and return.
 *    Otherwise const { camera, effective, nowUtc, plan } = prep.
 * 2. const filename = `${camera}_${effective.startUtc}_${effective.endUtc}.zip`
 *    with EVERY ':' replaced by '-'. Then
 *    res.writeHead(200, { 'Content-Type': 'application/zip',
 *      'Content-Disposition': `attachment; filename="${filename}"`,
 *      'Cache-Control': 'no-store' }).
 *    No Content-Length: a body cut off mid-stream must not look complete.
 * 3. Each file resolves on the drive its row recorded (rootOf).
 *    In try/catch:
 *      await streamExport(res, plan, { resolvePath: (p) => join(root, p),
 *        siteId: ctx.config.siteId, generatedAtUtc: nowUtc });
 *      res.end();
 *    On ANY error: log('warn', 'export aborted', { cameraId: camera,
 *    code: e.code ?? null, error: e.message }), then res.destroy(). Do not
 *    rethrow and do not call sendError (the headers are already sent).
 *
 * Returns a Promise that resolves once the response has been ended or destroyed.
 */
/**
 * The drive a segment is on: the one it recorded, when that drive is still
 * configured; otherwise (rows from before segments recorded it) where its
 * camera is assigned now.
 */
function rootOf(segment, cameraId, ctx) {
  if (typeof segment?.root === 'string' && ctx.config.storeRoots.includes(segment.root)) return segment.root;
  return ctx.config.storeRoots[ctx.driveAssignment.get(cameraId) ?? 0];
}

/* ================= the teach list (TEACH-LIST-SPEC.md, pieces 2-3) ================= */

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * This day's gate windows (agent/detect-service.mjs, piece 1), this camera
 * only. One file holds every camera's minutes, so this filters on read
 * rather than needing a per-camera file. Missing entirely -- the gate has
 * never run, or is off, or piece 1 is not installed on this checkout yet --
 * reads as a day with no gate data at all: proposeTeachMoments already says
 * so in `notes`, so this never turns a missing file into a 500. A torn last
 * line (an append caught mid-write by a crash) is skipped, not fatal either.
 */
async function readGateWindowsForDay(stateDir, dayStartUtc, cameraId) {
  const dayKey = dayStartUtc.slice(0, 10);
  const file = join(stateDir, 'gate-windows', `${dayKey}.jsonl`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const windows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj !== null && typeof obj === 'object' && obj.cameraId === cameraId) windows.push(obj);
  }
  return windows;
}

/**
 * The read-only half of clip-library.mjs's own `load()` (that function is
 * private to its module -- one owner per file, rule 3 -- and clip-library.mjs
 * is not this route's to edit). A library that cannot be read or does not
 * check out answers as empty rather than throwing: exactly what
 * proposeTeachMoments treats "no answer key yet" as, and never something this
 * route should turn into a 500 for what is, on a fresh box, the normal case.
 */
async function loadClipLibraryForRead(stateDir) {
  const empty = { version: 1, clips: [] };
  let text;
  try {
    text = await readFile(join(stateDir, LIBRARY_FILE), 'utf8');
  } catch {
    return empty;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  const checked = checkLibrary(raw);
  return checked.ok ? checked.library : empty;
}

/**
 * This camera's recorded spans that still exist, merged: consecutive or
 * overlapping sealed segments join into one span so a moment spanning a
 * segment boundary is not wrongly refused as "partly gone". An open segment
 * (still being written) never counts as footage that "still exists" here --
 * /still refuses it the same way /segments/:id does, as not yet sealed.
 */
function footageSpansFor(segments) {
  const sealed = segments
    .filter((s) => s.state !== 'open' && s.endUtc !== null)
    .map((s) => ({ startMs: Date.parse(s.startUtc), endMs: Date.parse(s.endUtc) }))
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const spans = [];
  for (const seg of sealed) {
    const last = spans[spans.length - 1];
    if (last !== undefined && seg.startMs <= last.endMs) {
      if (seg.endMs > last.endMs) last.endMs = seg.endMs;
    } else {
      spans.push({ startMs: seg.startMs, endMs: seg.endMs });
    }
  }
  return spans.map((s) => ({ startUtc: new Date(s.startMs).toISOString(), endUtc: new Date(s.endMs).toISOString() }));
}

const STILL_MESSAGES = {
  footage_gone: 'the recording for that moment is no longer on this recorder',
  segment_open: 'the recording for that moment is still being written',
  still_in_future: 'that moment has not happened yet',
  crop_failed: 'the still could not be cut',
  busy: 'too many stills are already being cut; try again shortly',
};

function refuseStill(status, code, message = STILL_MESSAGES[code] ?? code) {
  return { ok: false, status, code, message };
}

/**
 * Which physical device `camera` belongs to, and the OTHER stream on that
 * device configured as the main stream, if any -- reusing cameraGroups.ts's
 * own device grouping (host + channel) rather than a second way to tell two
 * streams of one camera apart. Null when `camera` is unknown, stands alone,
 * or has no main-stream sibling.
 */
function mainStreamSiblingId(camera, config) {
  if (!config.cameras.some((c) => c.cameraId === camera)) return null;
  const views = config.cameras.map((cam) => cameraView(cam, resolveCameraUrl(cam, config.credentials), null));
  const device = groupCamerasByDevice(views).find((d) => d.streams.some((s) => s.cameraId === camera));
  if (device === undefined) return null;
  const mainStream = device.streams.find((s) => {
    if (s.cameraId === camera) return false;
    const cfg = config.cameras.find((c) => c.cameraId === s.cameraId);
    return cfg !== undefined && (cfg.stream ?? 'main') === 'main';
  });
  return mainStream === undefined ? null : mainStream.cameraId;
}

/**
 * Which camera's footage to cut the still from, and where: the main stream
 * of the same device when IT has a SEALED segment at this instant ("main
 * stream if recorded" -- TEACH-LIST-SPEC.md piece 3), else the camera
 * actually asked for. resolvePlayback's `segment` kind already means sealed
 * (an open segment resolves to `recording`, never `segment`), so nothing
 * further needs to check the row's state here.
 */
function resolveStillSource(camera, atUtc, nowUtc, ctx) {
  const resolveFor = (id) => resolvePlayback(id, ctx.index.forCamera(id), ctx.index.gapsFor(id), atUtc, nowUtc);
  const mainId = mainStreamSiblingId(camera, ctx.config);
  if (mainId !== null) {
    const mainResolution = resolveFor(mainId);
    if (mainResolution.kind === 'segment') return { cameraId: mainId, resolution: mainResolution };
  }
  return { cameraId: camera, resolution: resolveFor(camera) };
}

/**
 * Cut one frame at `offsetSeconds` into `absPath`, scaled to THUMB_WIDTH, no
 * box (a still is the raw recording, not a detection marker -- contrast
 * event-crop.mjs's drawbox), into `tmpPath`. True only on a zero exit AND a
 * file actually written, the same discipline event-crop.mjs's cutFrame uses:
 * ffmpeg exiting 0 with nothing written is a failure, not an empty "still".
 */
async function cutStillFrame(spawnFn, { absPath, offsetSeconds, tmpPath }) {
  const args = [
    '-ss', String(offsetSeconds),
    '-i', absPath,
    '-frames:v', '1',
    '-vf', `scale=${THUMB_WIDTH}:-2`,
    '-q:v', '5',
    '-f', 'image2',
    '-update', '1',
    '-y', tmpPath,
  ];
  let child;
  const donePromise = new Promise((resolvePromise) => {
    child = spawnFn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', () => resolvePromise(false));
    child.once('close', (code) => resolvePromise(code === 0));
  });
  // Best effort, same as event-crop.mjs: a still cut competing with recording
  // and detection for CPU should lose that fight; not every platform grants
  // this, so a refusal here is silently ignored rather than failing the cut.
  try {
    if (child?.pid !== undefined) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch { /* niceness is not available everywhere */ }
  const exitedClean = await donePromise;
  return exitedClean && (await pathExists(tmpPath));
}

async function serveExport(res, parsedUrl, ctx) {
  const prep = prepareExport(parsedUrl, ctx);
  if (!prep.ok) {
    sendError(res, prep.status, prep.code, prep.message);
    return;
  }
  const { camera, effective, nowUtc, plan } = prep;
  const filename = `${camera}_${effective.startUtc}_${effective.endUtc}.zip`.replace(/:/g, '-');
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  try {
    await streamExport(res, plan, { resolvePath: (p) => join(rootOf(ctx.index.get(p), camera, ctx), p), siteId: ctx.config.siteId, generatedAtUtc: nowUtc });
    res.end();
  } catch (e) {
    log('warn', 'export aborted', { cameraId: camera, code: e.code ?? null, error: e.message });
    res.destroy();
  }
}


/**
 * GET /export/plan?camera=&start=&end= : what GET /export would deliver for
 * the same query, as JSON, without sending any footage. The review page shows
 * this before it offers the download link.
 *
 * THE FEARED FAILURE: the storage layout reaching the browser. The plan's
 * files carry `path`, `segmentId` and `name`; none of them is sent. Build the
 * body field by field, never by spreading the plan or its files.
 *
 * 1. const prep = prepareExport(parsedUrl, ctx). If prep.ok is false:
 *    sendError(res, prep.status, prep.code, prep.message) and return.
 * 2. const plan = prep.plan. The body, keys in this order:
 *    { ok: true, cameraId: plan.cameraId,
 *      requested: { startUtc: plan.requested.startUtc, endUtc: plan.requested.endUtc },
 *      delivered: { startUtc: plan.delivered.startUtc, endUtc: plan.delivered.endUtc },
 *      fileCount: plan.files.length, totalBytes: plan.totalBytes,
 *      recordedSeconds: plan.recordedSeconds, gapSeconds: plan.gapSeconds,
 *      gaps: plan.gaps mapped to { startUtc, endUtc, reason, source } }
 * 3. res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
 *    res.end(JSON.stringify(body)).
 */
function serveExportPlan(res, parsedUrl, ctx) {
  const prep = prepareExport(parsedUrl, ctx);
  if (!prep.ok) {
    sendError(res, prep.status, prep.code, prep.message);
    return;
  }
  const plan = prep.plan;
  const body = {
    ok: true,
    cameraId: plan.cameraId,
    requested: {
      startUtc: plan.requested.startUtc,
      endUtc: plan.requested.endUtc,
    },
    delivered: {
      startUtc: plan.delivered.startUtc,
      endUtc: plan.delivered.endUtc,
    },
    fileCount: plan.files.length,
    totalBytes: plan.totalBytes,
    recordedSeconds: plan.recordedSeconds,
    gapSeconds: plan.gapSeconds,
    gaps: plan.gaps.map(g => ({
      startUtc: g.startUtc,
      endUtc: g.endUtc,
      reason: g.reason,
      source: g.source,
    })),
  };
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * A request that changes something must come from a page this box served.
 * SameSite=Strict already keeps the cookie off a cross-site request; this is
 * the second lock, for browsers and proxies that get SameSite wrong. A form
 * post cannot send application/json without a CORS preflight, which this
 * server never answers, and Origin / Sec-Fetch-Site name the page that sent it.
 */
export function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createApiServer({
  // Required: see the check below.
  auth,
  stateDir,
  config,
  index,
  now = () => new Date(),
  // The live transport hangs off THIS server. spawnFn is injectable so the
  // harness runs the real WS edge against a fake ffmpeg; the caps are the
  // appliance's stream budget (per camera / total).
  spawnFn = spawn,
  // Live caps (live.mjs): camera sessions per camera, camera sessions on the
  // box, and viewers. Viewers share a camera's session, so a 3-TV x 9-tile
  // site is 27 viewers on at most one session per camera and quality.
  maxSourcesPerCamera = 2,
  maxSources = 32,
  maxViewers = 128,
  // Injectable so a harness can prove /event-crop's own wiring (id checks,
  // header shape, refusal mapping) with a fake cutter, the same way spawnFn
  // above lets it prove live.mjs without a real ffmpeg.
  createEventCrops = defaultCreateEventCrops,
  // The route policy (contracts/routeAccess.ts, compiled to decideRoute):
  // real and unconditional in every deployment. Overridable ONLY so
  // harness/knownObjectsApi.harness.mjs (this file's own suite) can prove
  // GET /known-objects and POST /known-objects/answer end to end before
  // routeAccess.ts carries a rule for them. Adding that rule is not a change
  // to this file (build rule 3, one owner per file, and five agents share
  // this checkout right now) — see the report. Passing anything here outside
  // a test would turn off every other route's protection too, so nothing in
  // this file ever does.
  decideRouteImpl = decideRoute,
  // Injectable so a harness can prove the events-retention TIMER wiring
  // itself (runs once at start, ticks on its own schedule, never overlaps,
  // stops on closeEventRetention) in bounded time, the same way spawnFn above
  // lets it prove live.mjs without a real ffmpeg's real timing. Every real
  // deployment gets the real EVENT_RETENTION_INTERVAL_MS (5 minutes);
  // nothing in this file ever passes anything else outside a test.
  eventRetentionIntervalMs = EVENT_RETENTION_INTERVAL_MS,
  // The Network page (NETWORK-PAGE-SPEC.md) starts real samplers the instant
  // it is constructed — a DNS lookup, TCP connects to 1.1.1.1/8.8.8.8 and to
  // every configured camera's host. THIS FILE IS BUILT BY createApiServer()
  // FROM DOZENS OF OTHER HARNESSES that know nothing about the network page,
  // so it must default OFF: only a caller that explicitly asks for it (the
  // real bootstrap below, or a harness supplying full fakes) ever causes a
  // packet to leave the process. `networkFactsOverrides` lets that harness
  // replace every I/O source (execFile, readFile, dns, tcp connect, the two
  // discovery protocols) with fakes that record their own destinations.
  networkFactsEnabled = false,
  networkFactsOverrides = {},
}) {
  // No auth, no server. A default here would be an open recorder the first
  // time someone forgot to pass one.
  if (auth === null || typeof auth !== 'object' || typeof auth.principalOf !== 'function' || typeof auth.handle !== 'function') {
    throw new TypeError('createApiServer needs auth (from createAuth)');
  }

  const assignDrives = () => assignCamerasToDrives(
    config.cameras.map((c) => c.cameraId),
    config.storeRoots.length
  );
  // Recomputed when the Cameras page changes the list, as the recorder does on restart.
  let driveAssignment = assignDrives();
  const cameraSettings = createCameraSettings({
    stateDir, config, audit: auth.audit, log,
    onChange: () => { driveAssignment = assignDrives(); },
  });
  const recordingSettings = createRecordingSettings({ stateDir, index, now, audit: auth.audit, log });

  // The Network page's own samplers (NETWORK-PAGE-SPEC.md): interface
  // counters, camera RTSP-port probes, and gateway/DNS/internet/clock checks.
  // Started here, unref()'d inside startNetworkFacts, and stopped by
  // server.closeNetworkFacts() below — the same pattern as the events
  // retention timer just above it in this file. Null when disabled (see
  // networkFactsEnabled above): the routes answer "not enabled" rather than
  // reach for a subsystem that was never allowed to touch the network.
  const networkFacts = networkFactsEnabled
    ? startNetworkFacts({
        config,
        index,
        stateDir,
        now,
        discoverSadpFn: discoverSadp,
        discoverOnvifFn: discoverOnvif,
        log,
        ...networkFactsOverrides,
      })
    : null;

  /**
   * The detector's events, opened on first use and kept open.
   *
   * The detector is a separate service and may not be installed at all. That
   * is NOT the same thing as a quiet day, and /events says which it is: an
   * empty list from a running detector means nobody walked past, an empty list
   * with `available: false` means nothing was ever watching. A Review page
   * that cannot tell them apart teaches an operator to trust an empty timeline
   * on a box where detection was never switched on.
   */
  let eventsDb = null;
  const eventsFile = join(stateDir, 'events.db');
  const openEvents = () => {
    if (eventsDb === null) {
      if (!existsSync(eventsFile)) return null;
      eventsDb = openEventsDb(eventsFile);
    }
    return eventsDb;
  };

  const clipLibrary = createClipLibrary({
    stateDir, audit: auth.audit, log,
    prepare: (camera, start, end) => {
      const q = new URLSearchParams({ camera, start, end });
      return prepareExport(new URL('http://x/?' + q.toString()), { config, index, now, driveAssignment });
    },
    rootFor: (file, cameraId) => rootOf(index.get(file.path), cameraId, { config, driveAssignment }),
  });

  // Known objects (agent/known-objects.mjs): the store the detector learns
  // into and camctl resets by hand. This route's own writes are the owner's
  // answer only — never a learn, a lapse or a match; those stay the
  // detector's (Austin's 2026-09-20 decision applies to hiding, not to this).
  // update() (not load-then-save) so a slow answer can never overwrite a
  // count the detector wrote in between; see agent/known-objects.mjs.
  const knownObjectsStore = createKnownObjectsStore({ stateDir });

  // /event-crop reads the SAME events handle /events reads — openEvents()
  // opens events.db lazily and at most once, and calling it here rather than
  // opening a second handle is the whole point. Not present (no detector was
  // ever installed here, or event-crop.mjs has not landed yet) is not an
  // error: the cutter itself is expected to answer every get() with a plain
  // 404 no_such_event rather than throw, so this route never needs to know
  // which reason it was.
  const eventCrops = createEventCrops
    ? createEventCrops({ stateDir, eventsDb: openEvents(), index, config, driveAssignment, now })
    : {
        get: async () => ({
          ok: false, status: 404, code: 'no_such_event',
          message: 'event crops are not installed on this box',
        }),
        close() {},
      };

  // GET /still's cache and concurrency bound (TEACH-LIST-SPEC.md piece 3).
  // Bounded the same way event-crop.mjs bounds its own cutter, but never
  // pruned by file count: a still is keyed by camera + instant, and the
  // teach page can only ever ask for the still of a moment it was shown, so
  // the cache's size is bounded by MAX_MOMENTS moments a day, not by every
  // event a busy camera ever stores.
  const stillsDir = join(stateDir, 'stills');
  let stillsDirReady = null;
  const ensureStillsDir = () => {
    if (stillsDirReady === null) stillsDirReady = mkdir(stillsDir, { recursive: true });
    return stillsDirReady;
  };

  // The comment above says this cache is never pruned by file count -- it is
  // never pruned by anything else either, so a box left running grows one
  // file here per moment the teach page was ever shown. Age it out instead,
  // the same 7 days agent/detect-service.mjs keeps gate-windows for. A
  // missing directory (nothing cut yet) and a file that disappears mid-sweep
  // (another request's tmp-then-rename, or a previous sweep) are both fine,
  // never an error; one bad stat/rm must not stop the rest of the sweep.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const STILLS_MAX_AGE_MS = 7 * ONE_DAY_MS;
  async function cleanOldStills() {
    const cutoffMs = now().getTime() - STILLS_MAX_AGE_MS;
    let names;
    try {
      names = await readdir(stillsDir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(stillsDir, name);
      try {
        const st = await stat(path);
        if (st.mtimeMs < cutoffMs) await rm(path, { force: true });
      } catch {
        // best effort: a concurrent writer or a previous sweep already
        // touched this file; either way there is nothing left to do here
      }
    }
  }
  // Once at startup, then once a day. unref()'d so a harness (or any short
  // script) that never calls closeStillsCleanup below does not hang waiting
  // on this timer -- the same reasoning as the live watchdog in live.mjs.
  cleanOldStills().catch(() => {});
  const stillsCleanupTimer = setInterval(() => { cleanOldStills().catch(() => {}); }, ONE_DAY_MS);
  stillsCleanupTimer.unref?.();

  /**
   * Events retention (EVENTS-RETENTION-SPEC.md): an event lives exactly as
   * long as its video. Once at start, then every 5 minutes, unref()'d for the
   * same reason the stills sweep above is -- a harness that never calls
   * closeEventRetention must not hang waiting on this timer.
   *
   * Every tick calls openEvents() fresh rather than closing over `eventsDb`
   * directly: openEvents() is the one lazy-open-or-reuse handle /events and
   * /event-crop already share, and it is what stays correct across
   * server.closeEvents() setting `eventsDb` back to null (see closeEvents
   * below) -- a tick after that either finds events.db still missing (skip,
   * same as no detector installed) or opens its OWN fresh handle, never one
   * this function is holding onto past its close.
   */
  let eventRetentionRunning = false;
  let eventRetentionDeletedSinceStart = 0;
  const eventRetentionFile = join(stateDir, 'event-retention.json');
  async function runEventRetentionPass() {
    // Never two runs at once: a first run over years of pre-existing events
    // (the 3,450-in-4-days case the spec measured) can still be batching when
    // the next tick arrives.
    if (eventRetentionRunning) return;
    eventRetentionRunning = true;
    try {
      const result = await runEventRetention({ eventsDb: openEvents(), index, now });
      if (result.deleted > 0) eventRetentionDeletedSinceStart += result.deleted;
      const state = { ...result, deletedSinceStart: eventRetentionDeletedSinceStart };
      try {
        await mkdir(stateDir, { recursive: true });
        const tmp = `${eventRetentionFile}.tmp`;
        await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
        await rename(tmp, eventRetentionFile);
      } catch (err) {
        log('error', 'event retention: could not write event-retention.json', { error: err.message });
      }
      if (result.error) {
        log('error', 'event retention failed', { error: result.error });
      } else if (result.deleted > 0) {
        // One line only when something actually happened -- a quiet box logs
        // nothing every five minutes forever.
        log('info', 'event retention deleted events whose video is gone', {
          deleted: result.deleted, deletedSinceStart: eventRetentionDeletedSinceStart,
        });
      }
    } catch (err) {
      // runEventRetention refuses (a value, not a throw) for anything it can
      // anticipate; this is the last-resort net for anything it cannot, so a
      // bug here costs a log line, never the server.
      log('error', 'event retention: unexpected error', { error: err?.message ?? String(err) });
    } finally {
      eventRetentionRunning = false;
    }
  }
  runEventRetentionPass().catch(() => {});
  const eventRetentionTimer = setInterval(() => { runEventRetentionPass().catch(() => {}); }, eventRetentionIntervalMs);
  eventRetentionTimer.unref?.();

  const STILLS_MAX_CONCURRENT = 2;
  const STILLS_MAX_QUEUE = 32;
  let stillsActive = 0;
  let stillsTmpSeq = 0;
  const stillsQueue = [];
  function scheduleStill(task) {
    return new Promise((resolvePromise) => {
      const start = () => {
        stillsActive += 1;
        task().then(resolvePromise, () => resolvePromise(refuseStill(500, 'crop_failed')))
          .finally(() => {
            stillsActive -= 1;
            const next = stillsQueue.shift();
            if (next) next();
          });
      };
      if (stillsActive < STILLS_MAX_CONCURRENT) {
        start();
      } else if (stillsQueue.length < STILLS_MAX_QUEUE) {
        stillsQueue.push(start);
      } else {
        resolvePromise(refuseStill(503, 'busy'));
      }
    });
  }

  async function cutStill(camera, atUtc, nowUtc, cacheName) {
    const source = resolveStillSource(camera, atUtc, nowUtc, { index, config, driveAssignment });
    const resolution = source.resolution;
    if (resolution.kind === 'future') return refuseStill(404, 'still_in_future');
    if (resolution.kind === 'recording') return refuseStill(404, 'segment_open');
    if (resolution.kind === 'gap') return refuseStill(404, 'footage_gone');
    const row = index.getByKey(source.cameraId, Date.parse(resolution.segmentStartUtc));
    if (!row) return refuseStill(404, 'footage_gone');
    // resolution.kind === 'segment' means sealed as of the forCamera()/gapsFor()
    // snapshot resolveStillSource read a moment ago; row is a fresh re-fetch by
    // key, the same two-step event-crop.mjs's cutCrop uses (and for the same
    // reason -- resolvePlayback's return carries no root, only a path relative
    // to one). Re-checking state here, not trusting the snapshot's kind, is
    // what event-crop.mjs and the /segments/:id route both do; this mirrors it.
    if (row.state === 'open') return refuseStill(404, 'segment_open');
    const absPath = join(rootOf(row, source.cameraId, { config, driveAssignment }), row.path);
    await ensureStillsDir();
    const finalPath = join(stillsDir, cacheName);
    const tmpPath = join(stillsDir, `${cacheName}.${process.pid}.${stillsTmpSeq++}.tmp`);
    const cut = await cutStillFrame(spawnFn, { absPath, offsetSeconds: resolution.offsetSeconds, tmpPath });
    if (!cut) {
      await rm(tmpPath, { force: true }).catch(() => {});
      return refuseStill(500, 'crop_failed');
    }
    await rename(tmpPath, finalPath);
    return { ok: true, file: finalPath };
  }

  const server = createServer(async (req, res) => {
    try {
      const { method, url } = req;
      const parsedUrl = new URL(url, `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;

      // ---------- access, before any route ----------
      // Default deny: routeAccess knows every route and what it needs. A route
      // added below without a line there is refused, not served.
      const principal = auth.principalOf(req);
      const decision = decideRouteImpl(principal, method, pathname);
      if (decision.kind === 'redirect') {
        res.writeHead(302, { Location: decision.location, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (decision.kind === 'refuse') {
        if (decision.status === 403 && method === 'GET' && ruleFor(method, pathname)?.kind === 'page') {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(REFUSED_PAGE);
          return;
        }
        sendError(res, decision.status, decision.code, decision.message);
        return;
      }
      if (method !== 'GET' && !sameOrigin(req)) {
        sendError(res, 403, 'cross_origin', 'this request did not come from this recorder\'s own pages');
        return;
      }

      // Already signed in: the login page has nothing to offer but a way back.
      if (pathname === '/login' && principal.kind !== 'anonymous') {
        res.writeHead(302, { Location: safeNext(parsedUrl.searchParams.get('next')), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (await auth.handle(req, res, pathname, principal)) return;
      if (await cameraSettings.handle(req, res, pathname, method, principal)) return;
      if (await recordingSettings.handle(req, res, pathname, method, principal)) return;
      if (await clipLibrary.handle(req, res, pathname, method, principal)) return;

      // ---------- POST /known-objects/answer ----------
      // "Is it meant to be there?" (KNOWN-OBJECTS-SPEC.md). This never changes
      // what is hidden (rule 11, and contracts/knownObjects.ts's own doc on
      // answerKnownObject): it only keeps the training label. Nobody is asked
      // before suppression applies (Austin, 2026-09-20); this is Austin
      // answering AFTER the fact, on his own schedule, not a gate on it.
      if (method === 'POST' && pathname === '/known-objects/answer') {
        const body = await readKnownObjectsBody(req, res);
        if (body === null) return;
        if (typeof body.id !== 'string' || body.id === '') {
          sendError(res, 400, 'bad_id', 'id is required');
          return;
        }
        if (typeof body.belongs !== 'boolean') {
          sendError(res, 400, 'bad_belongs', 'belongs must be true or false');
          return;
        }
        // Only a signed-in user (installer or store) ever reaches this route:
        // routeAccess.ts gates it on events.view, which no display carries
        // (contracts/access.ts) — so principal.username is always a real name
        // here, never null. Read fresh each attempt: update() may retry mutate
        // against newer content if the detector wrote in between.
        const by = principal.username;
        const nowUtc = now().toISOString();
        let answered = null;
        const result = await knownObjectsStore.update((objects) => {
          const target = objects.find((o) => o.id === body.id);
          if (!target) return null; // nothing to write; reported as not-found below
          answered = answerKnownObject(target, { belongs: body.belongs, by }, nowUtc);
          return objects.map((o) => (o.id === body.id ? answered : o));
        });
        if (!result.ok) {
          // unreadable: the file cannot be trusted right now (409 — try again
          // once it is fixed). busy: another writer kept winning the race
          // (503 — safe to retry). invalid/write_failed are this store or disk
          // refusing what should always check out; 500 either way.
          const status = result.code === 'unreadable' ? 409 : result.code === 'busy' ? 503 : 500;
          sendError(res, status, result.code, result.problem);
          return;
        }
        if (answered === null) {
          sendError(res, 404, 'no_such_known_object', 'no known object with that id');
          return;
        }
        auth.audit('known-object.answer', req, { actor: by, id: body.id, belongs: body.belongs });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, object: { ...answered, notice: knownObjectNotice(answered) } }));
        return;
      }

      // ---------- POST /network/discover ----------
      // "Look for cameras" (NETWORK-PAGE-SPEC.md): runs WS-Discovery and SADP
      // on the camera card, exactly as `camctl discover` does. Rate-limited to
      // once per 60s by network-facts.mjs itself, not by routeAccess — a
      // throttled call answers with the CACHED run rather than doing nothing.
      if (method === 'POST' && pathname === '/network/discover') {
        if (networkFacts === null) {
          sendError(res, 501, 'network_facts_disabled', 'the network page is not enabled on this server');
          return;
        }
        const result = await networkFacts.runDiscoverNow();
        if (result.throttled) {
          const retryAfterS = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': String(retryAfterS),
          });
          res.end(JSON.stringify({
            ok: false, code: 'rate_limited',
            message: `discovery already ran recently; try again in ${retryAfterS}s`,
            atUtc: result.cache?.atUtc ?? null,
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, atUtc: result.cache.atUtc, replies: result.cache.replies }));
        return;
      }

      // Every route past here reads; the table only lets GET through to them.
      if (method !== 'GET') {
        sendError(res, 404, 'no_such_route', 'No such route');
        return;
      }

      // ---------- /health ----------
      // This used to answer ok:true whenever the HTTP server could reply, so a
      // recorder that died on Tuesday, a store root that never mounted, and a
      // camera silent for three days all looked exactly like a working site.
      // The facts are now measured (healthfacts) and judged (siteHealth); green
      // is earned. The old fields are all still here, inside `totals`.
      if (pathname === '/health') {
        const facts = await gatherHealthFacts({
          config,
          index,
          healthFile: join(stateDir, 'health.json'),
          now,
          // resolveCameraUrl returns { kind: "unresolved" } — it does not throw.
          resolveOne: (cam) => resolveCameraUrl(cam, config.credentials),
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(siteHealth(facts)));
        return;
      }

      // ---------- /alerts ----------
      // Written by camplat-alerts.timer, not by this process. A missing,
      // corrupt or old file is answered as what it is (check: never,
      // unreadable, stale), never as a quiet empty list.
      if (pathname === '/alerts') {
        const raw = await readHealth(join(stateDir, 'alerts.json'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(alertsResponse(raw, now().toISOString())));
        return;
      }

      // ---------- /cameras ----------
      if (pathname === '/cameras') {
        // The config URLs carry camera passwords; cameraView alone decides what
        // the client sees. The transport adds no fields and catches nothing:
        // resolveCameraUrl reports an unresolvable camera as a value.
        // measuredKbps comes from the index, not from config — it is what the
        // camera actually sent, and it is the number retention is computed from.
        const measured = cameraFacts(index, config.cameras.map((c) => c.cameraId));
        const views = config.cameras.map((cam) =>
          cameraView(
            cam,
            resolveCameraUrl(cam, config.credentials),
            measured.get(cam.cameraId)?.measuredKbps ?? null,
          ));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(views));
        return;
      }

      // ---------- /devices ----------
      // The same cameras, folded back into the physical devices they belong to.
      // A two-stream camera is ONE thing on the wall; /cameras answers streams
      // and the grid would otherwise draw 16 tiles for an 8-camera store.
      if (pathname === '/devices') {
        const measured = cameraFacts(index, config.cameras.map((c) => c.cameraId));
        const views = config.cameras.map((cam) =>
          cameraView(
            cam,
            resolveCameraUrl(cam, config.credentials),
            measured.get(cam.cameraId)?.measuredKbps ?? null,
          ));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(groupCamerasByDevice(views)));
        return;
      }

      // ---------- /timeline ----------
      if (pathname === '/timeline') {
        const camera = parsedUrl.searchParams.get('camera');
        const start = parsedUrl.searchParams.get('start');
        const end = parsedUrl.searchParams.get('end');
        const buckets = parsedUrl.searchParams.get('buckets');

        if (!isCameraId(camera)) {
          const envelope = { ok: false, code: 'bad_camera_id', message: 'Invalid camera id' };
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(envelope));
          return;
        }

        const windowResult = parseWindow({ start, end, buckets }, now().toISOString());
        if (isRefusal(windowResult)) {
          sendError(res, windowResult.status, windowResult.code, windowResult.message);
          return;
        }
        const window = windowResult;

        const segments = index.inRange(
          camera,
          window.effective.startUtc,
          window.effective.endUtc
        );
        const gaps = index.gapsFor(camera);

        let coverage;
        try {
          coverage = coverageFromIndex(
            camera,
            segments,
            gaps,
            window.effective,
            now().toISOString(),
            index.earliestFor(camera)
          );
        } catch (e) {
          if (e instanceof IndexCoverageError) {
            const envelope = { ok: false, code: 'index_state_invalid', message: e.message };
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(envelope));
            return;
          }
          throw e;
        }

        const envelope = {
          ok: true,
          cameraId: camera,
          requested: window.requested,
          effective: window.effective,
          clippedToNow: window.clippedToNow,
          buckets: window.bucketCount,
          ...coverage,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
        return;
      }

      // ---------- /events ----------
      // What the detector found in a window, for the marks on the Review
      // timeline. Same window rules as /timeline, so the marks and the
      // coverage bar can never disagree about which day is on screen.
      if (pathname === '/events') {
        const camera = parsedUrl.searchParams.get('camera');
        const start = parsedUrl.searchParams.get('start');
        const end = parsedUrl.searchParams.get('end');

        if (!isCameraId(camera)) {
          sendError(res, 400, 'bad_camera_id', 'Invalid camera id');
          return;
        }
        const windowResult = parseWindow({ start, end, buckets: null }, now().toISOString());
        if (isRefusal(windowResult)) {
          sendError(res, windowResult.status, windowResult.code, windowResult.message);
          return;
        }
        const kinds = parseEventKinds(parsedUrl.searchParams.get('kinds'));
        if (isRefusal(kinds)) {
          sendError(res, kinds.status, kinds.code, kinds.message);
          return;
        }
        const limit = parseEventLimit(parsedUrl.searchParams.get('limit'));
        if (isRefusal(limit)) {
          sendError(res, limit.status, limit.code, limit.message);
          return;
        }
        // Known objects (KNOWN-OBJECTS-SPEC.md, owner D): which suppressed
        // events come back. "include" is the default so every caller written
        // before suppression existed — this route's own harness among them —
        // keeps seeing everything; the Review page asks for "exclude" itself.
        const hidden = parseHiddenMode(parsedUrl.searchParams.get('hidden'));
        if (isRefusal(hidden)) {
          sendError(res, hidden.status, hidden.code, hidden.message);
          return;
        }

        const { effective } = windowResult;
        const db = openEvents();
        if (db === null) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true, cameraId: camera, effective, available: false,
            events: [], truncated: false, hiddenCount: 0,
          }));
          return;
        }
        const found = db.inRange(camera, effective.startUtc, effective.endUtc, kinds, limit, null, { hidden });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, cameraId: camera, effective, available: true,
          events: found.events, truncated: found.truncated, hiddenCount: found.hiddenCount, limit,
        }));
        return;
      }

      // ---------- /known-objects ----------
      // What has been learned at this site: measurements, never a verdict
      // (rule 11) — knownObjectNotice says what a spot has done, and only the
      // owner's own answer (POST .../answer) ever says what it IS. `camera` is
      // optional: the Review page asks scoped to the camera on screen; camctl
      // and a future dashboard can ask for every camera at once.
      if (pathname === '/known-objects') {
        const camera = parsedUrl.searchParams.get('camera');
        if (camera !== null && !isCameraId(camera)) {
          sendError(res, 400, 'bad_camera_id', 'Invalid camera id');
          return;
        }
        const { objects, problem } = await knownObjectsStore.load();
        const scoped = camera === null ? objects : objects.filter((o) => o.cameraId === camera);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          objects: scoped.map((o) => ({ ...o, notice: knownObjectNotice(o) })),
          problem,
        }));
        return;
      }

      // ---------- /network ----------
      // Interfaces, connection checks, every configured camera's IP/MAC/
      // maker/model, and every OTHER device this box has seen without
      // scanning (NETWORK-PAGE-SPEC.md). Never a credential: gatherView()
      // only ever sees a camera's bare host, never its resolved URL.
      if (pathname === '/network') {
        if (networkFacts === null) {
          sendError(res, 501, 'network_facts_disabled', 'the network page is not enabled on this server');
          return;
        }
        const view = await networkFacts.gatherView();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(view));
        return;
      }

      // ---------- /event-crop ----------
      // A JPEG cut from the recording at one event's bestUtc/bestBox (see
      // contracts/eventThumb.ts): what fired, on the tile, without playing the
      // clip. THE MORNING THIS EXISTS FOR: a spray bottle on a shelf reported
      // as a person 77 times in 13 hours — finding that out cost an ffmpeg
      // cut, a file copy and someone looking at the picture; with the crop on
      // the tile it is a glance.
      if (pathname === '/event-crop') {
        const id = parsedUrl.searchParams.get('id');
        // Checked before anything else: this id reaches a file path in the
        // crop cache, so an unrecognised shape is hostile input, not a typo
        // to forgive. 400, never a lookup that answers "not found" for a
        // string that could never have named anything.
        if (!isEventId(id)) {
          sendError(res, 400, 'bad_event_id', 'Invalid event id');
          return;
        }
        const result = await eventCrops.get(id);
        if (!result.ok) {
          sendError(res, result.status, result.code, result.message);
          return;
        }
        const fileStat = await stat(result.file);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': fileStat.size,
          // A crop of a past moment never changes: nothing re-cuts the same
          // event, so a browser or proxy may keep this for a day.
          'Cache-Control': 'private, max-age=86400',
        });
        const stream = createReadStream(result.file);
        stream.on('error', () => {
          res.destroy();
        });
        stream.pipe(res);
        return;
      }

      // ---------- /playback ----------
      if (pathname === '/playback') {
        const camera = parsedUrl.searchParams.get('camera');
        const at = parsedUrl.searchParams.get('at');

        if (!isCameraId(camera)) {
          const envelope = { ok: false, code: 'bad_camera_id', message: 'Invalid camera id' };
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(envelope));
          return;
        }

        const atResult = parseInstant(at, 'at');
        if (isRefusal(atResult)) {
          sendError(res, atResult.status, atResult.code, atResult.message);
          return;
        }
        const atInstant = atResult;

        const segmentsAll = index.forCamera(camera);
        const gapsAll = index.gapsFor(camera);
        const resolution = resolvePlayback(
          camera,
          segmentsAll,
          gapsAll,
          atInstant.utc,
          now().toISOString()
        );

        // resolvePlayback's `path` is the storage layout, for the server only.
        // The browser plays through /segments/<segmentId>; it never sees a path.
        const { path: _serverOnly, ...publicResolution } = resolution;
        const envelope = {
          ok: true,
          cameraId: camera,
          at: atInstant.utc,
          resolution: publicResolution,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
        return;
      }

      // ---------- /teach-moments ----------
      // Candidate moments worth a tap (TEACH-LIST-SPEC.md): the answer key
      // camctl score needs stays empty otherwise, since scrubbing a day of
      // footage by hand to find them is slow. Read-only -- nothing here ever
      // writes a clip; a tap on the page this route feeds saves one through
      // the existing POST /clip-library.
      if (pathname === '/teach-moments') {
        const camera = parsedUrl.searchParams.get('camera');
        if (!isCameraId(camera)) {
          sendError(res, 400, 'bad_camera_id', 'Invalid camera id');
          return;
        }
        const dayResult = parseDay(parsedUrl.searchParams.get('day'));
        if (isRefusal(dayResult)) {
          sendError(res, dayResult.status, dayResult.code, dayResult.message);
          return;
        }

        const gateWindows = await readGateWindowsForDay(stateDir, dayResult.dayStartUtc, camera);
        const db = openEvents();
        // Every kind, hidden included: a hidden (known-object) event still
        // counts as stored for excluding a moved_nothing_stored minute, and a
        // hidden PERSON event is itself proposed, flagged, in the contract.
        const eventsResult = db === null
          ? { events: [], truncated: false }
          : db.inRange(camera, dayResult.dayStartUtc, dayResult.dayEndUtc, null, EVENT_LIMIT_MAX, null, { hidden: 'include' });
        const events = eventsResult.events.map((e) => ({
          id: e.id, cameraId: e.cameraId, kind: e.kind, firstUtc: e.firstUtc, lastUtc: e.lastUtc,
          count: e.count, bestConfidence: e.bestConfidence, bestUtc: e.bestUtc, suppressedBy: e.suppressedBy,
        }));

        const footage = footageSpansFor(index.forCamera(camera));
        const library = await loadClipLibraryForRead(stateDir);

        const proposed = proposeTeachMoments({
          cameraId: camera,
          dayStartUtc: dayResult.dayStartUtc,
          dayEndUtc: dayResult.dayEndUtc,
          nowUtc: now().toISOString(),
          gateWindows,
          events,
          library,
          footage,
        });
        const notes = eventsResult.truncated
          ? [...proposed.notes, `more than ${EVENT_LIMIT_MAX} stored events exist for this day; some may be missing from the proposal`]
          : proposed.notes;

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          cameraId: camera,
          dayStartUtc: dayResult.dayStartUtc,
          dayEndUtc: dayResult.dayEndUtc,
          moments: proposed.moments,
          omitted: proposed.omitted,
          notes,
          library: clipProgress(library),
        }));
        return;
      }

      // ---------- /still ----------
      // A JPEG of the recorded frame at one instant, no box drawn -- the
      // teach list's illustration for a moment, as opposed to /event-crop's
      // marked-up thumbnail for a stored detection. Cached by camera + instant
      // (a past moment's footage never changes once cut), niced the same as
      // event-crop.mjs's cutter, refusing a moment with no SEALED footage.
      if (pathname === '/still') {
        const camera = parsedUrl.searchParams.get('camera');
        if (!isCameraId(camera)) {
          sendError(res, 400, 'bad_camera_id', 'Invalid camera id');
          return;
        }
        const atResult = parseInstant(parsedUrl.searchParams.get('at'), 'at');
        if (isRefusal(atResult)) {
          sendError(res, atResult.status, atResult.code, atResult.message);
          return;
        }

        const cacheName = `${camera}__${atResult.ms}.jpg`;
        const cachePath = join(stillsDir, cacheName);
        let file;
        if (await pathExists(cachePath)) {
          file = cachePath;
        } else {
          const nowUtc = now().toISOString();
          const result = await scheduleStill(() => cutStill(camera, atResult.utc, nowUtc, cacheName));
          if (!result.ok) {
            sendError(res, result.status, result.code, result.message);
            return;
          }
          file = result.file;
        }

        const fileStat = await stat(file);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': fileStat.size,
          // A recorded moment's still never changes once cut.
          'Cache-Control': 'private, max-age=86400',
        });
        const stream = createReadStream(file);
        stream.on('error', () => {
          res.destroy();
        });
        stream.pipe(res);
        return;
      }

      // ---------- /segments/:id ----------
      if (pathname.startsWith('/segments/')) {
        const id = pathname.slice('/segments/'.length);
        const segResult = parseSegmentId(id);
        if (isRefusal(segResult)) {
          sendError(res, segResult.status, segResult.code, segResult.message);
          return;
        }
        const { cameraId, startMs } = segResult;
        const row = index.getByKey(cameraId, startMs);
        if (!row) {
          const envelope = {
            ok: false,
            code: 'segment_not_found',
            message: 'no such segment in the index',
          };
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(envelope));
          return;
        }
        if (row.state === 'open') {
          const envelope = {
            ok: false,
            code: 'segment_open',
            message: 'this segment is still being written; use the live stream',
          };
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(envelope));
          return;
        }

        const absPath = join(rootOf(row, cameraId, { config, driveAssignment }), row.path);

        let fileStat;
        try {
          fileStat = await stat(absPath);   // fs/promises stat: promise, not callback
        } catch (e) {
          if (e.code === 'ENOENT') {
            const envelope = {
              ok: false,
              code: 'segment_file_missing',
              message:
                'the index lists this segment but its file is not on disk; recovery has not reconciled',
            };
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(envelope));
            return;
          }
          throw e;
        }

        const size = fileStat.size;
        const rangeHeader = req.headers.range;
        let byteRange;
        try {
          byteRange = planByteRange(rangeHeader, size);
        } catch (e) {
          if (e instanceof ByteRangeError) {
            const envelope = {
              ok: false,
              code: 'range_size_invalid',
              message: e.message,
            };
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(envelope));
            return;
          }
          throw e;
        }

        const headers = {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        };

        if (byteRange.kind === 'full') {
          headers['Content-Length'] = byteRange.length;
          res.writeHead(200, headers);
          const stream = createReadStream(absPath);
          stream.on('error', () => {
            res.destroy();
          });
          stream.pipe(res);
        } else if (byteRange.kind === 'partial') {
          headers['Content-Range'] = byteRange.contentRange;
          headers['Content-Length'] = byteRange.length;
          res.writeHead(206, headers);
          const stream = createReadStream(absPath, { start: byteRange.start, end: byteRange.end });
          stream.on('error', () => {
            res.destroy();
          });
          stream.pipe(res);
        } else if (byteRange.kind === 'unsatisfiable') {
          headers['Content-Range'] = byteRange.contentRange;
          headers['Content-Length'] = 0;
          res.writeHead(416, headers);
          res.end();
        }
        return;
      }

      // ---------- /export/plan ----------
      if (pathname === '/export/plan') {
        serveExportPlan(res, parsedUrl, { config, index, now, driveAssignment });
        return;
      }

      // ---------- /export ----------
      if (pathname === '/export') {
        // Footage leaving the box is the one read worth a line in the audit.
        auth.audit('export', req, {
          actor: principal.username ?? principal.displayId ?? null,
          camera: parsedUrl.searchParams.get('camera'),
          start: parsedUrl.searchParams.get('start'),
          end: parsedUrl.searchParams.get('end'),
        });
        await serveExport(res, parsedUrl, { config, index, now, driveAssignment });
        return;
      }

      // ---------- the UI pages ----------
      // Served per request, not cached at boot, so an edit to a UI file lands
      // on the next page load without a server restart.
      if (Object.hasOwn(UI_FILES, pathname)) {
        const uiFile = UI_FILES[pathname];
        const file = join(import.meta.dirname, 'ui', uiFile);
        const type = uiFile.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript';
        let body;
        try {
          body = await readFile(file);
        } catch {
          sendError(res, 500, 'ui_missing', 'the UI files are not installed');
          return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }

      if (Object.hasOwn(UI_CONTRACTS, pathname)) {
        const file = join(import.meta.dirname, '..', 'dist', UI_CONTRACTS[pathname]);
        let body;
        try {
          body = await readFile(file);
        } catch {
          sendError(res, 500, 'ui_missing', 'the compiled contracts are not installed');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }

      // ---------- no route matched ----------
      const envelope = { ok: false, code: 'no_such_route', message: 'No such route' };
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope));
    } catch (err) {
      log('error', 'request failed', { code: err.code ?? undefined, error: err.message });
      if (!res.headersSent) {
        sendError(res, 500, 'server_error', 'internal error');
      } else {
        res.destroy();
      }
    }
  });

  // The live edge rides the same port as the recorded-past routes: ws://host:port/live/<cameraId>.
  // `now` is deliberately NOT passed through — the recorded-past routes run on
  // the caller's clock (the harness pins a fixed instant), but a LIVE stream
  // runs on the wall clock, and a stale-harness timestamp would make every
  // fresh stream look already-stalled to the watchdog.
  attachLive(server, {
    config, spawnFn, maxSourcesPerCamera, maxSources, maxViewers,
    authorize: (request) => {
      let pathname;
      try {
        pathname = new URL(request.url, 'http://localhost').pathname;
      } catch {
        return { kind: 'refuse', status: 401, code: 'unauthenticated', message: 'sign in first' };
      }
      // A WebSocket is not bound by the same-origin policy: a page on any
      // site can open one to this box, so the Origin is checked here too.
      if (!sameOrigin(request)) return { kind: 'refuse', status: 403, code: 'cross_origin', message: 'not from this recorder' };
      const d = decideRoute(auth.principalOf(request), 'GET', pathname);
      return d.kind === 'allow' ? d : { kind: 'refuse', status: d.status ?? 401, code: d.code ?? 'unauthenticated', message: d.message ?? 'sign in first' };
    },
  });

  // The events database is this server's to close: it opened it. Hung on the
  // server object so shutdown (and the harness) can let go of the file —
  // leaving it open holds a WAL handle open for as long as the process lives.
  server.closeEvents = () => {
    if (eventsDb !== null) {
      eventsDb.close();
      eventsDb = null;
    }
  };

  // Same reasoning as closeEvents: the cutter is this server's to close, and
  // shutdown must let go of whatever it holds (a cache directory, temp files)
  // rather than leave it for the next process to inherit.
  server.closeEventCrops = () => {
    eventCrops.close();
  };

  // Same reasoning again: the daily stills sweep is this server's timer.
  // unref() above already keeps it from holding a process open by itself,
  // but shutdown still lets go of it explicitly rather than leaving a timer
  // referencing a closed server's stateDir running until the process exits.
  server.closeStillsCleanup = () => {
    clearInterval(stillsCleanupTimer);
  };

  // Same reasoning again: events retention is this server's own timer.
  // Cleared before shutdown moves on, so no tick past this point reopens
  // events.db after closeEvents() above has already let go of it.
  server.closeEventRetention = () => {
    clearInterval(eventRetentionTimer);
  };

  // Same reasoning again: the Network page's counter/probe/connection-check
  // timers are this server's own. Cleared on shutdown so nothing keeps
  // polling a config or index this process has let go of.
  server.closeNetworkFacts = () => {
    networkFacts?.close();
  };

  return server;
}

// Only run when executed directly, so tests can import the pieces.
if (process.argv[1] && process.argv[1].endsWith('api-server.mjs')) {
  const stateDir = process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const config = await loadConfig(stateDir);
  const index = openIndex(indexPathFor(stateDir));
  const auth = await createAuth({ stateDir, log });
  const server = createApiServer({ stateDir, config, index, auth, networkFactsEnabled: true });

  const port = Number(process.env.CAMPLAT_API_PORT ?? 8080);

  // Determine listen spec: CAMPLAT_API_LISTEN (comma-separated), or fall back to CAMPLAT_API_HOST
  let listenSpec = null;
  if (process.env.CAMPLAT_API_LISTEN) {
    listenSpec = process.env.CAMPLAT_API_LISTEN.split(',').map(s => s.trim()).filter(s => s);
  } else if (process.env.CAMPLAT_API_HOST) {
    listenSpec = [process.env.CAMPLAT_API_HOST];
  }

  // Parse camera interfaces from env
  const cameraInterfaces = process.env.CAMPLAT_CAMERA_INTERFACES
    ? process.env.CAMPLAT_CAMERA_INTERFACES.split(',').map(s => s.trim()).filter(s => s)
    : [];

  const listeners = createListeners({
    server,
    port,
    spec: listenSpec,
    cameraInterfaces,
    log: (level, msg, extra) => log(level, msg, extra),
  });

  try {
    await listeners.start();
    const addresses = listeners.addresses();
    log('info', 'api server listening', { addresses, port, siteId: config.siteId });
  } catch (err) {
    log('error', 'api server failed to start', { error: err.message });
    process.exit(1);
  }

  const shutdown = () => {
    // Live streams first: an ffmpeg child orphaned by shutdown keeps pulling
    // from the camera after the server is gone. closeAll kills every child
    // and destroys every socket; the registry is module state, so this also
    // covers streams attached before this handler existed.
    closeAll();
    listeners.stop().then(() => {
      server.close(() => {
        // Stop the retention timer before letting go of the events database
        // it reads: no in-between tick can slip in either way (there is no
        // await between these two lines), but this keeps the order honest.
        server.closeEventRetention();
        index.close();
        server.closeEvents();
        server.closeEventCrops();
        server.closeStillsCleanup();
        server.closeNetworkFacts();
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}