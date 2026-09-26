/** The activity page (ACTIVITY-PAGE-SPEC.md), Shape item 1: validating
 *  range/tz/camera, building DST-safe local-hour and local-day bucket
 *  edges, counting sightings by first_ms, merging footage/watch minutes
 *  into a status per bucket, and picking the busiest watched hour. The
 *  failures feared are the ones the spec names outright: a blank rendered
 *  as a 0, a sighting double-counted (or dropped) at an hour edge, a
 *  known-object folded into the counts instead of `hidden`, and a DST day
 *  treated as if it always had 24 hours. */
import {
  parseActivityQuery,
  hourBucketsFor24h,
  dayBucketsFor7d,
  countSightings,
  buildActivityBucket,
  buildActivityBuckets,
  busiestWatchedHour,
} from "../dist/activity.js";
import { check, same, eq, report } from "./_assert.mjs";

console.log("activity");

const NY = "America/New_York";

// ---------------------------------------------------------------------------
// parseActivityQuery: range, tz, camera
// ---------------------------------------------------------------------------

check("parseActivityQuery: a well-formed 24h/7d query with no camera filter parses", () => {
  const ok = parseActivityQuery({ range: "24h", tz: NY });
  same(ok, { ok: true, range: "24h", tz: NY, cameraId: null }, "parsed");
  const ok7 = parseActivityQuery({ range: "7d", tz: "UTC", camera: null });
  same(ok7, { ok: true, range: "7d", tz: "UTC", cameraId: null }, "7d, explicit null camera");
});

check("parseActivityQuery: a valid camera id is kept", () => {
  const result = parseActivityQuery({ range: "24h", tz: "UTC", camera: "front-door_1" });
  same(result, { ok: true, range: "24h", tz: "UTC", cameraId: "front-door_1" }, "camera kept");
});

check("REQUIRED: any range other than exactly '24h' or '7d' refuses, never silently defaults", () => {
  for (const bad of ["24H", "1d", "", null, undefined, "week"]) {
    const result = parseActivityQuery({ range: bad, tz: "UTC" });
    same(result.ok, false, `range ${JSON.stringify(bad)} should refuse`);
    same(result.status, 400, "status");
    same(result.code, "bad_range", "code");
  }
});

check("REQUIRED: tz must be a name Intl accepts -- a bad or missing zone refuses, not a silent default", () => {
  for (const bad of ["Not/AZone", "", null, undefined, 5]) {
    const result = parseActivityQuery({ range: "24h", tz: bad });
    same(result.ok, false, `tz ${JSON.stringify(bad)} should refuse`);
    same(result.status, 400, "status");
    same(result.code, "bad_tz", "code");
  }
});

check("parseActivityQuery: whatever Intl itself accepts as a timeZone is accepted here too -- the same test alertRules.ts's checkRule uses", () => {
  // Modern Intl also accepts fixed-offset identifiers like this one; the
  // validation here is "does Intl accept it", not a hand-rolled IANA regex,
  // so it must not reject something Intl itself is happy with.
  const result = parseActivityQuery({ range: "24h", tz: "+05:00" });
  same(result.ok, true, "accepted, matching Intl's own behaviour");
});

check("parseActivityQuery: tz is checked before camera, so a bad tz is reported even with a bad camera too", () => {
  const result = parseActivityQuery({ range: "24h", tz: "Not/AZone", camera: "not an id!" });
  same(result.code, "bad_tz", "tz wins over the also-bad camera");
});

check("REQUIRED: an invalid camera id refuses, not a silent pass-through to the query", () => {
  for (const bad of ["not an id!", "../etc/passwd", "a".repeat(65)]) {
    const result = parseActivityQuery({ range: "24h", tz: "UTC", camera: bad });
    same(result.ok, false, `camera ${JSON.stringify(bad)} should refuse`);
    same(result.status, 400, "status");
    same(result.code, "bad_camera_id", "code");
  }
});

// ---------------------------------------------------------------------------
// Local-hour and local-day bucket edges: DST safety
// ---------------------------------------------------------------------------

