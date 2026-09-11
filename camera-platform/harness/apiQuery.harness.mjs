/** Client input to the local API. The failure feared is a plausible answer to a
 *  question nobody asked: a local-time instant read in the appliance's zone, a
 *  30 February rolled into March, a window into the future answered as if full. */
import {
  parseInstant, parseWindow, isCameraId, segmentId, parseSegmentId,
  DEFAULT_BUCKETS, MAX_WINDOW_SECONDS, CAMERA_ID_PATTERN,
} from "../dist/apiQuery.js";
import { check, same, throws, report } from "./_assert.mjs";

console.log("apiQuery");

const NOW = "2026-09-10T12:00:00.000Z";
const NOW_MS = Date.UTC(2026, 8, 10, 12);
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

const refused = (result, status, code, what) => {
  if (result.ok !== false) throw new Error(`${what}: expected a refusal, got ${JSON.stringify(result)}`);
  same([result.status, result.code], [status, code], what);
  if (typeof result.message !== "string" || result.message === "") throw new Error(`${what}: no message`);
};

check("an instant in Z parses to its epoch ms and a normalised string", () => {
  same(parseInstant("2026-09-10T12:00:00Z"), { ok: true, ms: NOW_MS, utc: NOW }, "Z");
  same(parseInstant("2026-09-10T12:00Z").ms, NOW_MS, "seconds optional");
});

check("an offset is honoured, not dropped", () => {
  same(parseInstant("2026-09-10T14:00:00+02:00").utc, NOW, "+02:00");
  same(parseInstant("2026-09-10T06:30:00-05:30").utc, NOW, "-05:30");
  same(parseInstant("2026-09-11T02:00:00+14:00").utc, NOW, "+14:00, the furthest real offset");
});

check("fractions are truncated to milliseconds, never rounded up", () => {
  same(parseInstant("2026-09-10T12:00:00.5Z").ms, NOW_MS + 500, ".5");
  same(parseInstant("2026-09-10T12:00:00.123456789Z").ms, NOW_MS + 123, "nanoseconds");
  same(parseInstant("2026-09-10T12:00:00.9999Z").ms, NOW_MS + 999, "not rounded into the next second");
});

check("THE FEARED ONE: an instant with no offset is refused, not read as local", () => {
  refused(parseInstant("2026-09-10T12:00:00"), 400, "bad_instant", "no offset");
  refused(parseInstant("2026-09-10T12:00:00.000"), 400, "bad_instant", "no offset, with ms");
  refused(parseInstant("2026-09-10"), 400, "bad_instant", "date only");
});

check("THE FEARED ONE: a date that does not exist is refused, not rolled over", () => {
  for (const bad of ["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-09-00T00:00:00Z"]) {
    refused(parseInstant(bad), 400, "bad_instant", bad);
  }
  same(parseInstant("2028-02-29T00:00:00Z").ok, true, "29 February in a leap year is real");
});

check("out-of-range clock fields are refused", () => {
  for (const bad of ["2026-09-10T24:00:00Z", "2026-09-10T12:60:00Z", "2026-09-10T23:59:60Z",
    "2026-09-10T12:00:00+15:00", "2026-09-10T12:00:00+02:60", "2026-09-10T12:00:00+0200"]) {
    refused(parseInstant(bad), 400, "bad_instant", bad);
  }
});

check("other shapes are refused: lower case, epoch numbers, junk", () => {
  for (const bad of ["2026-09-10t12:00:00z", "2026-09-10T12:00:00z", "1757505600000", "now",
    " 2026-09-10T12:00:00Z", "2026-09-10T12:00:00Z ", "2026-09-10T12:00:00ZZ", "2026-9-10T12:00:00Z"]) {
    refused(parseInstant(bad), 400, "bad_instant", JSON.stringify(bad));
  }
  refused(parseInstant(5), 400, "bad_instant", "a number");
});

check("THE FEARED ONE: a '+' that the query string turned into a space is explained", () => {
  const r = parseInstant("2026-09-10T14:00:00 02:00", "start");
  refused(r, 400, "bad_instant", "space offset");
  if (!r.message.includes("%2B")) throw new Error(`message does not tell them to write %2B: ${r.message}`);
});

check("a missing instant is missing, and the message names it", () => {
  for (const raw of [undefined, null, ""]) {
    const r = parseInstant(raw, "start");
    refused(r, 400, "missing_parameter", JSON.stringify(raw));
    if (!r.message.includes("start")) throw new Error(`message does not name the parameter: ${r.message}`);
  }
});

check("a full window in the past is answered as asked", () => {
  const w = parseWindow({ start: "2026-09-10T11:00:00Z", end: "2026-09-10T12:00:00Z" }, NOW);
  same(w, {
    ok: true,
    requested: { startUtc: "2026-09-10T11:00:00.000Z", endUtc: NOW },
    effective: { startUtc: "2026-09-10T11:00:00.000Z", endUtc: NOW },
    clippedToNow: false,
    bucketCount: DEFAULT_BUCKETS,
  }, "window");
});

check("a window is normalised to Z whatever offset it arrived in", () => {
  const w = parseWindow({ start: "2026-09-10T13:00:00+02:00", end: "2026-09-10T08:00:00-04:00" }, NOW);
  same(w.requested, { startUtc: "2026-09-10T11:00:00.000Z", endUtc: NOW }, "requested");
});

