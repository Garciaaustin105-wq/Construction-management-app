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
 *
 * The live edge rides the SAME server: ws://host:port/live/<cameraId> answers
 * on the port the recorded-past routes answer on, with a fake ffmpeg injected
 * through createApiServer's spawnFn — the harness never spawns a real one.
 */
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readZip } from "./_zipReader.mjs";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { liveRegistry, closeAll } from "../agent/live.mjs";
import { createBoxAccumulator, extractMimeCodec, parseTopLevelBoxes } from "../agent/ui/live-client.mjs";
import { layoutCoverage, planPlayback } from "../agent/ui/review-client.mjs";
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

await check("/alerts tells a check that never ran, a current one and a corrupt file apart", async () => {
  const never = await fetchJson(`${base}/alerts`);
  eq([never.res.status, never.json?.check, never.json?.alerts], [200, "never", []], "no alerts.json yet");
  const raised = { key: "recorder_stale:recorder", id: "recorder_stale", subject: "recorder", state: "raised",
    since: "2026-09-11T11:58:00.000Z", badStreak: 2, goodStreak: 0, value: "200 s since the last health report" };
  await writeFile(join(stateDir, "alerts.json"), JSON.stringify({ checkedUtc: "2026-09-11T11:59:00.000Z", alerts: [raised] }));
  const current = await fetchJson(`${base}/alerts`);
  eq([current.json?.check, current.json?.checkedUtc, current.json?.alerts], ["current", "2026-09-11T11:59:00.000Z", [raised]], "the timer's file, read as it is");
  eq(current.res.headers.get("content-type"), "application/json", "JSON");
  await writeFile(join(stateDir, "alerts.json"), "{ half");
  const corrupt = await fetchJson(`${base}/alerts`);
  eq([corrupt.res.status, corrupt.json?.check, corrupt.json?.alerts], [200, "unreadable", []], "a corrupt file is said to be corrupt");
  await rm(join(stateDir, "alerts.json"));
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

// ---------- the live edge, on the real server ----------
//
// A SECOND createApiServer with an injected fake spawn: this is both the live
// checks and the proof the injection point exists. The main server above
// keeps the default real spawnFn and is never WS-upgraded, exactly as
// production leaves it between camera connections.

console.log("api server: live edge");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit"));
  };
  return child;
}

const spawnCalls = [];
const fakeSpawn = (cmd, args, opts) => {
  const child = fakeChild();
  spawnCalls.push({ cmd, args, opts, child });
  return child;
};

const liveServer = createApiServer({ stateDir, config, index, spawnFn: fakeSpawn, maxPerCamera: 1 });
await new Promise((resolve) => liveServer.listen(0, "127.0.0.1", resolve));
const liveBase = `http://127.0.0.1:${liveServer.address().port}`;

