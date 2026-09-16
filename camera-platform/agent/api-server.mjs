// agent/api-server.mjs
//
// This file implements the HTTP transport slice for A2.
// It follows the same style as recorder-service.mjs, using only Node built‑ins
// and the pure contracts from ../dist/*.js.  All responses are JSON
// envelopes; errors are mapped to the codes defined in the spec.  Unexpected
// errors are logged as a single JSON line (level: error) and returned as a
// generic server_error envelope.  No stack traces are sent to the client.

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { loadConfig, resolveCameraUrl } from './recorder-service.mjs';
import { attachLive, closeAll } from './live.mjs';
import { openIndex } from './segindex.mjs';
import { readHealth, alertsResponse } from './alerts-run.mjs';
import { gatherHealthFacts, cameraFacts } from './healthfacts.mjs';
import { indexPathFor, DEFAULT_PATHS, assignCamerasToDrives } from './config.mjs';

// The pure contracts, compiled. Refusals are VALUES (ok === false), not
// exceptions — detect them by shape, never by instanceof (they are interfaces,
// with no runtime identity).
import { parseWindow, parseInstant, parseSegmentId, isCameraId } from '../dist/apiQuery.js';
import { planByteRange, ByteRangeError } from '../dist/httpRange.js';
import { coverageFromIndex, resolvePlayback, IndexCoverageError } from '../dist/indexCoverage.js';
import { cameraView } from '../dist/cameraView.js';
import { groupCamerasByDevice } from '../dist/cameraGroups.js';
import { siteHealth } from '../dist/siteHealth.js';
import { planExport } from '../dist/exportPlan.js';
import { streamExport } from './exportStream.mjs';
import { decideRoute, ruleFor, safeNext } from '../dist/routeAccess.js';
import { createAuth } from './auth.mjs';

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

const isRefusal = (r) => r !== null && typeof r === 'object' && r.ok === false;

// The UI routes → files under agent/ui. A map, not string handling of the
// pathname: only these exact paths ever reach the filesystem.
const UI_FILES = {
  '/': 'index.html',
  '/ui/live-client.js': 'live-client.mjs',
  '/review': 'review.html',
  '/ui/review-client.js': 'review-client.mjs',
  '/ui/alert-banner.js': 'alert-banner.mjs',
  '/system': 'system.html',
  '/ui/system-client.js': 'system-client.mjs',
  '/ui/wall-client.js': 'wall-client.mjs',
  '/login': 'login.html',
  '/ui/login-client.js': 'login-client.mjs',
  '/accounts-page': 'accounts.html',
  '/ui/accounts-client.js': 'accounts-client.mjs',
  '/ui/session.js': 'session-bar.mjs',
};

// Compiled contracts the browser runs directly, served from dist rather than
// copied into ui. The live wall's layout maths has to be the SAME code the
// harness proves: a copy under ui would drift from it silently, and the first
// symptom would be a wall laying out cells the contract never agreed to. The
// relative path holds in both trees -- agent/../dist in the checkout, and
// /opt/camplat/agent/../dist on the appliance.
const UI_CONTRACTS = {
  '/ui/grid-layout.js': 'gridLayout.js',
  '/ui/playback.js': 'playback.js',
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
 * 3. const root = ctx.config.storeRoots[ctx.driveAssignment.get(camera) ?? 0].
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
async function serveExport(res, parsedUrl, ctx) {
  const prep = prepareExport(parsedUrl, ctx);
  if (!prep.ok) {
    sendError(res, prep.status, prep.code, prep.message);
    return;
  }
  const { camera, effective, nowUtc, plan } = prep;
  const filename = `${camera}_${effective.startUtc}_${effective.endUtc}.zip`.replace(/:/g, '-');
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  const root = ctx.config.storeRoots[ctx.driveAssignment.get(camera) ?? 0];
  try {
    await streamExport(res, plan, { resolvePath: (p) => join(root, p), siteId: ctx.config.siteId, generatedAtUtc: nowUtc });
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
  maxPerCamera = 2,
  maxTotal = 16,
}) {
  // No auth, no server. A default here would be an open recorder the first
  // time someone forgot to pass one.
  if (auth === null || typeof auth !== 'object' || typeof auth.principalOf !== 'function' || typeof auth.handle !== 'function') {
    throw new TypeError('createApiServer needs auth (from createAuth)');
  }

  const driveAssignment = assignCamerasToDrives(
    config.cameras.map((c) => c.cameraId),
    config.storeRoots.length
  );

  const server = createServer(async (req, res) => {
    try {
      const { method, url } = req;
      const parsedUrl = new URL(url, `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;

      // ---------- access, before any route ----------
      // Default deny: routeAccess knows every route and what it needs. A route
      // added below without a line there is refused, not served.
      const principal = auth.principalOf(req);
      const decision = decideRoute(principal, method, pathname);
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
            now().toISOString()
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

        const driveIndex = driveAssignment.get(cameraId) ?? 0;
        const absPath = join(config.storeRoots[driveIndex], row.path);

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
    config, spawnFn, maxPerCamera, maxTotal,
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

  return server;
}

// Only run when executed directly, so tests can import the pieces.
if (process.argv[1] && process.argv[1].endsWith('api-server.mjs')) {
  const stateDir = process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const config = await loadConfig(stateDir);
  const index = openIndex(indexPathFor(stateDir));
  const auth = await createAuth({ stateDir, log });
  const server = createApiServer({ stateDir, config, index, auth });

  const port = Number(process.env.CAMPLAT_API_PORT ?? 8080);
  const host = process.env.CAMPLAT_API_HOST ?? '127.0.0.1';

  server.listen(port, host, () => {
    log('info', 'api server listening', { host, port, siteId: config.siteId });
  });

  const shutdown = () => {
    // Live streams first: an ffmpeg child orphaned by shutdown keeps pulling
    // from the camera after the server is gone. closeAll kills every child
    // and destroys every socket; the registry is module state, so this also
    // covers streams attached before this handler existed.
    closeAll();
    server.close(() => {
      index.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}