// agent/activity-run.mjs
//
// I/O for GET /activity (ACTIVITY-PAGE-SPEC.md, Shape item 2): reads events
// from agent/events-db.mjs, footage from the segment index
// (agent/segindex.mjs), and watched minutes from the health-history store's
// new `detecting` sample (agent/health-history.mjs), then hands already-read
// rows to the pure contracts (dist/activity.js, dist/activityMeasure.js) to
// build the response. This file owns none of that arithmetic itself (build
// rules 1-2): it only fetches, combines across cameras, and assembles.
//
// THE FEARED FAILURES, by name:
//  - a bucket's status decided here by re-guessing, instead of by handing
//    real counts and a real footage/watch pair to buildActivityBucket, which
//    already carries every "blank is not a zero" rule (build rule 5) --
//    every status in this file's output comes from calling that function
//    (or rollUpDayBucket, for the 7d roll-up), never from an inline if/else.
//  - a combined ("all cameras") bucket claiming a watched-minutes figure
//    that one of the cameras it combines never actually measured, or
//    claiming more footage than a single camera in the set actually held --
//    see combineHourBuckets' own doc comment for the min/max policy this
//    guards.
//  - reading footage or events for a wider window than the buckets actually
//    need, which would let a segment or event just outside the requested
//    range leak into the edge bucket.

import {
  parseActivityQuery,
  hourBucketsFor24h,
  dayBucketsFor7d,
  buildActivityBucket,
  buildActivityBuckets,
  busiestWatchedHour,
} from '../dist/activity.js';
import { footageMinutesForBuckets, rollUpDayBucket } from '../dist/activityMeasure.js';

/**
 * Combine several cameras' own hourly `ActivityBucket[]` (same length and
 * edges, one array per camera) into one hourly series for the whole set --
 * the "all cameras" totals the headline tiles and the busiest-hour pick are
 * built from.
 *
 * - `person` / `vehicle` / `hidden`: summed. Real counts from disjoint
 *   cameras are always safe to add.
 * - `footageMin`: the MAX across cameras for that bucket -- "was there video
 *   to look at this hour" is true site-wide the moment ANY camera held it;
 *   summing incomparable per-camera minutes (which could exceed 60 for two
 *   cameras) would answer a question nobody asked.
 * - `watchedMin`: the MIN across cameras that have a number, and null the
 *   moment ANY camera's own watchedMin is null for that bucket. The combined
 *   count above is only as trustworthy as its LEAST-watched camera -- one
 *   camera going unwatched (or never having its `detecting` sample at all)
 *   means the combined person/vehicle total for that hour cannot be claimed
 *   as complete, so the combined bucket must say so rather than average the
 *   shortfall away (the same "never average, show what disagrees" instinct
 *   as build rule 18, applied to measurement completeness instead of two
 *   readings).
 *
 * With exactly one camera in `perCameraBuckets`, every one of these reduces
 * to that camera's own numbers -- a single-camera request and its own
 * per-camera entry never disagree.
 */
export function combineHourBuckets(edges, perCameraBuckets, tz, countsFromUtc, watchMeasuredFromUtc) {
  const cams = [...perCameraBuckets.values()];
  return edges.map((edge, i) => {
    let person = 0;
    let vehicle = 0;
    let hidden = 0;
    let footageMin = 0;
    let watchedMin = null;
    let sawAnyCamera = false;
    let anyUnmeasured = false;
    for (const camBuckets of cams) {
      const b = camBuckets[i];
      sawAnyCamera = true;
      person += b.person;
      vehicle += b.vehicle;
      hidden += b.hidden;
      if (b.footageMin > footageMin) footageMin = b.footageMin;
      if (b.watchedMin === null) {
        anyUnmeasured = true;
      } else if (watchedMin === null || b.watchedMin < watchedMin) {
        watchedMin = b.watchedMin;
      }
    }
    const combinedWatchedMin = !sawAnyCamera || anyUnmeasured ? null : watchedMin;
    return buildActivityBucket(
      edge,
      { person, vehicle, hidden },
      { footageMin, watchedMin: combinedWatchedMin },
      tz,
      countsFromUtc,
      watchMeasuredFromUtc,
    );
  });
}

