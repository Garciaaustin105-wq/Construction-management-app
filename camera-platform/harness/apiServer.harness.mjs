/**
 * The A2 transport, against a real HTTP server on a real socket.
 *
 * The fixture bytes are deterministic and NON-zero on purpose: a range bug that
 * serves the wrong offsets is invisible against Buffer.alloc's zeros. Every
 * body comparison below checks the actual bytes at the actual offset.
 *
 * The failures tested (build rule 19), not the happy path: an all-gap window
 * answered with coverage-with-a-reason rather than an empty 200; a segment the
 * index knows but the disk lost; an index `bytes` of null (stat() decides the
 * Content-Length); a Range ignored or unsatisfiable; a window clipped to now.
 */
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("api server");
const now = () => new Date("2026-09-11T12:00:00Z");
const ms = (iso) => Date.parse(iso);

/** Deterministic pseudo-random bytes: same seed, same bytes, never all zeros. */
function fill(seed, n) {
  const buf = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

const stateDir = await mkdtemp(join(tmpdir(), "camplat-api-"));
const disk0 = join(stateDir, "disk0");
await mkdir(disk0, { recursive: true });

const T = {
  A: "2026-09-11T10:00:00Z",
  B: "2026-09-11T10:01:00Z",
  C: "2026-09-11T10:05:00Z",
  D: "2026-09-11T09:00:00Z",
  open: "2026-09-11T11:58:00Z",
};
const idOf = (t) => `cam-1.${ms(t)}`;

// Config URLs carry real-looking passwords; /cameras must never echo one.
const config = {
  siteId: "carwash-01",
  storeRoots: [disk0],
  segmentSeconds: 60,
  credentials: { username: "svc", password: "p@ss" },
  cameras: [
    { cameraId: "cam-1", url: "rtsp://admin:hunter2@10.0.0.5:8554/live", bitrateKbps: 2500 },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "hikvision", bitrateKbps: 2500 },
    { cameraId: "cam-3", host: "10.0.0.7", vendor: "generic" },
    { cameraId: "cam-4", url: "http://nope" },
  ],
};

// Files on disk, under the layout segstore.mjs owns: <root>/<cameraId>/<startMs>.mp4.
const fileBytes = {
  A: fill(101, 1000),
  B: fill(202, 2000),
  C: fill(303, 500),
};
for (const [key, bytes] of Object.entries(fileBytes)) {
  await mkdir(join(disk0, "cam-1"), { recursive: true });
  await writeFile(join(disk0, "cam-1", `${ms(T[key === "A" ? "A" : key === "B" ? "B" : "C"])}.mp4`), bytes);
}
// D is indexed but has no file — the disk and the index disagree on purpose.

const index = openIndex(join(stateDir, "index.db"));
const seg = (cameraId, startIso, endIso, path, bytes, state) => ({
  cameraId, startUtc: startIso, endUtc: endIso, path, bytes, state,
  hold: false, pendingUpload: false, bitrateKbps: null,
});
index.put(seg("cam-1", "2026-09-11T09:00:00Z", "2026-09-11T09:01:00Z", `cam-1/${ms(T.D)}.mp4`, 100, "sealed"));
index.put(seg("cam-1", "2026-09-11T10:00:00Z", "2026-09-11T10:01:00Z", `cam-1/${ms(T.A)}.mp4`, 1000, "sealed"));
index.put(seg("cam-1", "2026-09-11T10:01:00Z", "2026-09-11T10:02:00Z", `cam-1/${ms(T.B)}.mp4`, null, "sealed"));
index.put(seg("cam-1", "2026-09-11T10:05:00Z", "2026-09-11T10:06:00Z", `cam-1/${ms(T.C)}.mp4`, 500, "sealed"));
index.put(seg("cam-1", "2026-09-11T11:58:00Z", null, `cam-1/${ms(T.open)}.mp4`, null, "open"));
index.addGap({ cameraId: "cam-1", startUtc: "2026-09-11T10:02:00Z", endUtc: "2026-09-11T10:05:00Z", reason: "camera_offline" });

const server = createApiServer({ stateDir, config, index, now });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const fetchJson = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary bodies */ }
  return { res, json, text };
};