check("THE FEARED ONE: a window partly in the future is clipped to now, and says so", () => {
  const w = parseWindow({ start: "2026-09-10T11:00:00Z", end: "2026-09-10T13:00:00Z" }, NOW);
  same(w.ok, true, "answered");
  same(w.requested.endUtc, "2026-09-10T13:00:00.000Z", "the request is reported as made");
  same(w.effective.endUtc, NOW, "the answer stops at now");
  same(w.clippedToNow, true, "and admits it");
});

check("a window wholly in the future is refused — there is nothing to answer", () => {
  refused(parseWindow({ start: NOW, end: iso(NOW_MS + HOUR) }, NOW), 422, "window_in_future", "starts now");
  refused(parseWindow({ start: iso(NOW_MS + 1), end: iso(NOW_MS + HOUR) }, NOW), 422, "window_in_future",
    "starts a millisecond from now");
});

check("inverted and zero-length windows are refused", () => {
  refused(parseWindow({ start: NOW, end: "2026-09-10T11:00:00Z" }, NOW), 400, "inverted_window", "inverted");
  refused(parseWindow({ start: "2026-09-10T11:00:00Z", end: "2026-09-10T11:00:00Z" }, NOW), 400,
    "inverted_window", "zero length");
});

check("missing start or end is named", () => {
  const noStart = parseWindow({ end: NOW }, NOW);
  refused(noStart, 400, "missing_parameter", "no start");
  if (!noStart.message.includes("start")) throw new Error(`does not name start: ${noStart.message}`);
  const noEnd = parseWindow({ start: NOW }, NOW);
  refused(noEnd, 400, "missing_parameter", "no end");
  if (!noEnd.message.includes("end")) throw new Error(`does not name end: ${noEnd.message}`);
});

check("the first failure wins: a bad start is reported before a bad end", () => {
  const r = parseWindow({ start: "junk", end: "also junk" }, NOW);
  refused(r, 400, "bad_instant", "both bad");
  if (!r.message.includes("start")) throw new Error(`reported the wrong parameter: ${r.message}`);
});

check("the whole of retention fits in one request; a year does not", () => {
  const edge = parseWindow({ start: iso(NOW_MS - MAX_WINDOW_SECONDS * 1000), end: NOW }, NOW);
  same(edge.ok, true, "exactly the maximum");
  refused(parseWindow({ start: iso(NOW_MS - MAX_WINDOW_SECONDS * 1000 - 1), end: NOW }, NOW), 422,
    "window_too_large", "a millisecond over");
  refused(parseWindow({ start: "2025-09-10T12:00:00Z", end: NOW }, NOW), 422, "window_too_large", "a year");
});

check("the size cap is on the window as requested, before clipping", () => {
  refused(parseWindow({ start: iso(NOW_MS - HOUR), end: iso(NOW_MS + 40 * 86_400_000) }, NOW), 422,
    "window_too_large", "an hour of past plus forty days of future");
});

check("buckets: default, bounds, and digits only", () => {
  const w = (buckets) => parseWindow({ start: "2026-09-10T11:00:00Z", end: NOW, buckets }, NOW);
  same(w(undefined).bucketCount, DEFAULT_BUCKETS, "absent");
  same(w(null).bucketCount, DEFAULT_BUCKETS, "null");
  same(w("").bucketCount, DEFAULT_BUCKETS, "blank");
  same(w("1").bucketCount, 1, "one");
  same(w("10000").bucketCount, 10_000, "the maximum");
  for (const bad of ["0", "10001", "12.5", "-5", "1e3", "abc", " 12", "0x10"]) {
    refused(w(bad), 400, "bad_buckets", JSON.stringify(bad));
  }
});

check("camera ids: narrow, because they reach file paths", () => {
  for (const good of ["cam-1", "front_door", "A", "a".repeat(64)]) same(isCameraId(good), true, good);
  for (const bad of ["", "a".repeat(65), "../etc", "cam/1", "cam\\1", "cam 1", "cam.1", "cam-1\n", "café",
    5, null, undefined]) {
    same(isCameraId(bad), false, JSON.stringify(bad));
  }
  same(CAMERA_ID_PATTERN.test("cam-1"), true, "the exported pattern agrees");
});

check("a segment id round-trips", () => {
  const id = segmentId("cam-1", 1_757_500_000_000);
  same(id, "cam-1.1757500000000", "format");
  same(parseSegmentId(id), { ok: true, cameraId: "cam-1", startMs: 1_757_500_000_000 }, "parsed back");
  same(parseSegmentId("a-b_c.0"), { ok: true, cameraId: "a-b_c", startMs: 0 }, "start 0");
});

check("segmentId refuses to mint an id from bad parts", () => {
  throws(() => segmentId("cam/1", 1), "bad camera");
  throws(() => segmentId("cam-1", -1), "negative");
  throws(() => segmentId("cam-1", 1.5), "fractional");
  throws(() => segmentId("cam-1", Number.NaN), "NaN");
  throws(() => segmentId("cam-1", Number.MAX_SAFE_INTEGER + 2), "unsafe");
});

check("THE FEARED ONE: a segment id is never a way to name an arbitrary file", () => {
  for (const bad of ["cam-1.", ".123", "cam-1", "cam-1.-5", "cam-1.012", "cam-1.1.2", "cam/1.2", "../x.1",
    "..%2Fx.1", "cam-1.1757500000000.mp4", "cam-1.99999999999999999", "cam-1.1e12", "cam-1. 5",
    "cam-1.5\n", "", null, undefined]) {
    refused(parseSegmentId(bad), 400, "bad_segment_id", JSON.stringify(bad));
  }
});

report("apiQuery");