function sumTotals(buckets) {
  return buckets.reduce((acc, b) => ({ person: acc.person + b.person, vehicle: acc.vehicle + b.vehicle }), { person: 0, vehicle: 0 });
}

/**
 * GET /activity's whole body (ACTIVITY-PAGE-SPEC.md). `ctx` is
 * `{ config, index, eventsDb, healthHistory, now }`:
 *  - `eventsDb`: the handle from `openEventsDb`, or `null` when events.db
 *    does not exist yet on this box (the same "not installed" case /events
 *    already answers `available: false` for).
 *  - `healthHistory`: the handle `startHealthHistory` returns, or `null`
 *    when that feature is off -- every bucket's `watchedMin` is then null,
 *    genuinely: the `detecting` sample cannot exist if nothing ever samples it.
 *  - `now`: `() => Date`, read exactly once here.
 *
 * `query` is `{ range, tz, camera }` as `URLSearchParams.get` returns them
 * (each a string or null). Returns either an `ActivityRefusal`
 * (`{ ok: false, status: 400, code, message }`, from `parseActivityQuery`)
 * or an envelope shaped:
 * ```
 * {
 *   ok: true, available: boolean, range, tz, camera: string | null,
 *   buckets: ActivityBucket[],       // the combined ("all cameras", or the
 *                                    // one requested) series -- 24 hourly
 *                                    // buckets for range=24h, 7 daily ones
 *                                    // (each rolled up from its own hours)
 *                                    // for range=7d.
 *   perCamera: Array<{ cameraId, buckets: ActivityBucket[], totals: { person, vehicle } }>,
 *                                    // one entry per camera in scope -- one
 *                                    // entry, identical to `buckets`, when
 *                                    // `camera` was given; one per
 *                                    // configured camera otherwise. What the
 *                                    // stacked-by-camera / small-multiples
 *                                    // charts and the per-camera totals come
 *                                    // from (ACTIVITY-PAGE-SPEC.md's UI
 *                                    // section).
 *   totals: { person, vehicle },     // summed over `buckets`.
 *   countsFromUtc: string | null,
 *   watchMeasuredFromUtc: string | null,
 *   busiestHour: BusiestHour | null, // always from the flat HOURLY series,
 *                                    // even for range=7d -- "the busiest
 *                                    // hour" names an hour, not a day.
 * }
 * ```
 * `available: false` (no events.db at all) answers every field with its own
 * honest empty shape -- `[]`, `null` -- never a fabricated bucket set.
 */