check("REQUIRED, THE FEARED ONE: America/New_York's spring-forward day (2026-03-08) has 23 hours", () => {
  // Noon on the 8th, well clear of the transition, so this day is
  // unambiguously "today" for dayBucketsFor7d's own local-date read.
  const days = dayBucketsFor7d(NY, "2026-03-08T16:00:00.000Z");
  const springDay = days[days.length - 1];
  same(springDay.hours.length, 23, "23 local hours that day");
  // Midnight local on 2026-03-08 is 05:00 UTC (EST, UTC-5); the next local
  // midnight is 04:00 UTC on the 9th (EDT, UTC-4) -- 23 real hours apart.
  same(springDay.startUtc, "2026-03-08T05:00:00.000Z", "local midnight in UTC");
  same(springDay.endUtc, "2026-03-09T04:00:00.000Z", "next local midnight in UTC");
});

check("REQUIRED, THE FEARED ONE: America/New_York's fall-back day (2026-11-01) has 25 hours", () => {
  const days = dayBucketsFor7d(NY, "2026-11-01T16:00:00.000Z");
  const fallDay = days[days.length - 1];
  same(fallDay.hours.length, 25, "25 local hours that day");
  // Midnight local on 2026-11-01 is 04:00 UTC (EDT, UTC-4, before the 2am
  // transition); the next local midnight is 05:00 UTC on the 2nd (EST,
  // UTC-5) -- 25 real hours apart.
  same(fallDay.startUtc, "2026-11-01T04:00:00.000Z", "local midnight in UTC");
  same(fallDay.endUtc, "2026-11-02T05:00:00.000Z", "next local midnight in UTC");
});

check("dayBucketsFor7d: an ordinary day has 24 hours, and the hour edges tile with no gap or overlap", () => {
  const days = dayBucketsFor7d(NY, "2026-06-15T16:00:00.000Z");
  const day = days[days.length - 1];
  same(day.hours.length, 24, "24 hours");
  for (let i = 0; i < day.hours.length - 1; i++) {
    same(day.hours[i].endUtc, day.hours[i + 1].startUtc, `hour ${i} end === hour ${i + 1} start`);
  }
  same(day.hours[0].startUtc, day.startUtc, "first hour starts the day");
  same(day.hours[day.hours.length - 1].endUtc, day.endUtc, "last hour ends the day");
});

check("dayBucketsFor7d: 7 consecutive local calendar days ending with today", () => {
  const days = dayBucketsFor7d(NY, "2026-06-15T16:00:00.000Z");
  same(days.length, 7, "7 days");
  for (let i = 0; i < days.length - 1; i++) {
    same(days[i].endUtc, days[i + 1].startUtc, `day ${i} end === day ${i + 1} start`);
  }
});

check("hourBucketsFor24h: exactly 24 buckets, each real hour long, ending with the current hour", () => {
  const buckets = hourBucketsFor24h(NY, "2026-06-15T17:23:00.000Z"); // 13:23 EDT
  same(buckets.length, 24, "24 buckets");
  for (let i = 0; i < buckets.length - 1; i++) {
    same(buckets[i].endUtc, buckets[i + 1].startUtc, `bucket ${i} end === bucket ${i + 1} start`);
  }
  const last = buckets[buckets.length - 1];
  same(last.startUtc, "2026-06-15T17:00:00.000Z", "last bucket starts the current local hour (13:00 EDT)");
  same(last.endUtc, "2026-06-15T18:00:00.000Z", "and runs to the top of the next hour");
});

check("REQUIRED, THE FEARED ONE: hourBucketsFor24h across the fall-back night still gives 24 real-hour buckets", () => {
  // 06:30 UTC on 2026-11-02 is 01:30 EST -- an hour after the fall-back
  // transition (06:00 UTC / 2:00am EDT -> 1:00am EST) finished.
  const buckets = hourBucketsFor24h(NY, "2026-11-02T06:30:00.000Z");
  same(buckets.length, 24, "still exactly 24 buckets, not 25 -- this is a rolling window, not a calendar day");
  for (let i = 0; i < buckets.length; i++) {
    const startMs = Date.parse(buckets[i].startUtc);
    const endMs = Date.parse(buckets[i].endUtc);
    same(endMs - startMs, 3_600_000, `bucket ${i} spans exactly one real hour`);
  }
  for (let i = 0; i < buckets.length - 1; i++) {
    same(buckets[i].endUtc, buckets[i + 1].startUtc, `bucket ${i} end === bucket ${i + 1} start`);
  }
  const last = buckets[buckets.length - 1];
  same(last.startUtc, "2026-11-02T06:00:00.000Z", "current hour started at the transition instant itself");
});

// ---------------------------------------------------------------------------
// Counting sightings per bucket by first_ms
// ---------------------------------------------------------------------------

