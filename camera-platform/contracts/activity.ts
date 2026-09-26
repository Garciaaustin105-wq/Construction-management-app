/**
 * The activity page: sightings per camera by local hour and day
 * (ACTIVITY-PAGE-SPEC.md, Shape item 1). Pure: no fs, no node:sqlite, no
 * clock of its own -- every "now" and every already-read measurement is
 * handed in. That is what lets this module's harness run standalone and on
 * a Windows dev box, the same discipline healthHistory.ts and alertRules.ts
 * already follow.
 *
 * THE FEARED FAILURES, each one named in ACTIVITY-PAGE-SPEC.md and
 * AGENTS.md's build rules:
 * - A blank read as a zero. "Not watching" (watchedMin 0, a real
 *   measurement), "watch time not measured" (watchedMin null, no sample
 *   existed yet) and "before this NVR's oldest video" (no counts possible
 *   at all) are three different blanks. A bucket's `status` names which one
 *   applies; none of them is ever produced by defaulting a missing number
 *   to 0.
 * - A sighting on an hour boundary counted twice, or not at all. Every
 *   bucket here is a half-open interval [start, end) and every event lands
 *   in exactly one.
 * - Daylight saving treated as if every day had 24 hours. A local calendar
 *   day has 23 hours on the day clocks spring forward and 25 on the day
 *   they fall back, and this module's hour edges are built from Intl's own
 *   reading of the zone, never from a fixed 24 * 3_600_000.
 * - A known-object (suppressed) event counted as a sighting, or a plate
 *   read counted as one at all. Both are excluded from person/vehicle
 *   counts; a suppressed event moves to `hidden` instead of disappearing.
 *
 * WHY WALKING REAL HOURS WORKS FOR DST: a local wall-clock "top of the
 * hour" instant is always exactly one real hour (3_600_000 ms) after the
 * previous one -- even across a transition. On the spring-forward day the
 * 02:00 label never occurs (clocks jump 01:59:59 -> 03:00:00 at a single
 * real instant), so there is simply no top-of-hour instant to visit for it;
 * walking in fixed 3_600_000 ms steps skips it automatically. On the
 * fall-back day 01:00 occurs twice, and the two occurrences are exactly one
 * real hour apart, so the same fixed step visits both. This means the
 * bucket edges for a rolling window can be built by simple real-time
 * addition/subtraction from ONE correctly-resolved instant, without ever
 * having to invert an ambiguous or nonexistent wall-clock label.
 */

import { parseUtc, toUtc } from "./time.js";
import { localParts } from "./alertRules.js";
import { isCameraId } from "./apiQuery.js";
import { type EventKind } from "./detection.js";

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Validating range, tz and camera id.
// ---------------------------------------------------------------------------

export type ActivityRange = "24h" | "7d";

export interface ActivityQuery {
  range?: string | null;
  tz?: string | null;
  camera?: string | null;
}

export type ActivityRefusalCode = "bad_range" | "bad_tz" | "bad_camera_id";

export interface ActivityRefusal {
  ok: false;
  /** Every one of these is a malformed request, never a well-formed one we
   *  simply cannot answer -- so always 400, unlike apiQuery.ts's mix of
   *  400 and 422. */
  status: 400;
  code: ActivityRefusalCode;
  message: string;
}

export interface ParsedActivityQuery {
  ok: true;
  range: ActivityRange;
  tz: string;
  /** null: no camera filter, every camera. */
  cameraId: string | null;
}

/**
 * Validate a client's range, tz and (optional) camera id. First failure
 * wins, in this order: range, tz, camera.
 *
 * `tz` must be a string `new Intl.DateTimeFormat` accepts as `timeZone`
 * without throwing -- the same test alertRules.ts's checkRule uses for a
 * schedule's zone, so an offset-only string ("+05:00") or a bad name both
 * refuse the same way there and here.
 */
export function parseActivityQuery(query: ActivityQuery): ParsedActivityQuery | ActivityRefusal {
  const range = query.range;
  if (range !== "24h" && range !== "7d") {
    return refuse("bad_range", `range must be "24h" or "7d", got ${JSON.stringify(range ?? null)}`);
  }

  const tz = query.tz;
  if (typeof tz !== "string" || tz === "") {
    return refuse("bad_tz", "tz is required and must be an IANA time zone name");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return refuse("bad_tz", `tz is not a time zone Intl recognises: ${JSON.stringify(tz)}`);
  }

  const camera = query.camera;
  let cameraId: string | null = null;
  if (camera !== undefined && camera !== null && camera !== "") {
    if (!isCameraId(camera)) {
      return refuse("bad_camera_id", `camera is not a valid camera id: ${JSON.stringify(camera)}`);
    }
    cameraId = camera;
  }

  return { ok: true, range, tz, cameraId };
}

