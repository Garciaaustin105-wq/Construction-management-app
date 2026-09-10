/** The recording index. The failure feared: a gap rendering as "nothing
 *  happened" during a break-in investigation. */
import { buildTimeline, coverage, totalRecordedBytes, isGap } from "../dist/segment.js";
import { check, eq, close, throws, report } from "./_assert.mjs";

console.log("segment");
const RANGE = { startUtc: "2026-09-10T00:00:00.000Z", endUtc: "2026-09-10T04:00:00.000Z" };
const span = (startUtc, endUtc, bytes = 1000) => ({
  cameraId: "cam-1", startUtc, endUtc, tier: "s3",
  key: `k/${startUtc}`, bytes, codec: "h265", bitrateKbps: 2000,
});

check("no recording at all yields ONE explicit gap, not an empty list", () => {
  const t = buildTimeline("cam-1", [], RANGE, "appliance_offline");
  eq(t.length, 1, "segments");
  eq(t[0].tier, "gap", "tier");
  eq(t[0].gapReason, "appliance_offline", "reason");
  eq(t[0].startUtc, RANGE.startUtc, "covers from range start");
  eq(t[0].endUtc, RANGE.endUtc, "covers to range end");
});

check("THE FEARED ONE: a mid-window outage is an explicit gap with a reason", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T00:00:00.000Z", "2026-09-10T02:10:00.000Z"),
    span("2026-09-10T03:00:00.000Z", "2026-09-10T04:00:00.000Z"),
  ], RANGE, "camera_offline");
  eq(t.length, 3, "segments");
  eq(t[1].tier, "gap", "middle is a gap");
  eq(t[1].startUtc, "2026-09-10T02:10:00.000Z", "gap starts when recording stopped");
  eq(t[1].endUtc, "2026-09-10T03:00:00.000Z", "gap ends when recording resumed");
  eq(t[1].gapReason, "camera_offline", "reason survives to the UI");
});

check("a gap carries bytes: null, NOT 0", () => {
  const t = buildTimeline("cam-1", [], RANGE);
  eq(t[0].bytes, null, "bytes");
  if (t[0].bytes === 0) throw new Error("an outage summed as free footage");
});

check("totalRecordedBytes skips gaps rather than adding zero", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z", 500),
    span("2026-09-10T03:00:00.000Z", "2026-09-10T04:00:00.000Z", 700),
  ], RANGE);
  eq(totalRecordedBytes(t), 1200, "bytes");
  eq(t.filter(isGap).length, 1, "one gap present");
});

check("PARALLEL RUN: overlapping spans from two recorders merge, not duplicate", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T00:00:00.000Z", "2026-09-10T02:30:00.000Z"),
    span("2026-09-10T02:00:00.000Z", "2026-09-10T04:00:00.000Z"),
  ], RANGE);
  eq(t.filter(isGap).length, 0, "no gaps");
  const c = coverage(t);
  close(c.ratio, 1, 1e-9, "full coverage");
  close(c.recordedSeconds, 4 * 3600, 0.001, "no double counting");
});

check("a span fully swallowed by another is dropped", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T00:00:00.000Z", "2026-09-10T04:00:00.000Z"),
    span("2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z"),
  ], RANGE);
  eq(t.length, 1, "segments");
  eq(t[0].tier, "s3", "tier");
});

check("spans are clipped to the query window", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-09T22:00:00.000Z", "2026-09-10T05:00:00.000Z"),
  ], RANGE);
  eq(t.length, 1, "segments");
  eq(t[0].startUtc, RANGE.startUtc, "clipped start");
  eq(t[0].endUtc, RANGE.endUtc, "clipped end");
});

check("spans entirely outside the window are dropped, leaving a gap", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-08T00:00:00.000Z", "2026-09-08T01:00:00.000Z"),
  ], RANGE);
  eq(t.length, 1, "segments");
  eq(t[0].tier, "gap", "tier");
});

check("unsorted input is handled", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T03:00:00.000Z", "2026-09-10T04:00:00.000Z"),
    span("2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z"),
  ], RANGE);
  eq(t.length, 3, "segments");
  eq(t[0].tier, "s3", "first is recorded");
  eq(t[1].tier, "gap", "gap between");
});

check("the timeline is always contiguous and covers the whole window", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T00:30:00.000Z", "2026-09-10T01:00:00.000Z"),
    span("2026-09-10T02:00:00.000Z", "2026-09-10T02:15:00.000Z"),
  ], RANGE);
  eq(t[0].startUtc, RANGE.startUtc, "starts at window start");
  eq(t[t.length - 1].endUtc, RANGE.endUtc, "ends at window end");
  for (let i = 1; i < t.length; i++) {
    eq(t[i].startUtc, t[i - 1].endUtc, `segment ${i} abuts segment ${i - 1}`);
  }
});

check("coverage attributes lost time to its reason", () => {
  const t = buildTimeline("cam-1", [
    span("2026-09-10T00:00:00.000Z", "2026-09-10T03:00:00.000Z"),
  ], RANGE, "tampered");
  const c = coverage(t);
  close(c.ratio, 0.75, 1e-9, "ratio");
  close(c.gapsByReason.tampered, 3600, 0.001, "seconds attributed to tampering");
});

check("an inverted range is refused, not silently swapped", () => {
  throws(() => buildTimeline("cam-1", [], {
    startUtc: "2026-09-10T04:00:00.000Z", endUtc: "2026-09-10T00:00:00.000Z",
  }), "inverted range");
});

check("a zero-length range is refused", () => {
  throws(() => buildTimeline("cam-1", [], {
    startUtc: "2026-09-10T00:00:00.000Z", endUtc: "2026-09-10T00:00:00.000Z",
  }), "zero-length range");
});

check("a span for the wrong camera is refused, not silently included", () => {
  throws(() => buildTimeline("cam-1", [
    { ...span("2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z"), cameraId: "cam-9" },
  ], RANGE), "foreign camera");
});

check("an unparseable timestamp is refused, not NaN", () => {
  throws(() => buildTimeline("cam-1", [], { startUtc: "yesterday", endUtc: "today" }));
});

report("segment");