const HOUR_EDGES = [
  { startUtc: "2026-09-24T00:00:00.000Z", endUtc: "2026-09-24T01:00:00.000Z" },
  { startUtc: "2026-09-24T01:00:00.000Z", endUtc: "2026-09-24T02:00:00.000Z" },
  { startUtc: "2026-09-24T02:00:00.000Z", endUtc: "2026-09-24T03:00:00.000Z" },
];
const HOUR_EDGE_MS = (i) => Date.parse(HOUR_EDGES[i].startUtc);

check("countSightings: a person and a vehicle each land in the bucket their first_ms falls in", () => {
  const events = [
    { cameraId: "cam1", kind: "person", firstMs: HOUR_EDGE_MS(0) + 60_000 },
    { cameraId: "cam1", kind: "vehicle", firstMs: HOUR_EDGE_MS(1) + 60_000 },
  ];
  const counts = countSightings(HOUR_EDGES, events);
  same(counts, [
    { person: 1, vehicle: 0, hidden: 0 },
    { person: 0, vehicle: 1, hidden: 0 },
    { person: 0, vehicle: 0, hidden: 0 },
  ], "one sighting each, in its own bucket");
});

check("REQUIRED, THE FEARED ONE: an event exactly on an hour edge lands in exactly one hour, never two, never zero", () => {
  const events = [{ cameraId: "cam1", kind: "person", firstMs: HOUR_EDGE_MS(1) }]; // exactly the boundary
  const counts = countSightings(HOUR_EDGES, events);
  same(counts[0].person, 0, "bucket 0 (which this instant CLOSES) does not get it");
  same(counts[1].person, 1, "bucket 1 (which this instant OPENS) gets it");
  const total = counts.reduce((sum, c) => sum + c.person, 0);
  same(total, 1, "counted exactly once across every bucket");
});

check("REQUIRED: a suppressed (known-object) event counts in hidden, never in person/vehicle", () => {
  const events = [
    { cameraId: "cam1", kind: "person", firstMs: HOUR_EDGE_MS(0) + 1000, suppressedBy: "known-1" },
    { cameraId: "cam1", kind: "vehicle", firstMs: HOUR_EDGE_MS(0) + 2000 }, // not suppressed
  ];
  const counts = countSightings(HOUR_EDGES, events);
  same(counts[0], { person: 0, vehicle: 1, hidden: 1 }, "the suppressed one is hidden, not a person; the other still counts");
});

check("REQUIRED: a plate read is not a sighting -- excluded entirely, not counted and not hidden", () => {
  const events = [
    { cameraId: "cam1", kind: "plate", firstMs: HOUR_EDGE_MS(0) + 1000 },
    { cameraId: "cam1", kind: "plate", firstMs: HOUR_EDGE_MS(0) + 2000, suppressedBy: "known-1" },
  ];
  const counts = countSightings(HOUR_EDGES, events);
  same(counts[0], { person: 0, vehicle: 0, hidden: 0 }, "plates never appear anywhere in the counts");
});

check("countSightings: an event outside every bucket is ignored, not thrown on", () => {
  const events = [{ cameraId: "cam1", kind: "person", firstMs: HOUR_EDGE_MS(0) - 3_600_000 }];
  const counts = countSightings(HOUR_EDGES, events);
  same(counts.every((c) => c.person === 0 && c.vehicle === 0 && c.hidden === 0), true, "not counted anywhere");
});

check("countSightings: a cameraId filter keeps only that camera's events", () => {
  const events = [
    { cameraId: "cam1", kind: "person", firstMs: HOUR_EDGE_MS(0) + 1000 },
    { cameraId: "cam2", kind: "person", firstMs: HOUR_EDGE_MS(0) + 2000 },
  ];
  const filtered = countSightings(HOUR_EDGES, events, "cam1");
  same(filtered[0].person, 1, "only cam1's sighting counted");
  const unfiltered = countSightings(HOUR_EDGES, events, null);
  same(unfiltered[0].person, 2, "no filter: both cameras counted together");
});

// ---------------------------------------------------------------------------
// Merging footage/watch minutes into a status, every status
// ---------------------------------------------------------------------------

const EDGE = { startUtc: "2026-09-24T10:00:00.000Z", endUtc: "2026-09-24T11:00:00.000Z" };
const NO_COUNTS = { person: 0, vehicle: 0, hidden: 0 };