await check("secrets never reach /cameras, and an unresolved reason is scrubbed", async () => {
  const { res, json } = await fetchJson(`${base}/cameras`);
  eq(res.status, 200, "status");
  const asText = JSON.stringify(json);
  // An unresolved reason MAY say "rtsp://" in prose (the parse hint) — what must
  // never appear is a credential or a configured stream URL.
  for (const secret of ["hunter2", "p@ss", "rtsp://admin", "rtsp://bob", "10.0.0.5:8554/live"]) {
    eq(asText.includes(secret), false, `no ${secret} in the camera list`);
  }
  const cam3 = json.find((v) => v.cameraId === "cam-3");
  const cam4 = json.find((v) => v.cameraId === "cam-4");
  eq(cam3.resolved, false, "generic vendor unresolved");
  eq(cam4.resolved, false, "unparseable url unresolved");
  eq(cam3.unresolvedReason.includes("***"), false, "cam-3's reason carries nothing to scrub");
  // parseRtspUrl never echoes its input in a reason (cameraSource's own rule),
  // and cameraView would scrub it if it did. The client sees neither.
  eq(cam4.unresolvedReason.includes("nope"), false, "cam-4's url is not echoed");
  eq(typeof cam4.unresolvedReason === "string" && cam4.unresolvedReason !== "", true,
    "cam-4 still gets a reason");
});

await check("a resolved camera exposes its configured host and the port its url states", async () => {
  const { json } = await fetchJson(`${base}/cameras`);
  const cam1 = json.find((v) => v.cameraId === "cam-1");
  eq(cam1.host, "10.0.0.5", "host");
  eq(cam1.port, 8554, "port from the configured url");
  eq(cam1.resolved, true, "resolved");
  eq(cam1.origin, "manual_url", "origin");
  const cam2 = json.find((v) => v.cameraId === "cam-2");
  eq(cam2.host, "10.0.0.6", "host-only camera host");
  eq(cam2.port, null, "host-only camera has no port");
  eq(cam2.resolved, true, "vendor template resolved");
});

await check("/health counts what it knows, including what it cannot resolve", async () => {
  const { res, json } = await fetchJson(`${base}/health`);
  eq(res.status, 200, "status");
  eq(json.ok, true, "ok");
  eq(json.siteId, "carwash-01", "site");
  eq(json.cameras, 4, "configured");
  eq(json.unresolved, 2, "cam-3 and cam-4 unresolved");
  eq(json.segments, 5, "indexed segments");
});

await check("/timeline answers recorded, logged gap, recorded", async () => {
  const { res, json } = await fetchJson(
    `${base}/timeline?camera=cam-1&start=2026-09-11T10:00:00Z&end=2026-09-11T10:06:00Z`);
  eq(res.status, 200, "status");
  eq(json.ok, true, "ok");
  eq(json.runs.length, 3, "runs");
  eq(json.runs[0].kind, "recorded", "run 0");
  eq(json.runs[0].segmentCount, 2, "A and B are one contiguous run");
  eq(json.runs[1].kind, "gap", "run 1");
  eq(json.runs[1].gapReason, "camera_offline", "gap reason");
  eq(json.runs[1].gapSource, "logged", "gap source");
  eq(json.runs[2].kind, "recorded", "run 2");
  eq(json.runs[2].includesOpen, false, "the open segment is outside this window");
  eq(json.recordedSeconds, 180, "recorded");
  eq(json.gapSeconds, 180, "gap");
  eq(json.gapSecondsByReason.camera_offline, 180, "by reason");
  eq(json.gapSecondsByReason.unknown, 0, "unknown is a measured zero");
});

await check("/timeline shows the open segment as recorded and still being written", async () => {
  const { res, json } = await fetchJson(
    `${base}/timeline?camera=cam-1&start=2026-09-11T11:50:00Z&end=2026-09-11T12:00:00Z`);
  eq(res.status, 200, "status");
  eq(json.runs.length, 2, "hole then the open segment");
  eq(json.runs[0].kind, "gap", "hole before the open segment");
  eq(json.runs[0].gapSource, "inferred", "nobody logged it");
  eq(json.runs[1].kind, "recorded", "open segment");
  eq(json.runs[1].includesOpen, true, "still being written");
});