function refuse(code: ActivityRefusalCode, message: string): ActivityRefusal {
  return { ok: false, status: 400, code, message };
}

// ---------------------------------------------------------------------------
// Local-hour and local-day bucket edges, DST-safe.
// ---------------------------------------------------------------------------

export interface BucketEdge {
  startUtc: string;
  endUtc: string;
}

export interface DayBuckets {
  startUtc: string;
  endUtc: string;
  /** This day's own local-hour buckets: 23, 24 or 25 of them. */
  hours: BucketEdge[];
}

/**
 * The UTC offset in effect AT THIS EXACT INSTANT, in minutes east of UTC.
 * Unlike a wall-clock label, a real instant is never ambiguous, so this
 * always has exactly one answer.
 */
function offsetMinutesAt(tz: string, utcMs: number): number {
  const { date, minute } = localParts(tz, utcMs);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  // Read the same wall-clock numbers as if they were UTC, and see how far
  // that lands from the real instant they were read at.
  const asIfUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + minute * 60_000;
  return (asIfUtc - utcMs) / 60_000;
}

/**
 * The UTC instant of local midnight (00:00) on the given calendar day.
 * `day` may be 0 or negative or beyond the month's length -- Date.UTC
 * normalises it, which is how the day-before/day-after math below works
 * across a month or year boundary for free.
 *
 * Fixed-point iteration, not a single guess: the offset at the FIRST guess
 * (treating the wall clock as if it were UTC) may not be the real offset in
 * force at midnight, so the guess is corrected against the offset actually
 * read there, and rechecked. Two iterations converge for every zone that
 * does not move its clocks at exactly midnight -- true of every zone this
 * module is tested against (America/New_York moves at 02:00).
 */
