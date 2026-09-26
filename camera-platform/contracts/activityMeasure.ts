/**
 * The activity page (ACTIVITY-PAGE-SPEC.md), Shape item 2: turning what the
 * I/O layer already read from the segment index (agent/segindex.mjs) and the
 * health-history store's new `detecting` sample (agent/health-history.mjs)
 * into the two per-bucket measurements contracts/activity.ts's
 * `buildActivityBucket` expects: `footageMin` and `watchedMin`.
 *
 * Pure, like every other module in this directory (build rules 1-4): no fs,
 * no node:sqlite, no clock of its own. agent/events-db.mjs and
 * agent/health-history.mjs read the raw rows; this file only turns rows
 * already read into a per-bucket number.
 *
 * THE FEARED FAILURES, named the way build rule 19 asks for:
 *  - an OPEN segment (still being written, `endUtc: null`) treated as having
 *    zero duration and silently dropped from the current hour's footageMin —
 *    the hour still being recorded would then look like a gap.
 *  - a segment counted twice because it overlaps two buckets, or counted for
 *    more than the bucket it overlaps (double-billing one segment across a
 *    hard hour boundary that does not actually exist in the data).
 *  - a `detecting` sample from BEFORE watching was ever measured folded into
 *    a bucket's watchedMin as if it were a real (even if low) minute count —
 *    build rule 5: that bucket must come back null, not a small number.
 *  - a missing per-minute sample (the server itself was down that minute)
 *    read as "watching" — only samples actually present are ever counted.
 */

import { parseUtc } from "./time.js";
import type { ActivityBucket, BucketEdge, BucketStatus } from "./activity.js";

// ---------------------------------------------------------------------------
// footageMin: minutes of each bucket with recorded video, from the index.
// Same overlap idea as contracts/timeline.ts's own per-bucket coverage sum —
// deliberately not the fuller gap/seam/nodata classification of
// contracts/indexCoverage.ts, which answers a different question (why is
// this hole here) that the activity page does not ask.
// ---------------------------------------------------------------------------

/** One segment as agent/segindex.mjs's rowToSegment returns it — only the
 *  two fields this file needs. `endUtc` is null exactly when the segment is
 *  still open (state "open"): it extends to `nowUtc`, never to zero duration. */
export interface FootageSegmentInput {
  startUtc: string;
  endUtc: string | null;
}

/**
 * Minutes of recorded video inside each bucket, one entry per `edges`, in
 * the same order. `segments` may be any camera's or several cameras'
 * combined (the caller decides the scope — one camera's own segments for a
 * per-camera bucket, or already-merged coverage for a site-wide one); this
 * function only sums overlap, and does not de-duplicate segments that
 * genuinely overlap each other in the input, since a real recorder never
 * produces two segments of the same camera covering the same instant.
 *
 * Each result is clamped to the bucket's own real length in minutes — never
 * more, however many segments overlap it — because a bucket cannot hold more
 * recorded video than it is long, and a small floating-point overshoot at a
 * boundary must not read as "60.0003 of 60 minutes".
 */
export function footageMinutesForBuckets(
  edges: readonly BucketEdge[],
  segments: readonly FootageSegmentInput[],
  nowUtc: string,
): number[] {
  const nowMs = parseUtc(nowUtc);
  const resolved = segments.map((s) => ({
    startMs: parseUtc(s.startUtc),
    // An open segment (still being written) extends to now, not to zero
    // duration — the current, in-progress hour must still show it recording.
    endMs: s.endUtc === null ? nowMs : parseUtc(s.endUtc),
  }));

  return edges.map((edge) => {
    const startMs = parseUtc(edge.startUtc);
    const endMs = parseUtc(edge.endUtc);
    const bucketMinutes = (endMs - startMs) / 60_000;
    let coveredMs = 0;
    for (const seg of resolved) {
      const overlap = Math.min(endMs, seg.endMs) - Math.max(startMs, seg.startMs);
      if (overlap > 0) coveredMs += overlap;
    }
    const minutes = coveredMs / 60_000;
    return Math.min(minutes, bucketMinutes);
  });
}

// ---------------------------------------------------------------------------
// watchedMin: minutes of each bucket the `detecting` sample was 1, from the
// health-history store — null for a bucket that ends at or before the first
// instant that sample ever existed at all (build rule 5: "watch time not
// measured" is never a guessed 0).
// ---------------------------------------------------------------------------

/** One `detecting` sample, 0 or 1, at a one-minute tick — the same shape
 *  agent/health-history.mjs's other per-minute samples (e.g. `recording`)
 *  already use. */
export interface DetectingSampleInput {
  atUtc: string;
  value: 0 | 1;
}

/**
 * Minutes of each bucket that were actually watched, one entry per `edges`,
 * in the same order — or null for a bucket this camera's `detecting` sample
 * did not exist for yet at all.
 *
 * `watchMeasuredFromUtc` is the earliest instant ANY `detecting` sample
 * exists for the camera(s) this call is about (the I/O layer reads it from
 * the store, e.g. `MIN(at_ms)`); null means the sample has never been
 * written here, so every bucket is unmeasured.
 *
 * A bucket that ends at or before `watchMeasuredFromUtc` is null outright —
 * it predates the sample entirely. A bucket that starts before but ends
 * after it is NOT specially handled: it is summed like any other bucket,
 * which naturally counts only the minutes that do have a sample (the ones
 * before `watchMeasuredFromUtc` have none to count) — an undercount for that
 * one straddling hour, never an overclaim, and the ordinary case once the
 * feature has been on for more than an hour.
 *
 * Only samples with `value === 1` are counted, and only samples actually
 * present: a minute the sampler never ran (the API service was itself down)
 * has no row at all and is not counted as watching, matching
 * contracts/healthHistory.ts's own "no samples" is not "off" distinction one
 * level up (this file does not need a third state, because an uncounted
 * minute here still lands inside a bucket that already carries a real
 * watchedMin number, never null, once sampling has started).
 */