await check("a window past now is clipped, and says it was clipped", async () => {
  const { res, json } = await fetchJson(
    `${base}/timeline?camera=cam-1&start=2026-09-11T10:00:00Z&end=2026-09-11T13:00:00Z`);
  eq(res.status, 200, "status");
  eq(json.clippedToNow, true, "clipped");
  eq(json.requested.endUtc, new Date("2026-09-11T13:00:00Z").toISOString(), "requested preserved");
  eq(json.effective.endUtc, now().toISOString(), "effective pulled back to now");
});

await check("a camera with nothing recorded gets coverage with a reason, not an empty 200", async () => {
  const { res, json } = await fetchJson(
    `${base}/timeline?camera=cam-2&start=2026-09-11T08:00:00Z&end=2026-09-11T09:00:00Z`);
  eq(res.status, 200, "status");
  eq(json.runs.length, 1, "one run");
  eq(json.runs[0].kind, "gap", "gap");
  eq(json.runs[0].gapReason, "unknown", "reason");
  eq(json.runs[0].gapSource, "inferred", "source");
  eq(json.recordedSeconds, 0, "recorded");
  eq(json.gapSeconds, 3600, "the whole window");
});

await check("refusals arrive with the contract's status and code", async () => {
  const cases = [
    [`/timeline?camera=cam-1&end=2026-09-11T10:06:00Z`, 400, "missing_parameter"],
    [`/timeline?camera=cam-1&start=2026-09-11T10:00:00&end=2026-09-11T10:06:00Z`, 400, "bad_instant"],
    [`/timeline?camera=cam-1&start=2026-09-11T10:10:00Z&end=2026-09-11T10:00:00Z`, 400, "inverted_window"],
    [`/timeline?camera=cam-1&start=2026-09-12T10:00:00Z&end=2026-09-12T11:00:00Z`, 422, "window_in_future"],
    [`/timeline?camera=cam-1&start=2026-08-20T10:00:00Z&end=2026-10-01T10:00:00Z`, 422, "window_too_large"],
    [`/timeline?camera=cam-1&start=2026-09-11T10:00:00Z&end=2026-09-11T10:06:00Z&buckets=0`, 400, "bad_buckets"],
  ];
  for (const [url, status, code] of cases) {
    const { res, json } = await fetchJson(`${base}${url}`);
    eq(res.status, status, `${code} status for ${url}`);
    eq(json.code, code, `${code} code`);
    eq(json.ok, false, `${code} envelope`);
  }
});

await check("THE FEARED ONE: the space-where-plus-was refusal says %2B", async () => {
  const { res, json } = await fetchJson(
    `${base}/timeline?camera=cam-1&start=2026-09-11T14:00:00%2002:00&end=2026-09-11T15:00:00Z`);
  eq(res.status, 400, "status");
  eq(json.code, "bad_instant", "code");
  eq(json.message.includes("%2B"), true, "the refusal names the encoding");
});

await check("a camera id that reaches file paths is refused before anything else", async () => {
  const { res, json } = await fetchJson(
    `${base}/timeline?camera=..%2Fx&start=2026-09-11T10:00:00Z&end=2026-09-11T10:06:00Z`);
  eq(res.status, 400, "status");
  eq(json.code, "bad_camera_id", "code");
});

await check("/playback lands in a segment, a gap, the live write, and the future", async () => {
  const inSegment = await fetchJson(`${base}/playback?camera=cam-1&at=2026-09-11T10:00:30Z`);
  eq(inSegment.json.resolution.kind, "segment", "segment");
  eq(inSegment.json.resolution.segmentId, idOf(T.A), "segmentId");
  eq(inSegment.json.resolution.offsetSeconds, 30, "offset");

  const inGap = await fetchJson(`${base}/playback?camera=cam-1&at=2026-09-11T10:03:00Z`);
  eq(inGap.json.resolution.kind, "gap", "gap");
  eq(inGap.json.resolution.reason, "camera_offline", "reason");
  eq(inGap.json.resolution.nextRecordedUtc, new Date(ms(T.C)).toISOString(), "next recorded");

  const inLive = await fetchJson(`${base}/playback?camera=cam-1&at=2026-09-11T11:59:00Z`);
  eq(inLive.json.resolution.kind, "recording", "the open segment is live");

  const atNow = await fetchJson(`${base}/playback?camera=cam-1&at=2026-09-11T12:00:00Z`);
  eq(atNow.json.resolution.kind, "future", "now is the future");
});