export function buildActivityResponse(ctx, query) {
  const { config, index, eventsDb, healthHistory, now } = ctx;
  const parsed = parseActivityQuery(query);
  if (parsed.ok !== true) return parsed;

  const { range, tz, cameraId } = parsed;
  const nowUtc = now().toISOString();
  const allCameraIds = config.cameras.map((c) => c.cameraId);
  const cameraIds = cameraId !== null ? [cameraId] : allCameraIds;

  if (eventsDb === null) {
    return {
      ok: true,
      available: false,
      range,
      tz,
      camera: cameraId,
      buckets: [],
      perCamera: cameraIds.map((id) => ({ cameraId: id, buckets: [], totals: { person: 0, vehicle: 0 } })),
      totals: { person: 0, vehicle: 0 },
      countsFromUtc: null,
      watchMeasuredFromUtc: null,
      busiestHour: null,
    };
  }

  // The flat local-hour edges the whole request is built from: 24 of them
  // for range=24h, or every hour of every one of the 7 days for range=7d
  // (23/24/25 each, DST-safe -- contracts/activity.ts's own dayBucketsFor7d).
  // `dayEdges` (7d only) remembers each day's own span and how many of
  // `edges` belong to it, so the flat hourly series can be sliced back into
  // days after buildActivityBuckets/combineHourBuckets run on it once.
  let edges;
  let dayEdges = null;
  if (range === '24h') {
    edges = hourBucketsFor24h(tz, nowUtc);
  } else {
    const days = dayBucketsFor7d(tz, nowUtc);
    edges = days.flatMap((d) => d.hours);
    dayEdges = days.map((d) => ({ startUtc: d.startUtc, endUtc: d.endUtc, hourCount: d.hours.length }));
  }

  const windowStartUtc = edges[0].startUtc;
  const windowEndUtc = edges[edges.length - 1].endUtc;

  // Read exactly the window the buckets cover -- no wider -- so a segment or
  // event just outside it can never leak into an edge bucket.
  const events = eventsDb.eventsInWindow(cameraIds, windowStartUtc, windowEndUtc);
  // Counts are complete back to each camera's OLDEST VIDEO, not its oldest
  // sighting: events are kept exactly as long as their footage
  // (EVENTS-RETENTION-SPEC.md), so nothing seen since the footage starts has
  // been deleted. Keying on the oldest sighting instead (found 2026-09-26)
  // called a recorded, watched, quiet night "before this NVR's oldest video"
  // when it was a real zero. Per camera: cameras sit on different drives with
  // different retention. The response's own countsFromUtc is the earliest of
  // them - "as far as this NVR keeps video".
  const countsFromByCamera = new Map(cameraIds.map((id) => [id, index.earliestFor(id)]));
  const footageStarts = [...countsFromByCamera.values()].filter((iso) => iso !== null).sort();
  const countsFromUtc = footageStarts.length > 0 ? footageStarts[0] : null;

  const watch = healthHistory === null
    ? { watchMeasuredFromUtc: null, perCamera: new Map(cameraIds.map((id) => [id, edges.map(() => null)])) }
    : healthHistory.watchedMinutesFor(cameraIds, edges);
  const { watchMeasuredFromUtc } = watch;

  const perCameraHourBuckets = new Map();
  for (const camId of cameraIds) {
    const segments = index
      .inRange(camId, windowStartUtc, windowEndUtc)
      .map((s) => ({ startUtc: s.startUtc, endUtc: s.endUtc }));
    const footageMinutes = footageMinutesForBuckets(edges, segments, nowUtc);
    const watchedMinutes = watch.perCamera.get(camId) ?? edges.map(() => null);
    const footageWatch = edges.map((_, i) => ({ footageMin: footageMinutes[i], watchedMin: watchedMinutes[i] }));
    perCameraHourBuckets.set(
      camId,
      buildActivityBuckets(edges, events, footageWatch, tz, countsFromByCamera.get(camId) ?? null, watchMeasuredFromUtc, camId),
    );
  }

  const combinedHourBuckets = combineHourBuckets(edges, perCameraHourBuckets, tz, countsFromUtc, watchMeasuredFromUtc);
  // "The busiest hour" always names an hour, in both ranges.
  const busiestHour = busiestWatchedHour(combinedHourBuckets);

  let buckets;
  let perCamera;
  if (range === '24h') {
    buckets = combinedHourBuckets;
    perCamera = cameraIds.map((id) => {
      const camBuckets = perCameraHourBuckets.get(id);
      return { cameraId: id, buckets: camBuckets, totals: sumTotals(camBuckets) };
    });
  } else {
    let offset = 0;
    const combinedDayBuckets = [];
    const perCameraDayBuckets = new Map(cameraIds.map((id) => [id, []]));
    for (const day of dayEdges) {
      const start = offset;
      const end = offset + day.hourCount;
      offset = end;
      const dayEdge = { startUtc: day.startUtc, endUtc: day.endUtc };
      combinedDayBuckets.push(rollUpDayBucket(dayEdge, combinedHourBuckets.slice(start, end)));
      for (const camId of cameraIds) {
        perCameraDayBuckets.get(camId).push(rollUpDayBucket(dayEdge, perCameraHourBuckets.get(camId).slice(start, end)));
      }
    }
    buckets = combinedDayBuckets;
    perCamera = cameraIds.map((id) => {
      const camBuckets = perCameraDayBuckets.get(id);
      return { cameraId: id, buckets: camBuckets, totals: sumTotals(camBuckets) };
    });
  }

  return {
    ok: true,
    available: true,
    range,
    tz,
    camera: cameraId,
    buckets,
    perCamera,
    totals: sumTotals(buckets),
    countsFromUtc,
    watchMeasuredFromUtc,
    busiestHour,
  };
}