check("REQUIRED: watched the full hour -> 'counted', never anything else when fully measured", () => {
  const bucket = buildActivityBucket(
    EDGE, { person: 3, vehicle: 1, hidden: 0 }, { footageMin: 60, watchedMin: 60 }, "UTC", null, null,
  );
  same(bucket.status, "counted", "status");
  same(bucket.person, 3, "counts passed through");
  same(typeof bucket.watchedReason, "undefined", "no reason text on a fully-measured bucket");
});

check("REQUIRED: watched less than the full hour -> 'partly_watched', not rounded up to counted", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: 42 }, "UTC", null, null,
  );
  same(bucket.status, "partly_watched", "status");
  same(bucket.watchedMin, 42, "the real measured minutes, not rounded");
});

check("REQUIRED, THE FEARED ONE: watchedMin 0 -> 'not_watching', a real measured blank, never dropped to look like a quiet hour", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: 0 }, "UTC", null, null,
  );
  same(bucket.status, "not_watching", "status");
  same(bucket.watchedMin, 0, "0 is a real measurement here, not a blank");
});

check("REQUIRED, THE FEARED ONE: footageMin 0 -> 'no_video', which takes priority over the watched minutes", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 0, watchedMin: 0 }, "UTC", null, null,
  );
  same(bucket.status, "no_video", "status, not 'not_watching'");
});

check("REQUIRED, THE FEARED ONE: watchedMin null -> 'watch_not_measured', with an HH:MM reason in the caller's tz, never a 0", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: null }, NY, null, "2026-09-20T13:07:00.000Z", // 09:07 EDT
  );
  same(bucket.status, "watch_not_measured", "status");
  same(bucket.watchedMin, null, "still null, not defaulted");
  same(bucket.watchedReason, "watch time not measured before 09:07", "HH:MM in the caller's own tz");
});

check("buildActivityBucket: watchedMin null with no watchMeasuredFromUtc still gives a reason, just without a time", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: null }, "UTC", null, null,
  );
  same(bucket.status, "watch_not_measured", "status");
  same(bucket.watchedReason, "watch time not measured", "generic reason, no fabricated time");
});

check("REQUIRED, THE FEARED ONE: an hour before countsFromUtc -> 'before_oldest_video', never 0 counts presented as real", () => {
  const bucket = buildActivityBucket(
    EDGE, { person: 0, vehicle: 0, hidden: 0 }, { footageMin: 60, watchedMin: 60 },
    "UTC", "2026-09-24T12:00:00.000Z", null, // the NVR's oldest video is an hour AFTER this bucket
  );
  same(bucket.status, "before_oldest_video", "status, even though footage/watch look fine");
});

check("buildActivityBucket: before_oldest_video outranks watch_not_measured when a bucket is before both cutoffs", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: null },
    "UTC", "2026-09-24T12:00:00.000Z", "2026-09-24T12:00:00.000Z",
  );
  same(bucket.status, "before_oldest_video", "the more fundamental blank wins");
});

check("buildActivityBucket: a bucket at or after countsFromUtc is not flagged, even right at the edge", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: 60 },
    "UTC", "2026-09-24T10:00:00.000Z", null, // countsFromUtc === this bucket's own startUtc
  );
  same(bucket.status, "counted", "the bucket starting exactly at countsFromUtc is not 'before' it");
});

check("buildActivityBucket: a bucket ending exactly at countsFromUtc IS entirely before it (half-open interval)", () => {
  const bucket = buildActivityBucket(
    EDGE, NO_COUNTS, { footageMin: 60, watchedMin: 60 },
    "UTC", "2026-09-24T11:00:00.000Z", null, // countsFromUtc === this bucket's own endUtc
  );
  same(bucket.status, "before_oldest_video", "the bucket's own end is the cutoff's instant, which it does not include");
});

check("buildActivityBuckets: builds every hour at once, in order, paired with the right footage/watch entry", () => {
  const events = [
    { cameraId: "cam1", kind: "person", firstMs: HOUR_EDGE_MS(0) + 1000 },
    { cameraId: "cam1", kind: "vehicle", firstMs: HOUR_EDGE_MS(2) + 1000 },
  ];
  const footageWatch = [
    { footageMin: 60, watchedMin: 60 },
    { footageMin: 60, watchedMin: 0 },
    { footageMin: 0, watchedMin: 0 },
  ];
  const buckets = buildActivityBuckets(HOUR_EDGES, events, footageWatch, "UTC", null, null, "cam1");
  same(buckets.map((b) => b.status), ["counted", "not_watching", "no_video"], "one status per hour, in order");
  same(buckets[0].person, 1, "hour 0's sighting");
  same(buckets[2].vehicle, 1, "hour 2's sighting, despite no_video status -- the measurement is still reported");
});

