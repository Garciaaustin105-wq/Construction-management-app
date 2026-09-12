# A2 transport spec — `agent/api-server.mjs` + `harness/apiServer.harness.mjs`

Written 2026-09-12 by Claude (session) after reading every contract in `contracts/`
this server wires up. This file is the contract for the transport slice; the code
generated from it must match it exactly. Anything this file does not authorise,
the code must not invent.

## Scope of this slice

The HTTP half of A2's exit: `curl` can list cameras, fetch a timeline for any
window, and play back a segment. NOT in this slice: the `liveNegotiation`
contract and WS/relay endpoints (next slice), auth (Phase B), the A3 web UI.

## `agent/api-server.mjs`

ESM, Node built-ins only, same style as `agent/recorder-service.mjs`.
Imports the pure contracts from `../dist/*.js` (apiQuery, httpRange,
indexCoverage, cameraView) and `loadConfig` + `resolveCameraUrl` from
`./recorder-service.mjs`, `openIndex` from `./segindex.mjs`, `indexPathFor` +
`DEFAULT_PATHS` + `assignCamerasToDrives` from `./config.mjs`.

### Export

```js
export function createApiServer({ stateDir, config, index, now = () => new Date() })
```

Returns an unstarted `http.Server`. `config` is `loadConfig`'s result, `index`
is an open index handle, `now` returns a Date (harness controls time). Compute
once at creation: `driveAssignment = assignCamerasToDrives(config.cameras.map(c => c.cameraId), config.storeRoots.length)`.

### Error envelope (every failure, JSON)

`{ ok: false, code: <string>, message: <string> }`. A refusal returned by a
contract (an `ApiRefusal`) maps one-to-one: its own `status`, its own `code`,
its own `message`. Codes the transport adds itself: `no_such_route` (404),
`segment_not_found` (404), `segment_open` (409), `segment_file_missing` (404),
`index_state_invalid` (500), `range_size_invalid` (500), `server_error` (500).
Never echo the request URL in a transport-added message. Any unexpected throw in
a handler → `server_error` 500, and one JSON log line (same `log()` shape as
recorder-service) — never a stack trace to the client. Do not log per-request.

### Success envelope

`{ ok: true, ... }` with the contract's fields spread in; `GET /cameras` is the
one exception — a bare JSON array of CameraView (200).

### Routes — GET only

Anything else → 405 with `Allow: GET` and the error envelope (`code: "method_not_allowed"`). HEAD is not supported.

**`GET /health`** → 200 `{ ok, siteId, atUtc, cameras, unresolved, segments }`
where `cameras = config.cameras.length`, `unresolved = number of config
cameras whose resolveCameraUrl is unresolved` (count only), `segments =
index.count()`, `atUtc = now().toISOString()`.

**`GET /cameras`** → 200, bare array; for each `config.cameras` entry:
`cameraView(camera, resolveCameraUrl(camera, config.credentials))`. The config
URLs carry camera passwords; the view never carries them — that is
cameraView's job, the transport must not add fields.

**`GET /timeline`** — query params `camera`, `start`, `end`, `buckets`:
1. `isCameraId(camera)` fails → 400 error envelope, `code: "bad_camera_id"`.
2. `parseWindow({ start, end, buckets }, nowUtc)` — refusal → its status/code/message.
3. `segments = index.inRange(camera, window.effective.startUtc, window.effective.endUtc)`, `gaps = index.gapsFor(camera)`.
4. `coverageFromIndex(camera, segments, gaps, window.effective, nowUtc)` inside
   try/catch; `IndexCoverageError` → 500 `index_state_invalid` (the message may
   name segment starts — it never carries credentials), other errors rethrow.
5. 200 `{ ok, cameraId, requested, effective, clippedToNow, buckets:
   window.bucketCount, ...coverage }` (coverage's own `range` field duplicates
   `effective`; spreading both is fine and expected).

