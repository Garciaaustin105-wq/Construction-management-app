// agent/api-server.mjs
//
// This file implements the HTTP transport slice for A2.
// It follows the same style as recorder-service.mjs, using only Node built‑ins
// and the pure contracts from ../dist/*.js.  All responses are JSON
// envelopes; errors are mapped to the codes defined in the spec.  Unexpected
// errors are logged as a single JSON line (level: error) and returned as a
// generic server_error envelope.  No stack traces are sent to the client.

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveCameraUrl } from './recorder-service.mjs';
import { openIndex } from './segindex.mjs';
import { indexPathFor, DEFAULT_PATHS, assignCamerasToDrives } from './config.mjs';

// The pure contracts, compiled. Refusals are VALUES (ok === false), not
// exceptions — detect them by shape, never by instanceof (they are interfaces,
// with no runtime identity).
import { parseWindow, parseInstant, parseSegmentId, isCameraId } from '../dist/apiQuery.js';
import { planByteRange, ByteRangeError } from '../dist/httpRange.js';
import { coverageFromIndex, resolvePlayback, IndexCoverageError } from '../dist/indexCoverage.js';
import { cameraView } from '../dist/cameraView.js';

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

const isRefusal = (r) => r !== null && typeof r === 'object' && r.ok === false;

const sendError = (res, status, code, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, code, message }));
};

export function createApiServer({ stateDir, config, index, now = () => new Date() }) {
  const driveAssignment = assignCamerasToDrives(
    config.cameras.map((c) => c.cameraId),
    config.storeRoots.length
  );

  const server = createServer(async (req, res) => {
    try {
      const { method, url } = req;
      const parsedUrl = new URL(url, `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;

      // Only GET is supported
      if (method !== 'GET') {
        const envelope = { ok: false, code: 'method_not_allowed', message: 'Method not allowed' };
        res.writeHead(405, { Allow: 'GET', 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
        return;
      }

      // ---------- /health ----------
      if (pathname === '/health') {
        // resolveCameraUrl returns { kind: "unresolved" } — it does not throw.
        const unresolved = config.cameras.filter(
          (cam) => resolveCameraUrl(cam, config.credentials).kind !== 'ok'
        ).length;
        const envelope = {
          ok: true,
          siteId: config.siteId,
          atUtc: now().toISOString(),
          cameras: config.cameras.length,
          unresolved,
          segments: index.count(),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
        return;
      }

      // ---------- /cameras ----------
      if (pathname === '/cameras') {
        // The config URLs carry camera passwords; cameraView alone decides what
        // the client sees. The transport adds no fields and catches nothing:
        // resolveCameraUrl reports an unresolvable camera as a value.
        const views = config.cameras.map((cam) =>
          cameraView(cam, resolveCameraUrl(cam, config.credentials)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(views));
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

        const envelope = {
          ok: true,
          cameraId: camera,
          at: atInstant.utc,
          resolution,
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

  return server;
}

// Only run when executed directly, so tests can import the pieces.
if (process.argv[1] && process.argv[1].endsWith('api-server.mjs')) {
  const stateDir = process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const config = await loadConfig(stateDir);
  const index = openIndex(indexPathFor(stateDir));
  const server = createApiServer({ stateDir, config, index });

  const port = Number(process.env.CAMPLAT_API_PORT ?? 8080);
  const host = process.env.CAMPLAT_API_HOST ?? '127.0.0.1';

  server.listen(port, host, () => {
    log('info', 'api server listening', { host, port, siteId: config.siteId });
  });

  const shutdown = () => {
    server.close(() => {
      index.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}