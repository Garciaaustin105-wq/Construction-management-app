/**
 * The review timeline: where there is recording, where there is not, and where
 * something happened.
 *
 * Detections are what make a month of footage usable. Without them you must
 * already know the time; with them you jump between the six moments that
 * mattered instead of scrubbing eight hours of empty corridor. They are also
 * almost free — a detection is tens of bytes against 18 MB of segment.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a bucket with no detections and a
 * bucket with no recording must never look the same. "Nothing happened here"
 * and "we have no idea what happened here" are opposite answers, and a density
 * strip that renders both as empty has told the viewer the wrong one.
 */

import { checkRange, parseUtc, toUtc, type UtcRange } from "./time.js";
import { coverage, isGap, type Segment } from "./segment.js";

export type DetectionKind = "motion" | "person" | "vehicle" | "plate";

export interface TimelineDetection {
  cameraId: string;
  atUtc: string;
  kind: DetectionKind;
  confidence: number;
  clipKey?: string | null;
}

export interface DetectionBucket {
  startUtc: string;
  endUtc: string;
  counts: Record<DetectionKind, number>;
  total: number;
  /**
   * The events themselves, when few enough to be individually clickable.
   * Null when the bucket is dense and only a count is meaningful.
   */
  events: TimelineDetection[] | null;
  /**
   * Fraction of this bucket for which we hold recording, 0..1.
   *
   * A bucket with `total: 0` and `coverage: 1` is genuinely quiet. One with
   * `total: 0` and `coverage: 0` is a blind spot. The UI must draw them
   * differently.
   */
  coverage: number;
}

export interface Timeline {
  cameraId: string;
  range: UtcRange;
  /** Coalesced recording spans, including gaps — for the coverage bar. */
  spans: Segment[];
  buckets: DetectionBucket[];
  bucketSeconds: number;
  totalDetections: number;
}

const EMPTY_COUNTS = (): Record<DetectionKind, number> => ({
  motion: 0, person: 0, vehicle: 0, plate: 0,
});

/** Above this many events in one bucket, only the count is useful. */
const INDIVIDUAL_EVENT_LIMIT = 4;

export class TimelineError extends Error {}

/**
 * Build a render-ready timeline.
 *
 * `bucketCount` should be roughly the pixel width available — asking for more
 * buckets than pixels produces detail nobody can see, and asking for far fewer
 * hides events behind a single fat marker.
 */
export function buildReviewTimeline(
  cameraId: string,
  spans: readonly Segment[],
  detections: readonly TimelineDetection[],
  range: UtcRange,
  bucketCount = 240,
): Timeline {
  const { startMs, endMs } = checkRange(range);
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > 10_000) {
    throw new TimelineError(`bucketCount must be an integer in 1..10000, got ${bucketCount}`);
  }

  const spanMs = endMs - startMs;
  const bucketMs = spanMs / bucketCount;

  // Coverage per bucket, computed from the recording spans rather than assumed.
  const recorded: Array<{ from: number; to: number }> = [];
  for (const span of spans) {
    if (isGap(span)) continue;
    recorded.push({ from: parseUtc(span.startUtc), to: parseUtc(span.endUtc) });
  }

  const buckets: DetectionBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const from = startMs + i * bucketMs;
    const to = i === bucketCount - 1 ? endMs : startMs + (i + 1) * bucketMs;

    let covered = 0;
    for (const span of recorded) {
      const overlap = Math.min(to, span.to) - Math.max(from, span.from);
      if (overlap > 0) covered += overlap;
    }

    buckets.push({
      startUtc: toUtc(Math.round(from)),
      endUtc: toUtc(Math.round(to)),
      counts: EMPTY_COUNTS(),
      total: 0,
      events: [],
      coverage: to > from ? Math.min(1, covered / (to - from)) : 0,
    });
  }

  let totalDetections = 0;
  for (const detection of detections) {
    if (detection.cameraId !== cameraId) {
      throw new TimelineError(
        `timeline for ${cameraId} received a detection for ${detection.cameraId}`,
      );
    }
    const atMs = parseUtc(detection.atUtc);
    if (atMs < startMs || atMs >= endMs) continue;

    const index = Math.min(bucketCount - 1, Math.floor((atMs - startMs) / bucketMs));
    const bucket = buckets[index] as DetectionBucket;
    bucket.counts[detection.kind]++;
    bucket.total++;
    (bucket.events as TimelineDetection[]).push(detection);
    totalDetections++;
  }

  // Drop the individual events from dense buckets — a hundred markers in one
  // pixel is not clickable, and shipping them to the client is wasted bytes.
  for (const bucket of buckets) {
    const events = bucket.events as TimelineDetection[];
    if (events.length > INDIVIDUAL_EVENT_LIMIT) {
      bucket.events = null;
    } else if (events.length === 0) {
      bucket.events = [];
    } else {
      events.sort((a, b) => parseUtc(a.atUtc) - parseUtc(b.atUtc));
    }
  }

  return {
    cameraId,
    range,
    spans: [...spans],
    buckets,
    bucketSeconds: bucketMs / 1000,
    totalDetections,
  };
}

/**
 * Where a viewer should look, ranked.
 *
 * The point of a review timeline is not to show everything — it is to answer
 * "where do I start". Quiet time is skipped; a bucket with no coverage is
 * surfaced even though it has no events, because a blind spot during the window
 * you care about is itself the finding.
 */
export interface PointOfInterest {
  startUtc: string;
  endUtc: string;
  reason: "detections" | "no_coverage";
  score: number;
  counts: Record<DetectionKind, number>;
}

export function pointsOfInterest(timeline: Timeline, limit = 10): PointOfInterest[] {
  const weights: Record<DetectionKind, number> = { plate: 4, vehicle: 3, person: 3, motion: 1 };
  const out: PointOfInterest[] = [];

  for (const bucket of timeline.buckets) {
    if (bucket.coverage < 0.5) {
      out.push({
        startUtc: bucket.startUtc,
        endUtc: bucket.endUtc,
        reason: "no_coverage",
        // Less coverage is more interesting, and a total blind spot outranks
        // any quantity of routine motion.
        score: 100 * (1 - bucket.coverage),
        counts: bucket.counts,
      });
      continue;
    }
    if (bucket.total === 0) continue;
    const score = (Object.entries(bucket.counts) as Array<[DetectionKind, number]>)
      .reduce((sum, [kind, n]) => sum + n * weights[kind], 0);
    out.push({
      startUtc: bucket.startUtc,
      endUtc: bucket.endUtc,
      reason: "detections",
      score,
      counts: bucket.counts,
    });
  }

  out.sort((a, b) => b.score - a.score || parseUtc(a.startUtc) - parseUtc(b.startUtc));
  return out.slice(0, limit);
}