**`GET /playback`** — query params `camera`, `at`:
1. `isCameraId` check as above.
2. `parseInstant(at, "at")` — refusal → mapped.
3. `resolution = resolvePlayback(camera, index.forCamera(camera),
   index.gapsFor(camera), at.utc, nowUtc)` — pass EVERY segment and gap for the
   camera, not a window; `nextRecordedUtc` is only as good as what was supplied.
4. 200 `{ ok, cameraId, at: at.utc, resolution }`.

**`GET /segments/:id`** — `id` is the raw path segment after `/segments/`
(NOT decoded; ids are `[A-Za-z0-9_-]` + dot + digits and need no encoding):
1. `parseSegmentId(id)` — refusal → its status/code/message (400
   `bad_segment_id`). This is the path-traversal refusal: a client never sends
   a path, and the server never builds one from client input — it looks the id
   up and serves what the index holds.
2. `index.getByKey(cameraId, startMs)` — null → 404 `segment_not_found`
   (`message: "no such segment in the index"`).
3. `state === "open"` → 409 `segment_open` (`message: "this segment is still
   being written; use the live stream"`). States `sealed` and `partial` are
   both served — a partial is a real recording artifact, truncated but valid fMP4.
4. Absolute file: `path.join(config.storeRoots[driveAssignment.get(cameraId) ?? 0], seg.path)`.
5. `stat()` it — ENOENT → 404 `segment_file_missing` (`message: "the index
   lists this segment but its file is not on disk; recovery has not reconciled"`).
   THE SIZE COMES FROM stat(), NEVER from the index's `bytes` (build rule 5;
   `bytes` is null on open segments and can be stale after recovery).
6. `planByteRange(req.headers.range, size)` — `ByteRangeError` → 500
   `range_size_invalid`. Then:
   - `kind: "full"` → 200, `Content-Length: length`, `Content-Type: video/mp4`,
     `Accept-Ranges: bytes` on every success response. (An ignored Range header
     is served whole at 200, as the contract decided.)
   - `kind: "partial"` → 206 with `Content-Range: contentRange`, `Content-Length: length`,
     and the bytes from `fs.createReadStream(abs, { start, end })`.
   - `kind: "unsatisfiable"` → 416 with `Content-Range: contentRange`,
     `Content-Length: 0`, empty body.
   - A stream error after headers are sent → destroy the socket; before → 500 envelope.

**Anything else** → 404 `no_such_route`.

### Standalone entry (same pattern as recorder-service.mjs)

Only when `process.argv[1]` ends with `api-server.mjs`: `stateDir =
CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir`, `loadConfig`, `openIndex(indexPathFor(stateDir))`,
`createApiServer(...)`, `server.listen(Number(process.env.CAMPLAT_API_PORT ?? 8080),
process.env.CAMPLAT_API_HOST ?? "127.0.0.1")` — **loopback by default**; LAN
binding comes with Phase B auth, never before it. SIGTERM/SIGINT → `server.close()` +
`index.close()`, then exit 0.

## `agent/segindex.mjs` — one addition (done by hand, 3 lines)

`byKey` prepared statement `SELECT * FROM segments WHERE camera_id = ? AND
start_ms = ?` and a `getByKey(cameraId, startMs)` returning `rowToSegment(row)`
or null. Nothing else in that file changes.

## `harness/apiServer.harness.mjs`

Real HTTP on `server.listen(0)` loopback, Node 24 `fetch`, temp dirs via
`mkdtemp` (cleaned up with `rm -rf` at the end), same `check`/`eq`/`report`
style as the other harnesses. `now` is a fixed `new Date("2026-09-11T12:00:00Z")`.

Fixture (written into the temp index and store root `disk0`):
- cam-1: sealed seg A `10:00:00Z`→`10:01:00Z` (file on disk, 1000 bytes, index bytes 1000);
  sealed seg B `10:01:00Z`→`10:02:00Z` (file on disk, 2000 bytes, **index bytes null**);
  logged gap `10:02:00Z`→`10:05:00Z` reason `camera_offline`;
  sealed seg C `10:05:00Z`→`10:06:00Z` (file 500 bytes, index bytes 500);
  open seg start `11:58:00Z`, endUtc null, state open (no file required);
  sealed seg D `09:00:00Z`→`09:01:00Z` **with no file on disk** (index bytes 100).