check("buildActivityBuckets: a footage/watch array of the wrong length is a programming error, and throws", () => {
  let threw = false;
  try {
    buildActivityBuckets(HOUR_EDGES, [], [{ footageMin: 60, watchedMin: 60 }], "UTC", null, null);
  } catch {
    threw = true;
  }
  eq(threw, true, "mismatched lengths throw rather than silently misalign");
});

// ---------------------------------------------------------------------------
// Busiest hour, among watched hours only
// ---------------------------------------------------------------------------

function bucketWith(startUtc, endUtc, person, vehicle, status, extra = {}) {
  return { startUtc, endUtc, person, vehicle, hidden: 0, footageMin: 60, watchedMin: 60, status, ...extra };
}

check("busiestWatchedHour: picks the watched hour with the most person+vehicle sightings", () => {
  const buckets = [
    bucketWith("2026-09-24T00:00:00.000Z", "2026-09-24T01:00:00.000Z", 1, 0, "counted"),
    bucketWith("2026-09-24T01:00:00.000Z", "2026-09-24T02:00:00.000Z", 3, 2, "counted"),
    bucketWith("2026-09-24T02:00:00.000Z", "2026-09-24T03:00:00.000Z", 4, 0, "partly_watched"),
  ];
  const busiest = busiestWatchedHour(buckets);
  same(busiest, { startUtc: "2026-09-24T01:00:00.000Z", endUtc: "2026-09-24T02:00:00.000Z", person: 3, vehicle: 2, total: 5 }, "the 5-sighting hour wins");
});

check("REQUIRED, THE FEARED ONE: a busier but UNWATCHED hour never wins -- it is excluded, not scored at 0", () => {
  const buckets = [
    bucketWith("2026-09-24T00:00:00.000Z", "2026-09-24T01:00:00.000Z", 1, 0, "counted"),
    // This hour has far more sightings, but the AI was not watching -- the
    // "count" it carries (if any leaked through from a stale index) must
    // never be trusted as a real measurement of activity.
    bucketWith("2026-09-24T01:00:00.000Z", "2026-09-24T02:00:00.000Z", 50, 50, "not_watching"),
  ];
  const busiest = busiestWatchedHour(buckets);
  same(busiest.startUtc, "2026-09-24T00:00:00.000Z", "the only watched hour wins, however small");
});

check("busiestWatchedHour: no_video, before_oldest_video and watch_not_measured hours are all excluded too", () => {
  const buckets = [
    bucketWith("2026-09-24T00:00:00.000Z", "2026-09-24T01:00:00.000Z", 9, 9, "no_video"),
    bucketWith("2026-09-24T01:00:00.000Z", "2026-09-24T02:00:00.000Z", 9, 9, "before_oldest_video"),
    bucketWith("2026-09-24T02:00:00.000Z", "2026-09-24T03:00:00.000Z", 9, 9, "watch_not_measured"),
    bucketWith("2026-09-24T03:00:00.000Z", "2026-09-24T04:00:00.000Z", 1, 0, "counted"),
  ];
  const busiest = busiestWatchedHour(buckets);
  same(busiest.total, 1, "only the genuinely watched hour is a candidate");
});

check("REQUIRED: no watched hour at all -> null, never a fabricated all-zero busiest hour", () => {
  const buckets = [
    bucketWith("2026-09-24T00:00:00.000Z", "2026-09-24T01:00:00.000Z", 0, 0, "not_watching"),
    bucketWith("2026-09-24T01:00:00.000Z", "2026-09-24T02:00:00.000Z", 0, 0, "no_video"),
  ];
  same(busiestWatchedHour(buckets), null, "nothing to report");
});

check("busiestWatchedHour: a tie goes to the earlier hour", () => {
  const buckets = [
    bucketWith("2026-09-24T00:00:00.000Z", "2026-09-24T01:00:00.000Z", 2, 0, "counted"),
    bucketWith("2026-09-24T01:00:00.000Z", "2026-09-24T02:00:00.000Z", 1, 1, "counted"),
  ];
  same(busiestWatchedHour(buckets).startUtc, "2026-09-24T00:00:00.000Z", "the earlier of the two equal totals");
});

report("activity");
