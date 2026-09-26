/** contracts/activityMeasure.ts: footageMin and watchedMin per bucket, from
 *  already-read index segments and health-history `detecting` samples
 *  (ACTIVITY-PAGE-SPEC.md, Shape item 2). The failures feared, by name
 *  (build rule 19): an open segment read as zero duration, a bucket
 *  double-billed past its own length, and a bucket before watching was ever
 *  measured landing on a guessed 0 instead of null. */
import { footageMinutesForBuckets, watchedMinutesForBuckets, rollUpDayBucket } from "../dist/activityMeasure.js";
import { check, eq, close, throws, report } from "./_assert.mjs";

console.log("activityMeasure");

const edges = [
  { startUtc: "2026-09-24T12:00:00.000Z", endUtc: "2026-09-24T13:00:00.000Z" },
  { startUtc: "2026-09-24T13:00:00.000Z", endUtc: "2026-09-24T14:00:00.000Z" },
];

// ---------------------------------------------------------------------------
// footageMinutesForBuckets
// ---------------------------------------------------------------------------

check("footageMinutesForBuckets: a segment fully inside one bucket counts only there", () => {
  const segments = [
    { startUtc: "2026-09-24T12:10:00.000Z", endUtc: "2026-09-24T12:40:00.000Z" }, // 30 min
  ];
  const minutes = footageMinutesForBuckets(edges, segments, "2026-09-24T14:00:00.000Z");
  close(minutes[0], 30, 0.001, "bucket 0");
  eq(minutes[1], 0, "bucket 1 untouched");
});

check("footageMinutesForBuckets: a segment straddling the hour boundary splits across both buckets, never double-billed", () => {
  const segments = [
    { startUtc: "2026-09-24T12:50:00.000Z", endUtc: "2026-09-24T13:10:00.000Z" }, // 10 min + 10 min
  ];
  const minutes = footageMinutesForBuckets(edges, segments, "2026-09-24T14:00:00.000Z");
  close(minutes[0], 10, 0.001, "10 min in bucket 0");
  close(minutes[1], 10, 0.001, "10 min in bucket 1");
  close(minutes[0] + minutes[1], 20, 0.001, "REQUIRED: the whole 20-minute segment, counted once total");
});

check("REQUIRED: an open segment (endUtc null) extends to nowUtc, not to zero duration", () => {
  const segments = [
    { startUtc: "2026-09-24T13:45:00.000Z", endUtc: null }, // still recording
  ];
  const minutes = footageMinutesForBuckets(edges, segments, "2026-09-24T13:52:00.000Z");
  eq(minutes[0], 0, "bucket 0 has none of it");
  close(minutes[1], 7, 0.001, "REQUIRED: 7 minutes so far, not 0 for a still-open segment");
});

check("REQUIRED: several overlapping segments in one bucket are clamped to the bucket's own length, never over 60", () => {
  const segments = [
    { startUtc: "2026-09-24T12:00:00.000Z", endUtc: "2026-09-24T12:59:00.000Z" },
    { startUtc: "2026-09-24T12:00:30.000Z", endUtc: "2026-09-24T13:00:00.000Z" }, // overlaps the first
  ];
  const minutes = footageMinutesForBuckets(edges, segments, "2026-09-24T14:00:00.000Z");
  eq(minutes[0] <= 60, true, "never more than the bucket's own 60 minutes");
});

check("footageMinutesForBuckets: no segments at all is footageMin 0 for every bucket, not null (this file only ever returns numbers)", () => {
  const minutes = footageMinutesForBuckets(edges, [], "2026-09-24T14:00:00.000Z");
  eq(minutes, [0, 0], "zero, genuinely -- 'no video' is footageMin 0, decided by buildActivityBucket, not by this file returning null");
});

// ---------------------------------------------------------------------------
// watchedMinutesForBuckets
// ---------------------------------------------------------------------------

check("REQUIRED: watchMeasuredFromUtc null means every bucket is null -- the sample has never existed", () => {
  const minutes = watchedMinutesForBuckets(edges, [{ atUtc: "2026-09-24T12:30:00.000Z", value: 1 }], null);
  eq(minutes, [null, null], "no sample ever written; nothing to report but 'not measured'");
});

check("REQUIRED: a bucket that ends at or before watchMeasuredFromUtc is null, never a guessed 0", () => {
  const minutes = watchedMinutesForBuckets(edges, [], "2026-09-24T13:30:00.000Z");
  eq(minutes[0], null, "bucket 0 (ends 13:00, before the sample existed at 13:30) is unmeasured");
  eq(minutes[1], 0, "bucket 1 (ends 14:00, after 13:30) IS measured -- and genuinely watched zero minutes, a real 0");
});

check("watchedMinutesForBuckets: only value:1 samples count, and only within the bucket's own half-open window", () => {
  const samples = [
    { atUtc: "2026-09-24T12:05:00.000Z", value: 1 },
    { atUtc: "2026-09-24T12:06:00.000Z", value: 0 }, // not watching that minute
    { atUtc: "2026-09-24T12:07:00.000Z", value: 1 },
    { atUtc: "2026-09-24T13:00:00.000Z", value: 1 }, // lands in bucket 1, the edge it OPENS
    { atUtc: "2026-09-24T11:59:59.999Z", value: 1 }, // just before bucket 0 -- excluded
  ];
  const minutes = watchedMinutesForBuckets(edges, samples, "2026-09-24T00:00:00.000Z");
  eq(minutes[0], 2, "two 1-samples land in bucket 0");
  eq(minutes[1], 1, "the boundary sample lands in the bucket it opens, not the one it closes");
});