- cam-2: no segments, no gaps at all.
- config.json: siteId `carwash-01`, storeRoots `[disk0]`, cameras: cam-1
  (`url: rtsp://admin:hunter2@10.0.0.5:8554/live`), cam-2 (host 10.0.0.6, vendor
  hikvision), cam-3 (`host: 10.0.0.7`, vendor `generic` — unresolved), plus one
  cam-4 with `url: rtsp://bob:s3cr3t@10.0.0.8/x` and a resolution that fails
  (leave its url unparseable: `http://nope`) so the scrub path is exercised.

Checks, at minimum (build rule 19 — the failures, not the happy path):

1. `/cameras`: no entry contains `hunter2`, `s3cr3t`, `rtsp://` or any config
   URL; an unresolved reason echoes `***` instead of the URL/password.
2. `/cameras`: resolved camera exposes host `10.0.0.5`, port **8554** (the port
   its configured URL states), `resolved: true`; a host-only camera exposes its
   configured host and `port: null`.
3. `/health`: 200, siteId, segments count > 0, unresolved names cam-3's count.
4. `/timeline` over `10:00:00Z`→`10:06:00Z` for cam-1: 200; runs in order
   recorded→gap(`camera_offline`, `gapSource: "logged"`)→recorded; recordedSeconds
   180, gapSeconds 180. A separate window `11:50:00Z`→`12:00:00Z` returns the
   open segment as a recorded run with `includesOpen: true` (the hole before it
   is an inferred gap). The run ending at 10:06 has `includesOpen: false`.
5. `/timeline` with `end` after now: `clippedToNow: true`, `requested` preserved,
   `effective.endUtc` = now.
6. `/timeline` for cam-2 over any past window: 200 with ONE inferred gap run,
   `gapReason: "unknown"`, `gapSource: "inferred"` — coverage-with-a-reason,
   never an empty 200.
7. Refusals map exactly: missing start → 400 `missing_parameter`; naive instant
   `2026-09-11T12:00:00` → 400 `bad_instant`; `start=2026-09-11T14:00:00 02:00`
   (space) → 400 and the message mentions `%2B`; end before start → 400
   `inverted_window`; wholly future window → 422 `window_in_future`;
   36-day window → 422 `window_too_large`; `buckets=0` → 400 `bad_buckets`;
   `camera=../x` → 400 `bad_camera_id`.
8. `/playback?camera=cam-1&at=<10:00:30Z>` → `kind: "segment"`, segmentId
   `cam-1.<startMs of A>`, `offsetSeconds: 30`; at `<10:03:00Z>` → `kind:
   "gap"`, reason `camera_offline`, `nextRecordedUtc` = seg C's start; at
   `<11:59:00Z>` → `kind: "recording"`; at `<12:00:00Z>` → `kind: "future"`.
9. `/segments/cam-1.<startMs of A>` no Range → 200, `Content-Length: 1000`,
   `Accept-Ranges: bytes`, `Content-Type: video/mp4`, body is exactly the file.
10. `bytes=0-99` → 206, `Content-Range: bytes 0-99/1000`, body length 100 and
    equal to the file's first 100 bytes.
11. `bytes=-100` → 206, the LAST 100 bytes.
12. `bytes=2000-` → 416, `Content-Range: bytes */1000`.
13. `bytes=0-1,5-6` → 200 whole (multi-range ignored); `foo=0-1` → 200 whole.
14. Seg B (index bytes null) → `Content-Length: 2000` from stat — THE FEARED ONE.
15. Seg D (indexed, file gone) → 404 `segment_file_missing`. Unknown id
    `cam-1.5` → 404 `segment_not_found`. `../etc.passwd.1` → 400
    `bad_segment_id`. The open segment's id → 409 `segment_open`.
16. POST /cameras → 405 with `Allow: GET`. GET `/nope` → 404 `no_such_route`.

Add `apiServer` to `harness/run-all.mjs`'s suites list.