function localMidnightUtcMs(tz: string, year: number, month: number, day: number): number {
  const desiredAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = desiredAsUtc;
  for (let i = 0; i < 4; i++) {
    const offsetMin = offsetMinutesAt(tz, guess);
    const next = desiredAsUtc - offsetMin * 60_000;
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

/** This calendar day's local-hour edges, length hours+1. 23, 24 or 25 hours. */
function localDayHourEdgesMs(tz: string, year: number, month: number, day: number): number[] {
  const startMs = localMidnightUtcMs(tz, year, month, day);
  const endMs = localMidnightUtcMs(tz, year, month, day + 1);
  const hours = Math.round((endMs - startMs) / HOUR_MS);
  const edges: number[] = [];
  for (let i = 0; i <= hours; i++) edges.push(startMs + i * HOUR_MS);
  return edges;
}

/**
 * The start of the local hour containing `nowMs` -- the top of the current,
 * still-running hour. Computed from the offset in force AT `nowMs` itself
 * (never ambiguous, since `nowMs` is one specific real instant), by shifting
 * into "local-looking" UTC numbers, flooring to the hour, and shifting back.
 */
function currentLocalHourStartMs(tz: string, nowMs: number): number {
  const offsetMin = offsetMinutesAt(tz, nowMs);
  const shifted = nowMs + offsetMin * 60_000;
  const flooredShifted = Math.floor(shifted / HOUR_MS) * HOUR_MS;
  return flooredShifted - offsetMin * 60_000;
}

/**
 * 24 rolling local-hour buckets ending with the current, in-progress local
 * hour that `nowUtc` falls in. Built by stepping in exact real hours from
 * that one resolved instant (see the file header for why that is DST-safe),
 * so this never needs to invert a wall-clock label at all.
 */
export function hourBucketsFor24h(tz: string, nowUtc: string): BucketEdge[] {
  const nowMs = parseUtc(nowUtc);
  const currentStart = currentLocalHourStartMs(tz, nowMs);
  const buckets: BucketEdge[] = [];
  for (let k = 23; k >= 0; k--) {
    const startMs = currentStart - k * HOUR_MS;
    buckets.push({ startUtc: toUtc(startMs), endUtc: toUtc(startMs + HOUR_MS) });
  }
  return buckets;
}

/**
 * 7 local-calendar-day buckets ending with today (the day `nowUtc` falls
 * in, local), each carrying its own local-hour buckets -- 23 of them on a
 * spring-forward day, 25 on a fall-back day, 24 otherwise.
 */
export function dayBucketsFor7d(tz: string, nowUtc: string): DayBuckets[] {
  const nowMs = parseUtc(nowUtc);
  const { date } = localParts(tz, nowMs);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];

  const days: DayBuckets[] = [];
  for (let k = 6; k >= 0; k--) {
    const edges = localDayHourEdgesMs(tz, year, month, day - k);
    const hours: BucketEdge[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      hours.push({ startUtc: toUtc(edges[i] as number), endUtc: toUtc(edges[i + 1] as number) });
    }
    days.push({
      startUtc: toUtc(edges[0] as number),
      endUtc: toUtc(edges[edges.length - 1] as number),
      hours,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// Counting sightings per bucket by first_ms.
// ---------------------------------------------------------------------------

/**
 * What countSightings needs of one stored event. `firstMs` is the same
 * `first_ms` events.db indexes on (idx_events_camera_first) -- an epoch
 * millisecond, not an ISO string, so no bucket lookup here has to reparse
 * one per event.
 */
export interface ActivityEventInput {
  cameraId: string;
  kind: EventKind;
  firstMs: number;
  /** The known-object id it was hidden under, or null/absent when it counts. */
  suppressedBy?: string | null;
}

export interface BucketCounts {
  person: number;
  vehicle: number;
  /** Known-object events that landed in this bucket: not in person/vehicle,
   *  never silently dropped either. */
  hidden: number;
}

/**
 * Count person and vehicle sightings into `buckets` by `firstMs`, one
 * bucket each (half-open [start, end), so a sighting exactly on an edge
 * lands in the bucket it OPENS, never the one it closes, and never both).
 *
 * - `kind: "plate"` is not a sighting at all and is skipped entirely --
 *   not counted, not hidden.
 * - An event with a non-empty `suppressedBy` (a known object) increments
 *   `hidden` in its bucket instead of `person`/`vehicle`.
 * - `cameraId`, when given, keeps only that camera's events; omit it (or
 *   pass null) to count everything already handed in, e.g. one camera's
 *   events pre-filtered by the caller, or several cameras' combined for a
 *   site-wide total.
 * - An event whose `firstMs` falls in no bucket at all (outside the whole
 *   window) is ignored, not thrown on: `buckets` may be a narrower window
 *   than the caller's full result set.
 */
export function countSightings(
  buckets: readonly BucketEdge[],
  events: readonly ActivityEventInput[],
  cameraId?: string | null,
): BucketCounts[] {
  const edgesMs = buckets.map((b) => ({ startMs: parseUtc(b.startUtc), endMs: parseUtc(b.endUtc) }));
  const counts: BucketCounts[] = buckets.map(() => ({ person: 0, vehicle: 0, hidden: 0 }));

  for (const event of events) {
    if (event.kind === "plate") continue;
    if (cameraId !== undefined && cameraId !== null && event.cameraId !== cameraId) continue;

    const index = edgesMs.findIndex((e) => event.firstMs >= e.startMs && event.firstMs < e.endMs);
    if (index === -1) continue;

    const bucket = counts[index] as BucketCounts;
    const hidden = typeof event.suppressedBy === "string" && event.suppressedBy !== "";
    if (hidden) {
      bucket.hidden += 1;
    } else if (event.kind === "person") {
      bucket.person += 1;
    } else if (event.kind === "vehicle") {
      bucket.vehicle += 1;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Merging footageMin/watchedMin and giving each bucket a status.
// ---------------------------------------------------------------------------

export type BucketStatus =
  | "counted"
  | "partly_watched"
  | "not_watching"
  | "no_video"
  | "before_oldest_video"
  | "watch_not_measured";

export interface FootageWatchInput {
  /** Minutes of this hour with recorded video, from the index. 0..60. */
  footageMin: number;
  /** Minutes the AI was watching, 0..60, or null when unmeasured (before
   *  the `detecting` sample existed for this camera). Never a guessed 0. */
  watchedMin: number | null;
}

export interface ActivityBucket {
  startUtc: string;
  endUtc: string;
  person: number;
  vehicle: number;
  hidden: number;
  footageMin: number;
  watchedMin: number | null;
  /** Present only when watchedMin is null: why, in words a person reads. */
  watchedReason?: string;
  status: BucketStatus;
}

/** "HH:MM" of a UTC instant in `tz`'s local time, for a reason string. */
function formatLocalHhMm(tz: string, utcMs: number): string {
  const { minute } = localParts(tz, utcMs);
  const hh = Math.floor(minute / 60);
  const mm = minute % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Merge one bucket's counts with its footage/watch measurements and decide
 * its status. First match wins, in this order -- each one a measurement or
 * a named reason, never a bare 0 standing in for a blank (build rule 5):
 *
 * 1. `countsFromUtc` is given and this bucket ends at or before it: there
 *    is no video old enough to have produced counts here at all ->
 *    "before_oldest_video". The counts passed in are still reported (they
 *    are usually 0-0-0 for a bucket this old, but this function does not
 *    assume that -- it reports what it was given).
 * 2. `footageWatch.watchedMin` is null: the `detecting` sample did not
 *    exist yet -> "watch_not_measured", with `watchedReason` naming the
 *    HH:MM (in `tz`) watching started being measured, from
 *    `watchMeasuredFromUtc` when given.
 * 3. `footageWatch.footageMin` is 0: no recorded video at all -> "no_video".
 * 4. `footageWatch.watchedMin` is 0: video exists but the AI was not
 *    watching -> "not_watching".
 * 5. `footageWatch.watchedMin` is under 60: watched for part of the hour ->
 *    "partly_watched".
 * 6. Otherwise, watched the full hour -> "counted".
 */
export function buildActivityBucket(
  edge: BucketEdge,
  counts: BucketCounts,
  footageWatch: FootageWatchInput,
  tz: string,
  countsFromUtc: string | null,
  watchMeasuredFromUtc: string | null,
): ActivityBucket {
  const base = {
    startUtc: edge.startUtc,
    endUtc: edge.endUtc,
    person: counts.person,
    vehicle: counts.vehicle,
    hidden: counts.hidden,
    footageMin: footageWatch.footageMin,
    watchedMin: footageWatch.watchedMin,
  };

  if (countsFromUtc !== null && parseUtc(edge.endUtc) <= parseUtc(countsFromUtc)) {
    return { ...base, status: "before_oldest_video" };
  }

  if (footageWatch.watchedMin === null) {
    const reason = watchMeasuredFromUtc === null
      ? "watch time not measured"
      : `watch time not measured before ${formatLocalHhMm(tz, parseUtc(watchMeasuredFromUtc))}`;
    return { ...base, watchedMin: null, watchedReason: reason, status: "watch_not_measured" };
  }

  if (footageWatch.footageMin === 0) {
    return { ...base, status: "no_video" };
  }
  if (footageWatch.watchedMin === 0) {
    return { ...base, status: "not_watching" };
  }
  if (footageWatch.watchedMin < 60) {
    return { ...base, status: "partly_watched" };
  }
  return { ...base, status: "counted" };
}

/**
 * Build every hour bucket in `edges` at once: counts events into them
 * (countSightings) and merges each with its footage/watch measurement
 * (buildActivityBucket), in the same order as `edges` and `footageWatch`.
 *
 * `footageWatch` must have exactly one entry per edge, in the same order --
 * a caller mismatch here is a programming error, not client input, so it
 * throws rather than silently pairing the wrong hour with the wrong
 * measurement.
 */
export function buildActivityBuckets(
  edges: readonly BucketEdge[],
  events: readonly ActivityEventInput[],
  footageWatch: readonly FootageWatchInput[],
  tz: string,
  countsFromUtc: string | null,
  watchMeasuredFromUtc: string | null,
  cameraId?: string | null,
): ActivityBucket[] {
  if (footageWatch.length !== edges.length) {
    throw new RangeError(
      `buildActivityBuckets: ${edges.length} edges but ${footageWatch.length} footage/watch entries`,
    );
  }
  const counts = countSightings(edges, events, cameraId);
  return edges.map((edge, i) =>
    buildActivityBucket(
      edge,
      counts[i] as BucketCounts,
      footageWatch[i] as FootageWatchInput,
      tz,
      countsFromUtc,
      watchMeasuredFromUtc,
    ));
}

// ---------------------------------------------------------------------------
// The busiest hour, among watched hours only.
// ---------------------------------------------------------------------------

export interface BusiestHour {
  startUtc: string;
  endUtc: string;
  person: number;
  vehicle: number;
  total: number;
}

/**
 * The bucket with the most person+vehicle sightings, considering ONLY
 * buckets that were actually watched at all -- status "counted" or
 * "partly_watched". A bucket that was not watching, had no video, predates
 * the oldest kept video, or predates watch measurement is excluded from
 * consideration entirely: it is unranked, not ranked at 0 (build rule 5 --
 * an hour we could not see is not the same as a quiet one, and must never
 * win "busiest" by default, nor be penalised into looking emptier than an
 * hour that was genuinely watched and genuinely quiet).
 *
 * Ties go to the earlier hour, matching this codebase's other tie-breaks
 * (timeline.ts's pointsOfInterest, eventQuery.ts's open-event order).
 * Returns null when no bucket was watched at all -- never a fabricated
 * all-zero "busiest" hour.
 */
export function busiestWatchedHour(buckets: readonly ActivityBucket[]): BusiestHour | null {
  let best: ActivityBucket | null = null;
  let bestTotal = -1;
  for (const bucket of buckets) {
    if (bucket.status !== "counted" && bucket.status !== "partly_watched") continue;
    const total = bucket.person + bucket.vehicle;
    if (best === null || total > bestTotal) {
      best = bucket;
      bestTotal = total;
    }
  }
  if (best === null) return null;
  return { startUtc: best.startUtc, endUtc: best.endUtc, person: best.person, vehicle: best.vehicle, total: bestTotal };
}