export function watchedMinutesForBuckets(
  edges: readonly BucketEdge[],
  samples: readonly DetectingSampleInput[],
  watchMeasuredFromUtc: string | null,
): Array<number | null> {
  if (watchMeasuredFromUtc === null) {
    return edges.map(() => null);
  }
  const measuredFromMs = parseUtc(watchMeasuredFromUtc);
  const sampleMs = samples.map((s) => ({ atMs: parseUtc(s.atUtc), value: s.value }));

  return edges.map((edge) => {
    const endMs = parseUtc(edge.endUtc);
    if (endMs <= measuredFromMs) return null;
    const startMs = parseUtc(edge.startUtc);
    let minutes = 0;
    for (const s of sampleMs) {
      if (s.value === 1 && s.atMs >= startMs && s.atMs < endMs) minutes += 1;
    }
    return minutes;
  });
}

// ---------------------------------------------------------------------------
// Rolling a day's own hourly ActivityBuckets (contracts/activity.ts's
// buildActivityBuckets, called on one dayBucketsFor7d entry's `hours`) up
// into one day-level ActivityBucket for the 7d chart's daily bars
// (ACTIVITY-PAGE-SPEC.md: "7d: daily bars, the same way [as 24h]").
//
// buildActivityBucket itself is written for HOUR semantics (its
// "watchedMin < 60" test for partly_watched) and is not called again here at
// day granularity — a day bucket's status is decided from its own hours'
// statuses instead, by the same "first match wins, never a guessed 0" rule
// the hour version follows.
// ---------------------------------------------------------------------------

/** In precedence order: every hour sharing one status decides the day's own.
 *  Anything else -- any real mix -- is "partly_watched": the day had SOME
 *  hours the AI could see and some it could not (unwatched, no video, not
 *  yet measured, or before this NVR's oldest video), which is exactly what
 *  "partly watched" already means one level up. */
const UNANIMOUS_STATUSES: readonly BucketStatus[] = [
  "before_oldest_video",
  "watch_not_measured",
  "no_video",
  "not_watching",
  "counted",
];

/**
 * Roll one day's own hourly buckets (23, 24 or 25 of them, from
 * `dayBucketsFor7d`) up into a single day-shaped `ActivityBucket`.
 *
 * - `person`, `vehicle`, `hidden`: summed -- real measurements, always safe
 *   to add.
 * - `footageMin`: summed minutes across the day's hours (0..1500-ish on a
 *   25-hour fall-back day) -- never assumed to cap at 60, unlike an hour's
 *   own footageMin.
 * - `watchedMin`: summed across the hours that ARE a number, treating an
 *   hour whose own watchedMin is null as contributing 0 -- an undercount for
 *   a day that is part measured and part not, never an overclaim (the same
 *   policy `watchedMinutesForBuckets` already uses for one straddling
 *   bucket). null only when EVERY hour of the day is null, i.e. the day was
 *   never measured at all.
 * - `status`: the hours' shared status when every one of them agrees
 *   (`UNANIMOUS_STATUSES`); `"partly_watched"` for any real mix, matching
 *   what "partly watched" already means for one hour.
 * - `watchedReason`: present only when `watchedMin` is null, copied from
 *   whichever hour carried the (always identical, within one request)
 *   `watchedReason` text.
 *
 * `hours` must be non-empty -- `dayBucketsFor7d` never produces a day with
 * zero hours, so an empty array here is a caller bug, not client input.
 */
export function rollUpDayBucket(edge: BucketEdge, hours: readonly ActivityBucket[]): ActivityBucket {
  if (hours.length === 0) {
    throw new RangeError("rollUpDayBucket: a day must have at least one hour bucket");
  }

  let person = 0;
  let vehicle = 0;
  let hidden = 0;
  let footageMin = 0;
  let watchedMin = 0;
  let anyWatched = false;
  for (const hour of hours) {
    person += hour.person;
    vehicle += hour.vehicle;
    hidden += hour.hidden;
    footageMin += hour.footageMin;
    if (hour.watchedMin !== null) {
      watchedMin += hour.watchedMin;
      anyWatched = true;
    }
  }

  const firstStatus = hours[0]!.status;
  const unanimous = UNANIMOUS_STATUSES.includes(firstStatus) && hours.every((h) => h.status === firstStatus);
  const status: BucketStatus = unanimous ? firstStatus : "partly_watched";

  const base = {
    startUtc: edge.startUtc,
    endUtc: edge.endUtc,
    person,
    vehicle,
    hidden,
    footageMin,
  };

  if (!anyWatched) {
    const reason = hours.find((h) => h.watchedReason !== undefined)?.watchedReason;
    return {
      ...base,
      watchedMin: null,
      ...(reason !== undefined ? { watchedReason: reason } : {}),
      status,
    };
  }

  return { ...base, watchedMin, status };
}