check("REQUIRED: a straddling bucket sums only the samples actually present, an undercount never an overclaim", () => {
  // watchMeasuredFromUtc lands 20 minutes into bucket 1 -- samples before it
  // simply do not exist (they were never written), and the ones after do.
  const samples = [
    { atUtc: "2026-09-24T13:25:00.000Z", value: 1 },
    { atUtc: "2026-09-24T13:35:00.000Z", value: 1 },
  ];
  const minutes = watchedMinutesForBuckets(edges, samples, "2026-09-24T13:20:00.000Z");
  eq(minutes[0], null, "bucket 0 ends before 13:20 -- fully unmeasured");
  eq(minutes[1], 2, "bucket 1: only the two samples that actually exist, not 40 (the 20 pre-measurement minutes are not assumed watching)");
});

check("watchedMinutesForBuckets: a missing minute (sampler down) is simply not counted, never treated as watching", () => {
  // Only one sample all hour, for an hour that is fully measured -- the other
  // 59 minutes have no row at all (build rule 5's own words: a blank is not
  // a zero, but here it is not a fabricated 1 either -- it contributes nothing).
  const minutes = watchedMinutesForBuckets(edges, [{ atUtc: "2026-09-24T12:00:00.000Z", value: 1 }], "2026-09-24T00:00:00.000Z");
  eq(minutes[0], 1, "exactly the one real sample, not 60 and not padded");
});

// ---------------------------------------------------------------------------
// rollUpDayBucket
// ---------------------------------------------------------------------------

const dayEdge = { startUtc: "2026-09-24T00:00:00.000Z", endUtc: "2026-09-25T00:00:00.000Z" };

function hourBucket(overrides) {
  return {
    startUtc: "x", endUtc: "y", person: 0, vehicle: 0, hidden: 0, footageMin: 60, watchedMin: 60, status: "counted",
    ...overrides,
  };
}

check("rollUpDayBucket: sums person/vehicle/hidden/footageMin, and every hour agreeing 'counted' rolls up 'counted'", () => {
  const hours = [
    hourBucket({ person: 2, vehicle: 1, hidden: 0 }),
    hourBucket({ person: 3, vehicle: 0, hidden: 1 }),
  ];
  const day = rollUpDayBucket(dayEdge, hours);
  eq(day.person, 5, "person summed");
  eq(day.vehicle, 1, "vehicle summed");
  eq(day.hidden, 1, "hidden summed");
  eq(day.footageMin, 120, "footageMin summed across hours, not capped at 60");
  eq(day.watchedMin, 120, "watchedMin summed too");
  eq(day.status, "counted", "unanimous status rolls straight up");
});

check("REQUIRED: every hour null (never measured) rolls up to a null day, never a fabricated 0", () => {
  const hours = [
    hourBucket({ watchedMin: null, watchedReason: "watch time not measured before 00:00", status: "watch_not_measured" }),
    hourBucket({ watchedMin: null, watchedReason: "watch time not measured before 00:00", status: "watch_not_measured" }),
  ];
  const day = rollUpDayBucket(dayEdge, hours);
  eq(day.watchedMin, null, "REQUIRED: null, not 0");
  eq(day.watchedReason, "watch time not measured before 00:00", "the reason carries up too");
  eq(day.status, "watch_not_measured", "unanimous status");
});

check("REQUIRED: a mix of statuses rolls up to partly_watched, never one of the unanimous statuses picked arbitrarily", () => {
  const hours = [
    hourBucket({ status: "counted", watchedMin: 60 }),
    hourBucket({ status: "not_watching", watchedMin: 0 }),
  ];
  const day = rollUpDayBucket(dayEdge, hours);
  eq(day.status, "partly_watched", "a real mix is partly_watched");
  eq(day.watchedMin, 60, "the measured hour's minutes still count -- 0 from the not-watching hour, 60 from the counted one");
});

check("REQUIRED: a mix of null and measured hours undercounts, never overclaims -- the null hour contributes 0, not assumed watched", () => {
  const hours = [
    hourBucket({ status: "watch_not_measured", watchedMin: null, watchedReason: "watch time not measured before 05:00" }),
    hourBucket({ status: "counted", watchedMin: 60 }),
  ];
  const day = rollUpDayBucket(dayEdge, hours);
  eq(day.watchedMin, 60, "only the measured hour's minutes, the null hour adds nothing");
  eq(day.status, "partly_watched", "a mix, so partly_watched -- never watch_not_measured (that would hide the real 60 minutes) nor counted (that would hide the gap)");
});

check("REQUIRED: rollUpDayBucket throws on an empty hours array -- a caller bug, not client input", () => {
  throws(() => rollUpDayBucket(dayEdge, []), "empty hours");
});

report("activityMeasure");