await check("a segment with no Range header is served whole, sized by stat()", async () => {
  const res = await fetch(`${base}/segments/${idOf(T.A)}`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "video/mp4", "content type");
  eq(res.headers.get("accept-ranges"), "bytes", "accept ranges");
  eq(Number(res.headers.get("content-length")), 1000, "content length");
  const body = Buffer.from(await res.arrayBuffer());
  eq(body.equals(fileBytes.A), true, "body is exactly the file");
});

await check("bytes=0-99 is 206 with the file's first hundred bytes", async () => {
  const res = await fetch(`${base}/segments/${idOf(T.A)}`, { headers: { Range: "bytes=0-99" } });
  eq(res.status, 206, "status");
  eq(res.headers.get("content-range"), "bytes 0-99/1000", "content range");
  const body = Buffer.from(await res.arrayBuffer());
  eq(body.length, 100, "length");
  eq(body.equals(fileBytes.A.subarray(0, 100)), true, "first hundred bytes");
});

await check("bytes=-100 is the file's last hundred bytes", async () => {
  const res = await fetch(`${base}/segments/${idOf(T.A)}`, { headers: { Range: "bytes=-100" } });
  eq(res.status, 206, "status");
  eq(res.headers.get("content-range"), "bytes 900-999/1000", "content range");
  const body = Buffer.from(await res.arrayBuffer());
  eq(body.equals(fileBytes.A.subarray(900)), true, "last hundred bytes");
});

await check("bytes beyond the file is 416 with bytes */size", async () => {
  const res = await fetch(`${base}/segments/${idOf(T.A)}`, { headers: { Range: "bytes=2000-" } });
  eq(res.status, 416, "status");
  eq(res.headers.get("content-range"), "bytes */1000", "content range");
  eq((await res.arrayBuffer()).byteLength, 0, "empty body");
});

await check("a range the RFC says to ignore is served whole at 200", async () => {
  const multi = await fetch(`${base}/segments/${idOf(T.A)}`, { headers: { Range: "bytes=0-1,5-6" } });
  eq(multi.status, 200, "multi-range status");
  eq(Number(multi.headers.get("content-length")), 1000, "multi-range length");
  const unit = await fetch(`${base}/segments/${idOf(T.A)}`, { headers: { Range: "foo=0-1" } });
  eq(unit.status, 200, "unknown-unit status");
});

await check("THE FEARED ONE: an index bytes of null never becomes the Content-Length", async () => {
  const res = await fetch(`${base}/segments/${idOf(T.B)}`);
  eq(res.status, 200, "status");
  eq(Number(res.headers.get("content-length")), 2000, "stat() size, not the index's null");
  const body = Buffer.from(await res.arrayBuffer());
  eq(body.equals(fileBytes.B), true, "body is exactly the file");
});

await check("a segment the index knows but the disk lost is reported, not guessed", async () => {
  const { res, json } = await fetchJson(`${base}/segments/${idOf(T.D)}`);
  eq(res.status, 404, "status");
  eq(json.code, "segment_file_missing", "code");
});

await check("unknown, malformed and open segment ids each get their own refusal", async () => {
  const unknown = await fetchJson(`${base}/segments/cam-1.5`);
  eq(unknown.res.status, 404, "unknown status");
  eq(unknown.json.code, "segment_not_found", "unknown code");

  const traversal = await fetchJson(`${base}/segments/..%2Fetc.passwd.1`);
  eq(traversal.res.status, 400, "traversal status");
  eq(traversal.json.code, "bad_segment_id", "traversal code");

  const open = await fetchJson(`${base}/segments/${idOf(T.open)}`);
  eq(open.res.status, 409, "open status");
  eq(open.json.code, "segment_open", "open code");
});

await check("only GET exists", async () => {
  const post = await fetch(`${base}/cameras`, { method: "POST" });
  eq(post.status, 405, "post status");
  eq(post.headers.get("allow"), "GET", "allow header");
  const { json } = await fetchJson(`${base}/nope`);
  eq(json.code, "no_such_route", "unknown route");
});

server.close();
index.close();
await rm(stateDir, { recursive: true, force: true });
report("api server");