const wsOpen = (path) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${liveServer.address().port}${path}`);
    ws.binaryType = "arraybuffer"; // native client delivers binary as ArrayBuffer, not Buffer
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("ws error: " + (e.error?.message ?? e.message ?? "unknown"))); });
  });
const nextMessage = (ws, ms2 = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), ms2);
    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      // Binary arrives as ArrayBuffer (binaryType set above); a refusal is a
      // TEXT frame and arrives as a string — Buffer.from(string) is the path
      // live.harness's proven helper takes too.
      resolve(ev.data instanceof Buffer
        ? ev.data
        : Buffer.from(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data));
    }, { once: true });
  });
const nextClose = (ws) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 3000);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve("closed"); }, { once: true });
  });

await check("the live edge rides the api server's own port — bytes flow through the real server", async () => {
  const ws = await wsOpen("/live/cam-1");
  const call = spawnCalls[spawnCalls.length - 1];
  eq(call.cmd, "ffmpeg", "the transport spawns ffmpeg");
  const i = call.args.indexOf("-i");
  eq(i !== -1, true, "argv has -i");
  eq(call.args[i + 1], "rtsp://admin:hunter2@10.0.0.5:8554/live", "the negotiated url rides the argv");
  const chunk = fill(91, 3000);
  call.child.stdout.emit("data", chunk);
  const msg = await nextMessage(ws);
  eq(msg.equals(chunk), true, "byte-exact through the real server");
  const entry = [...liveRegistry().values()].find((e) => e.cameraId === "cam-1");
  eq(entry !== undefined, true, "the negotiated stream is in the registry");
  ws.close();
  await nextClose(ws);
  await new Promise((r) => setTimeout(r, 50));
});

await check("plain GET /live/... is a route miss, not a hang", async () => {
  const { res, json } = await fetchJson(`${liveBase}/live/cam-1`);
  eq(res.status, 404, "status");
  eq(json.code, "no_such_route", "the HTTP router answers; the upgrade handler did not eat the request");
});

await check("unknown camera: the refusal envelope, then the close", async () => {
  const ws = await wsOpen("/live/nope");
  const env = JSON.parse((await nextMessage(ws)).toString());
  eq([env.ok, env.code], [false, "unknown_camera"], "refused before any spawn");
  eq(liveRegistry().size, 0, "no slot held");
  await nextClose(ws);
});

await check("the per-camera cap is enforced through the real server", async () => {
  const w1 = await wsOpen("/live/cam-1");
  eq(liveRegistry().size, 1, "first stream held (maxPerCamera 1)");
  const w2 = await wsOpen("/live/cam-1");
  const env = JSON.parse((await nextMessage(w2)).toString());
  eq([env.ok, env.code], [false, "camera_busy"], "second refused");
  await nextClose(w2);
  w1.close();
  await nextClose(w1);
  await new Promise((r) => setTimeout(r, 50));
});

// ---------- the live grid UI (A3 slice 1): the pure half, and its two routes ----------
// The pure module is imported by the browser page and this harness IDENTICALLY
// — every check below runs with no document, which is the module's contract.
// The MP4 fixtures are hand-built (deterministic, non-zero) because the feared
// part is box arithmetic, not ffmpeg.

const lbU32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const lbFcc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const lbCat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const lbBox = (type, payload) => {
  const s = 8 + payload.length;
  return lbCat(lbU32(s), lbFcc(type), payload);
};
// init segment: ftyp + a moov whose trak chain reaches stsd with `entries`.
const lbInit = (...entries) => lbCat(
  lbBox("ftyp", lbU32(0)),
  lbBox("moov", lbBox("trak", lbBox("mdia", lbBox("minf", lbBox("stbl",
    lbBox("stsd", lbCat(new Uint8Array(4), lbU32(entries.length), ...entries))))))),
);
// A video sample entry: 8-byte header + 78 fixed VisualSampleEntry bytes + children.
const lbVideoEntry = (type, ...children) => lbBox(type, lbCat(new Uint8Array(78), ...children));
// An audio sample entry: 8 + 28 fixed bytes + children.
const lbAudioEntry = (...children) => lbBox("mp4a", lbCat(new Uint8Array(28), ...children));
// esds chain with self-consistent expandable-128 lengths: ES(0x16) = ES_ID+flags
// + DCD(0x11 = 13 fixed + DSI(0x02)); ASC [0x12,0x08] = AAC-LC, aot 2.
const lbEsds = lbBox("esds", Uint8Array.of(
  0, 0, 0, 0, 0x03, 0x16, 0x00, 0x01, 0x00,
  0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x08));

await check("box accumulator: every chunk-boundary class re-assembles byte-exactly", async () => {
  const ftyp = lbBox("ftyp", lbU32(0));
  const moov = lbBox("moov", lbBox("trak", new Uint8Array(10)));
  const moof = lbBox("moof", new Uint8Array(6));
  const mdat = lbBox("mdat", new Uint8Array(30));
  const stream = lbCat(ftyp, moov, moof, mdat);
  for (const step of [1, 3, 7]) {
    const acc = createBoxAccumulator();
    const ems = [];
    for (let i = 0; i < stream.length; i += step) {
      ems.push(...acc.push(stream.subarray(i, Math.min(i + step, stream.length))));
    }
    ems.push(...acc.flush());
    eq(ems.length, 2, `step ${step}: exactly one init emission + one moof+mdat emission`);
    eq(Buffer.from(ems[0]).equals(Buffer.from(lbCat(ftyp, moov))), true, `step ${step}: init = ftyp through moov`);
    eq(Buffer.from(ems[1]).equals(Buffer.from(lbCat(moof, mdat))), true, `step ${step}: media = moof+mdat as ONE buffer`);
    eq(Buffer.from(lbCat(...ems)).equals(Buffer.from(stream)), true, `step ${step}: concatenation is byte-equal to the stream`);
  }
});

await check("a 64-bit largesize box arrives whole and passes through individually", async () => {
  const ftyp = lbBox("ftyp", lbU32(0));
  const moov = lbBox("moov", lbBox("trak", new Uint8Array(10)));
  // size=1 -> the next 8 bytes are the u64 largesize (big-endian: high word 0).
  const big = lbCat(lbU32(1), lbFcc("free"), lbU32(0), lbU32(20), lbU32(7));
  const acc = createBoxAccumulator();
  const ems = acc.push(lbCat(ftyp, moov, big));
  eq(ems.length, 2, "init emission + the free box");
  eq(Buffer.from(ems[1]).equals(Buffer.from(big)), true, "the largesize box emitted whole");
});

await check("a size === 0 box (extends to end of stream) waits for flush", async () => {
  const zero = lbCat(lbU32(0), lbFcc("mdat"));
  const acc = createBoxAccumulator();
  const pushed = acc.push(lbCat(lbBox("ftyp", lbU32(0)), lbBox("moov", lbBox("trak", new Uint8Array(10))), zero));
  eq(pushed.length, 1, "only the init emission; the size-0 box is held");
  const flushed = acc.flush();
  eq(flushed.length, 1, "flush emits it");
  eq(Buffer.from(flushed[0]).equals(Buffer.from(zero)), true, "byte-equal");
});

await check("a trailing partial box waits for flush (a broken append beats dropped bytes)", async () => {
  const acc = createBoxAccumulator();
  const whole = lbCat(lbBox("ftyp", lbU32(0)), lbBox("moov", lbBox("trak", new Uint8Array(10))), lbBox("moof", new Uint8Array(6)), lbBox("mdat", new Uint8Array(30)));
  const partial = lbBox("moof", new Uint8Array(6)).subarray(0, 10); // header + half the body
  const ems = acc.push(whole);
  eq(ems.length, 2, "the complete part emits normally");
  const flushed = acc.push(partial).concat(acc.flush());
  eq(flushed.length, 1, "the partial is flushed, not silently dropped");
  eq(flushed[0].length, 10, "byte-exact remainder");
});

await check("extractMimeCodec: avc1 High@L4.0 + mp4a AAC-LC (one stsd, two entries)", async () => {
  const avcC = lbBox("avcC", Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff, 0xe1)); // profile, compat, level
  const mp4a = lbAudioEntry(lbEsds);
  const r = extractMimeCodec(lbInit(lbVideoEntry("avc1", avcC), mp4a));
  eq(r.mime, 'video/mp4; codecs="avc1.640028, mp4a.40.2"', "the exact string");
});

await check("extractMimeCodec: hvc1 Main@L3.1 (the fleet's actual codec)", async () => {
  // hvcC payload: configVersion 1, byte1 = space 0 | tier L | idc 1, compat
  // 0x60000000 (reversed -> 6), constraints B0 + zeros, level 93.
  const hvcC = lbBox("hvcC", Uint8Array.of(1, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0, 0, 0, 0, 0, 93));
  const r = extractMimeCodec(lbInit(lbVideoEntry("hvc1", hvcC)));
  eq(r.mime, 'video/mp4; codecs="hvc1.1.6.L93.B0"', "Main@L3.1 per the verified recipe");
});

await check("extractMimeCodec: separate video and audio traks (what ffmpeg actually emits)", async () => {
  const avcC = lbBox("avcC", Uint8Array.of(1, 0x64, 0x00, 0x28, 0xff, 0xe1));
  const init = lbCat(
    lbBox("ftyp", lbU32(0)),
    lbBox("moov", lbCat(
      lbBox("trak", lbBox("mdia", lbBox("minf", lbBox("stbl",
        lbBox("stsd", lbCat(new Uint8Array(4), lbU32(1), lbVideoEntry("avc1", avcC))))))),
      lbBox("trak", lbBox("mdia", lbBox("minf", lbBox("stbl",
        lbBox("stsd", lbCat(new Uint8Array(4), lbU32(1), lbAudioEntry(lbEsds))))))))));
  const r = extractMimeCodec(init);
  eq(r.mime, 'video/mp4; codecs="avc1.640028, mp4a.40.2"', "both traks found");
});

await check("extractMimeCodec refusals are values, never throws", async () => {
  const ftypOnly = lbBox("ftyp", lbU32(0));
  eq(extractMimeCodec(ftypOnly).error !== undefined, true, "no moov");
  eq(extractMimeCodec(lbCat(ftypOnly, lbBox("moov", new Uint8Array(4)))).error !== undefined, true, "moov with no video track");
  const bareAVC = lbVideoEntry("avc1"); // no avcC child
  const bareHEV = lbVideoEntry("hev1"); // no hvcC child
  eq(extractMimeCodec(lbInit(bareAVC)).error !== undefined, true, "avc1 without avcC");
  eq(extractMimeCodec(lbInit(bareHEV)).error !== undefined, true, "hev1 without hvcC");
});

await check("GET / serves the live grid page", async () => {
  const { res, text } = await fetchJson(`${base}/`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "text/html; charset=utf-8", "the page's type");
  eq(text.includes("/ui/live-client.js"), true, "the page loads the pure module");
  eq(text.includes("/live/"), true, "the page speaks the live edge");
  eq(res.headers.get("cache-control"), "no-store", "edits land without a restart");
});

await check("GET /ui/live-client.js serves the pure module byte-equal to disk", async () => {
  const { res, text } = await fetchJson(`${base}/ui/live-client.js`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "text/javascript", "a module type the browser executes");
  const onDisk = await readFile(join(import.meta.dirname, "..", "agent", "ui", "live-client.mjs"), "utf8");
  eq(text, onDisk, "the browser runs the identical file the harness tested");
});

await check("THE FEARED ONE: /playback never sends the storage path to the browser", async () => {
  const { json } = await fetchJson(`${base}/playback?camera=cam-1&at=2026-09-11T10:00:30Z`);
  eq(json.resolution.kind, "segment", "a segment resolution");
  eq(Object.hasOwn(json.resolution, "path"), false, "no path key");
  eq(JSON.stringify(json).includes("cam-1/"), false, "no storage layout anywhere in the body");
  const plan = planPlayback(json);
  eq(plan.action, "play", "the page's own planner plays it");
  eq(plan.src, `/segments/${idOf(T.A)}`, "through the segment route");
});

await check("GET /review serves the review page", async () => {
  const { res, text } = await fetchJson(`${base}/review`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "text/html; charset=utf-8", "the page's type");
  eq(text.includes("/ui/review-client.js"), true, "the page loads the pure module");
  eq(text.includes("/timeline"), true, "the page asks for coverage");
  eq(text.includes("/playback"), true, "the page resolves a click");
  eq(res.headers.get("cache-control"), "no-store", "edits land without a restart");
});

await check("GET /ui/review-client.js serves the pure module byte-equal to disk", async () => {
  const { res, text } = await fetchJson(`${base}/ui/review-client.js`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "text/javascript", "a module type the browser executes");
  const onDisk = await readFile(join(import.meta.dirname, "..", "agent", "ui", "review-client.mjs"), "utf8");
  eq(text, onDisk, "the browser runs the identical file the harness tested");
});

await check("the live page links to review", async () => {
  const { text } = await fetchJson(`${base}/`);
  eq(text.includes('href="/review"'), true, "a Review link");
});

await check("layoutCoverage accepts a real /timeline body, including a clipped one", async () => {
  const past = await fetchJson(
    `${base}/timeline?camera=cam-1&start=2026-09-11T10:00:00Z&end=2026-09-11T10:06:00Z`);
  const a = layoutCoverage(past.json);
  eq(a.error, undefined, `a closed window lays out: ${a.error}`);
  eq(a.bars.map((b) => b.kind).join(","), "recorded,gap,recorded", "the runs, in order");
  const today = await fetchJson(
    `${base}/timeline?camera=cam-1&start=2026-09-11T10:00:00Z&end=2026-09-11T13:00:00Z`);
  const b = layoutCoverage(today.json);
  eq(b.error, undefined, `a clipped window lays out: ${b.error}`);
  eq(b.bars.at(-1).kind, "future", "the part after now is its own kind");
});

await check("GET /ui/nope is a route miss", async () => {
  const { res, json } = await fetchJson(`${base}/ui/nope`);
  eq(res.status, 404, "status");
  eq(json.code, "no_such_route", "the HTTP router still answers");
});

// ---------- /export (EXPORT-SPEC.md §3) ----------
// Its fixtures go in HERE, after every check above has run: /health counts
// segments and the cam-2 timeline check expects nothing recorded.
//
// cam-2: E 10:00-10:01, F 10:01-10:02, a logged outage 10:02-10:04, G 10:04-10:05.
// cam-3: H's file is LONGER than the index says, I's is SHORTER.

console.log("api server: export");

const X = {
  E: "2026-09-11T10:00:00Z", F: "2026-09-11T10:01:00Z", G: "2026-09-11T10:04:00Z",
  H: "2026-09-11T10:00:00Z", I: "2026-09-11T11:00:00Z",
};
const exportBytes = { E: fill(404, 700), F: fill(505, 1200), G: fill(606, 300), H: fill(707, 900), I: fill(808, 700) };
await mkdir(join(disk0, "cam-2"), { recursive: true });
await mkdir(join(disk0, "cam-3"), { recursive: true });
for (const k of ["E", "F", "G"]) await writeFile(join(disk0, "cam-2", `${ms(X[k])}.mp4`), exportBytes[k]);
for (const k of ["H", "I"]) await writeFile(join(disk0, "cam-3", `${ms(X[k])}.mp4`), exportBytes[k]);
const plusMin = (iso) => new Date(ms(iso) + 60_000).toISOString();
for (const k of ["E", "F", "G"]) {
  index.put(seg("cam-2", X[k], plusMin(X[k]), `cam-2/${ms(X[k])}.mp4`, exportBytes[k].length, "sealed"));
}
index.addGap({ cameraId: "cam-2", startUtc: "2026-09-11T10:02:00Z", endUtc: "2026-09-11T10:04:00Z", reason: "camera_offline" });
index.put(seg("cam-3", X.H, plusMin(X.H), `cam-3/${ms(X.H)}.mp4`, 800, "sealed"));
index.put(seg("cam-3", X.I, plusMin(X.I), `cam-3/${ms(X.I)}.mp4`, 800, "sealed"));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A download that must FAIL VISIBLY: the request or its body read rejects.
 *  Returns how many body bytes arrived before it did, or throws if the body
 *  completed, which is the feared failure itself. */
async function expectBrokenDownload(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    return { status: null, received: 0 };
  }
  const reader = res.body.getReader();
  let received = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(value);
    }
  } catch {
    return { status: res.status, received, body: Buffer.concat(chunks) };
  }
  throw new Error(`the download completed (${received} bytes, status ${res.status}); it must have failed`);
}

await check("/export streams whole segments, the gap and a manifest built from what was sent", async () => {
  const res = await fetch(`${base}/export?camera=cam-2&start=2026-09-11T10:00:30Z&end=2026-09-11T10:04:30Z`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "application/zip", "content type");
  eq(res.headers.get("content-disposition"),
    'attachment; filename="cam-2_2026-09-11T10-00-30.000Z_2026-09-11T10-04-30.000Z.zip"', "filename from the effective range");
  eq(res.headers.get("content-length"), null, "no Content-Length: an aborted body must not look complete");
  const zip = new Uint8Array(await res.arrayBuffer());
  const entries = readZip(zip);
  eq(entries.map((e) => e.name), [
    "cam-2/2026-09-11T10-00-00.000Z.mp4",
    "cam-2/2026-09-11T10-01-00.000Z.mp4",
    "cam-2/2026-09-11T10-04-00.000Z.mp4",
    "manifest.json",
  ], "one file per segment, never joined, manifest last");
  eq(Buffer.from(entries[0].data).equals(exportBytes.E), true, "E byte-exact");
  eq(Buffer.from(entries[1].data).equals(exportBytes.F), true, "F byte-exact");
  eq(Buffer.from(entries[2].data).equals(exportBytes.G), true, "G byte-exact");

  const manifest = JSON.parse(Buffer.from(entries[3].data).toString("latin1"));
  eq(manifest.siteId, "carwash-01", "site");
  eq(manifest.cameraId, "cam-2", "camera");
  eq(manifest.generatedAtUtc, now().toISOString(), "generated on the server's clock");
  eq(manifest.requested, { startUtc: "2026-09-11T10:00:30.000Z", endUtc: "2026-09-11T10:04:30.000Z" }, "requested");
  eq(manifest.delivered, { startUtc: "2026-09-11T10:00:00.000Z", endUtc: "2026-09-11T10:05:00.000Z" }, "delivered is whole segments");
  eq(manifest.files.map((f) => [f.name, f.bytes, f.sha256]), [
    ["cam-2/2026-09-11T10-00-00.000Z.mp4", 700, sha256(exportBytes.E)],
    ["cam-2/2026-09-11T10-01-00.000Z.mp4", 1200, sha256(exportBytes.F)],
    ["cam-2/2026-09-11T10-04-00.000Z.mp4", 300, sha256(exportBytes.G)],
  ], "names, sizes and SHA-256 of the bytes actually sent");
  eq(manifest.gaps, [{ startUtc: "2026-09-11T10:02:00.000Z", endUtc: "2026-09-11T10:04:00.000Z", reason: "camera_offline", source: "logged" }],
    "THE FEARED ONE: the outage is declared, not stitched over");
});

await check("THE FEARED ONE: no storage path in the export, its headers, or its manifest", async () => {
  const res = await fetch(`${base}/export?camera=cam-2&start=2026-09-11T10:00:30Z&end=2026-09-11T10:04:30Z`);
  eq(res.status, 200, "status: a refusal here would pass every check below vacuously");
  const zip = Buffer.from(await res.arrayBuffer());
  const asText = zip.toString("latin1") + JSON.stringify([...res.headers]);
  for (const k of ["E", "F", "G"]) {
    eq(asText.includes(String(ms(X[k]))), false, `no storage file name for ${k}`);
  }
  eq(asText.includes(disk0), false, "no store root");
  eq(asText.includes('"path"'), false, "no path key");
  eq(asText.includes("segmentId"), false, "no segmentId key");
});

await check("/export refusals are JSON with the contract's status and code, and no attachment", async () => {
  const cases = [
    [`/export?camera=..%2Fx&start=2026-09-11T10:00:00Z&end=2026-09-11T10:06:00Z`, 400, "bad_camera_id"],
    [`/export?camera=cam-2&start=2026-09-11T10:00:00Z`, 400, "missing_parameter"],
    [`/export?camera=cam-2&start=2026-09-12T10:00:00Z&end=2026-09-12T11:00:00Z`, 422, "window_in_future"],
    [`/export?camera=cam-1&start=2026-09-11T11:50:00Z&end=2026-09-11T12:00:00Z`, 422, "export_reaches_recording"],
    [`/export?camera=cam-2&start=2026-09-11T08:00:00Z&end=2026-09-11T09:00:00Z`, 422, "export_nothing_recorded"],
    [`/export?camera=cam-1&start=2026-09-11T10:01:00Z&end=2026-09-11T10:02:00Z`, 422, "export_size_unknown"],
  ];
  for (const [url, status, code] of cases) {
    const { res, json } = await fetchJson(`${base}${url}`);
    eq(res.status, status, `${code} status`);
    eq(json?.code, code, `${code} code`);
    eq(json?.ok, false, `${code} envelope`);
    eq(res.headers.get("content-type"), "application/json", `${code} is JSON`);
    eq(res.headers.get("content-disposition"), null, `${code} starts no download`);
  }
  const live = await fetchJson(`${base}/export?camera=cam-1&start=2026-09-11T11:50:00Z&end=2026-09-11T12:00:00Z`);
  eq(live.json.message.includes("2026-09-11T11:58:00.000Z"), true, "names the instant to end before");
});

await check("THE FEARED ONE: a segment the disk lost breaks the download, never a short valid ZIP", async () => {
  const r = await expectBrokenDownload(`${base}/export?camera=cam-1&start=2026-09-11T09:00:00Z&end=2026-09-11T09:01:00Z`);
  if (r.body) eq(r.body.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false, "no end-of-central-directory went out");
});

await check("THE FEARED ONE: a file longer than planned breaks the download, and no byte past the plan is sent", async () => {
  const r = await expectBrokenDownload(`${base}/export?camera=cam-3&start=2026-09-11T10:00:00Z&end=2026-09-11T10:01:00Z`);
  if (r.body) {
    eq(r.body.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false, "no end-of-central-directory went out");
    eq(r.body.includes(exportBytes.H.subarray(0, 64)), false, "H's bytes never left: the over-long chunk is refused before it is written");
  }
});

await check("THE FEARED ONE: a file shorter than planned breaks the download", async () => {
  const r = await expectBrokenDownload(`${base}/export?camera=cam-3&start=2026-09-11T11:00:00Z&end=2026-09-11T11:01:00Z`);
  if (r.body) eq(r.body.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false, "no end-of-central-directory went out");
});

await check("/export/plan describes exactly what /export sends for the same query", async () => {
  const q = "camera=cam-2&start=2026-09-11T10:00:30Z&end=2026-09-11T10:04:30Z";
  const { res, json } = await fetchJson(`${base}/export/plan?${q}`);
  eq(res.status, 200, "status");
  eq(res.headers.get("content-type"), "application/json", "JSON");
  eq(res.headers.get("cache-control"), "no-store", "not cached: the store changes under it");
  eq(res.headers.get("content-disposition"), null, "starts no download");
  eq(Object.keys(json), ["ok", "cameraId", "requested", "delivered", "fileCount", "totalBytes", "recordedSeconds", "gapSeconds", "gaps"], "exactly these keys, in order");
  eq(json.ok, true, "ok");
  eq(json.cameraId, "cam-2", "camera");
  eq(json.fileCount, 3, "three whole segments");
  eq(json.totalBytes, 2200, "700 + 1200 + 300 bytes");
  const zipRes = await fetch(`${base}/export?${q}`);
  eq(zipRes.status, 200, "the export itself");
  const entries = readZip(new Uint8Array(await zipRes.arrayBuffer()));
  const manifest = JSON.parse(Buffer.from(entries.at(-1).data).toString("latin1"));
  eq(json.requested, manifest.requested, "requested matches the manifest");
  eq(json.delivered, manifest.delivered, "delivered matches the manifest");
  eq(json.fileCount, manifest.files.length, "file count matches the manifest");
  eq(json.totalBytes, manifest.files.reduce((n, f) => n + f.bytes, 0), "bytes match what was sent");
  eq(json.recordedSeconds, manifest.recordedSeconds, "recorded seconds match");
  eq(json.gapSeconds, manifest.gapSeconds, "gap seconds match");
  eq(json.gaps, manifest.gaps, "THE FEARED ONE: the gap the download will declare is shown before it");
});

await check("THE FEARED ONE: /export/plan carries no storage path, file name or segment id", async () => {
  const res = await fetch(`${base}/export/plan?camera=cam-2&start=2026-09-11T10:00:30Z&end=2026-09-11T10:04:30Z`);
  eq(res.status, 200, "status: a refusal here would pass every check below vacuously");
  const text = await res.text() + JSON.stringify([...res.headers]);
  for (const k of ["E", "F", "G"]) eq(text.includes(String(ms(X[k]))), false, `no storage file name for ${k}`);
  eq(text.includes(disk0), false, "no store root");
  for (const key of ['"path"', "segmentId", '"name"', '"files"', ".mp4"]) eq(text.includes(key), false, `no ${key}`);
});

await check("/export/plan refuses exactly what /export refuses, with the same words", async () => {
  const queries = [
    ["camera=..%2Fx&start=2026-09-11T10:00:00Z&end=2026-09-11T10:06:00Z", "bad_camera_id"],
    ["camera=cam-2&start=2026-09-11T10:00:00Z", "missing_parameter"],
    ["camera=cam-2&start=2026-09-12T10:00:00Z&end=2026-09-12T11:00:00Z", "window_in_future"],
    ["camera=cam-1&start=2026-09-11T11:50:00Z&end=2026-09-11T12:00:00Z", "export_reaches_recording"],
    ["camera=cam-2&start=2026-09-11T08:00:00Z&end=2026-09-11T09:00:00Z", "export_nothing_recorded"],
    ["camera=cam-1&start=2026-09-11T10:01:00Z&end=2026-09-11T10:02:00Z", "export_size_unknown"],
  ];
  for (const [q, code] of queries) {
    const plan = await fetchJson(`${base}/export/plan?${q}`);
    const real = await fetchJson(`${base}/export?${q}`);
    eq(real.json?.code, code, `/export refuses it as ${code} (else this case proves nothing)`);
    eq([plan.res.status, plan.json?.ok, plan.json?.code, plan.json?.message],
      [real.res.status, real.json.ok, real.json.code, real.json.message], `${real.json.code}: same status, code and message`);
    eq(plan.res.headers.get("content-type"), "application/json", `${real.json.code} is JSON`);
  }
});

await check("the server outlives a broken export", async () => {
  const { res, json } = await fetchJson(`${base}/health`);
  eq(res.status, 200, "status");
  eq(json.ok, true, "still answering");
});

closeAll(); // the live registry and its watchdog end here — nothing outlives the harness
liveServer.close();
server.close();
index.close();
await rm(stateDir, { recursive: true, force: true });
report("api server");