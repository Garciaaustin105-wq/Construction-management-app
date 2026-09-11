/** The review timeline. The failure feared: a quiet hour and a blind hour
 *  rendering identically, so nobody notices the camera was down. */
import { buildReviewTimeline, pointsOfInterest } from "../dist/timeline.js";
import { buildTimeline, coalesceForDisplay } from "../dist/segment.js";
import { check, eq, close, throws, report } from "./_assert.mjs";

console.log("timeline");

const T0 = Date.UTC(2026, 8, 10, 0, 0, 0);
const iso = (offsetSec) => new Date(T0 + offsetSec * 1000).toISOString();
const RANGE = { startUtc: iso(0), endUtc: iso(3600) };         // one hour
const span = (fromSec, toSec) => ({
  cameraId: "cam-1", startUtc: iso(fromSec), endUtc: iso(toSec), tier: "edge",
  key: null, bytes: 1000, codec: "h265", bitrateKbps: 2500,
});
const det = (atSec, kind = "person") => ({
  cameraId: "cam-1", atUtc: iso(atSec), kind, confidence: 0.9,
});

check("detections land in the right bucket", () => {
  const t = buildReviewTimeline("cam-1", [span(0, 3600)], [det(30), det(1800)], RANGE, 60);
  eq(t.bucketSeconds, 60, "one bucket per minute");
  eq(t.totalDetections, 2, "both counted");
  eq(t.buckets[0].counts.person, 1, "first minute");
  eq(t.buckets[30].counts.person, 1, "thirty-first minute");
});

check("THE FEARED ONE: a quiet bucket and a blind bucket do not look the same", () => {
  // Recording for the first half hour only; no detections at all.
  const spans = buildTimeline("cam-1", [span(0, 1800)], RANGE, "camera_offline");
  const t = buildReviewTimeline("cam-1", spans, [], RANGE, 60);

  const quiet = t.buckets[10];
  const blind = t.buckets[50];
  eq(quiet.total, 0, "quiet bucket has no events");
  eq(blind.total, 0, "blind bucket has no events either");
  close(quiet.coverage, 1, 1e-9, "quiet bucket is fully covered");
  close(blind.coverage, 0, 1e-9, "blind bucket has no recording");
  if (quiet.coverage === blind.coverage) {
    throw new Error("nothing-happened and no-idea are indistinguishable");
  }
});

check("a blind spot is surfaced as a point of interest even with zero events", () => {
  const spans = buildTimeline("cam-1", [span(0, 1800)], RANGE, "camera_offline");
  const t = buildReviewTimeline("cam-1", spans, [det(100)], RANGE, 60);
  const poi = pointsOfInterest(t, 5);
  eq(poi[0].reason, "no_coverage", "the outage outranks routine detections");
});

check("a sparse bucket keeps its events clickable; a dense one keeps only counts", () => {
  const sparse = buildReviewTimeline("cam-1", [span(0, 3600)], [det(10), det(20)], RANGE, 60);
  eq(sparse.buckets[0].events.length, 2, "two clickable events");

  const many = Array.from({ length: 25 }, (_, i) => det(i));
  const dense = buildReviewTimeline("cam-1", [span(0, 3600)], many, RANGE, 60);
  eq(dense.buckets[0].events, null, "dense bucket drops individual events");
  eq(dense.buckets[0].total, 25, "but keeps the count");
});

check("events inside a bucket come back in time order", () => {
  const t = buildReviewTimeline("cam-1", [span(0, 3600)], [det(50), det(10), det(30)], RANGE, 60);
  eq(t.buckets[0].events.map((e) => e.atUtc), [iso(10), iso(30), iso(50)], "sorted");
});

check("detections outside the window are ignored, not clamped into the edges", () => {
  const t = buildReviewTimeline("cam-1", [span(0, 3600)], [det(-100), det(9999), det(60)], RANGE, 60);
  eq(t.totalDetections, 1, "only the one inside counts");
  eq(t.buckets[0].total, 0, "the early one did not pile into bucket 0");
  eq(t.buckets[59].total, 0, "the late one did not pile into the last bucket");
});

check("kinds are ranked — a plate at the gate outranks routine motion", () => {
  const t = buildReviewTimeline("cam-1", [span(0, 3600)], [
    det(100, "motion"), det(110, "motion"), det(120, "motion"),
    det(2000, "plate"),
  ], RANGE, 60);
  const poi = pointsOfInterest(t, 5);
  eq(poi[0].counts.plate, 1, "the plate bucket ranks first despite three motions elsewhere");
});

check("a month at 240 buckets is one bucket every three hours", () => {
  const month = { startUtc: iso(0), endUtc: new Date(T0 + 30 * 86400_000).toISOString() };
  const t = buildReviewTimeline("cam-1", [], [], month, 240);
  close(t.bucketSeconds, 30 * 86400 / 240, 1, "bucket size");
  eq(t.buckets.length, 240, "renderable");
});

check("buckets tile the whole range with no gap or overlap", () => {
  const t = buildReviewTimeline("cam-1", [], [], RANGE, 7);   // awkward divisor
  eq(t.buckets[0].startUtc, RANGE.startUtc, "starts at range start");
  eq(t.buckets[6].endUtc, RANGE.endUtc, "ends at range end");
  for (let i = 1; i < t.buckets.length; i++) {
    eq(t.buckets[i].startUtc, t.buckets[i - 1].endUtc, `bucket ${i} abuts ${i - 1}`);
  }
});

check("coalesced spans are what the coverage bar draws", () => {
  const spans = coalesceForDisplay(buildTimeline("cam-1", [span(0, 1800), span(1800, 3600)], RANGE));
  eq(spans.length, 1, "two abutting spans render as one bar");
});

check("bad input is refused", () => {
  throws(() => buildReviewTimeline("cam-1", [], [], RANGE, 0), "zero buckets");
  throws(() => buildReviewTimeline("cam-1", [], [], RANGE, 99_999), "absurd bucket count");
  throws(() => buildReviewTimeline("cam-1", [], [{ ...det(10), cameraId: "cam-9" }], RANGE, 60),
         "a detection for the wrong camera");
});

report("timeline");
