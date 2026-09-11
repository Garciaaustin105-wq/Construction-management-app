/**
 * The recording index: where each span of a camera's time physically lives.
 *
 * The load-bearing idea is that a `gap` is a value, not an absence. During a
 * break-in investigation "the camera was offline" and "nothing happened" are
 * opposite answers, and a timeline that renders both as empty space has told
 * the viewer the wrong one.
 */

import { checkRange, parseUtc, toUtc, type EpochMs, type UtcRange } from "./time.js";

export type SegmentTier = "edge" | "s3" | "glacier" | "gap";

export type GapReason =
  | "camera_offline"
  | "appliance_offline"
  | "disk_full"
  | "evicted_by_retention"
  | "tampered"
  | "unknown";

export type Codec = "h264" | "h265";

export interface Segment {
  cameraId: string;
  startUtc: string;
  endUtc: string;
  tier: SegmentTier;
  /** Storage key. Null when the span is on the appliance or is a gap. */
  key: string | null;
  /** Null for a gap — NOT zero. An outage must never sum as free footage. */
  bytes: number | null;
  /** Null for a gap: we do not know what the camera would have produced. */
  codec: Codec | null;
  bitrateKbps: number | null;
  gapReason?: GapReason;
}

export function isGap(segment: Segment): boolean {
  return segment.tier === "gap";
}

/** A span the appliance actually recorded, before gaps are computed around it. */
export interface RecordedSpan {
  cameraId: string;
  startUtc: string;
  endUtc: string;
  tier: Exclude<SegmentTier, "gap">;
  key: string | null;
  bytes: number;
  codec: Codec;
  bitrateKbps: number;
}

export class SegmentError extends Error {}

function makeGap(
  cameraId: string,
  startMs: EpochMs,
  endMs: EpochMs,
  gapReason: GapReason,
): Segment {
  return {
    cameraId,
    startUtc: toUtc(startMs),
    endUtc: toUtc(endMs),
    tier: "gap",
    key: null,
    bytes: null,
    codec: null,
    bitrateKbps: null,
    gapReason,
  };
}

/**
 * Produce a complete, contiguous, sorted timeline for one camera over a window.
 *
 * Every instant in [rangeStart, rangeEnd) is accounted for by exactly one
 * segment: either something recorded, or an explicit gap. Spans are clipped to
 * the window and overlaps are merged.
 *
 * WHY merge overlaps: during the parallel-run migration two systems record the
 * same camera at once, so overlapping spans are expected input, not corruption.
 */
export function buildTimeline(
  cameraId: string,
  recorded: readonly RecordedSpan[],
  range: UtcRange,
  gapReason: GapReason = "unknown",
): Segment[] {
  const { startMs: rangeStart, endMs: rangeEnd } = checkRange(range);

  const foreign = recorded.find((s) => s.cameraId !== cameraId);
  if (foreign) {
    throw new SegmentError(
      `buildTimeline for ${cameraId} received a span for ${foreign.cameraId}`,
    );
  }

  // Clip to the window, drop anything outside it, then sort by start.
  const clipped = recorded
    .map((span) => {
      const s = parseUtc(span.startUtc);
      const e = parseUtc(span.endUtc);
      if (e < s) {
        throw new SegmentError(
          `span ends before it starts: ${span.startUtc} .. ${span.endUtc}`,
        );
      }
      return { span, startMs: Math.max(s, rangeStart), endMs: Math.min(e, rangeEnd) };
    })
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const out: Segment[] = [];
  let cursor = rangeStart;

  for (const c of clipped) {
    // Fully swallowed by a previous span — nothing left to emit.
    if (c.endMs <= cursor) continue;

    if (c.startMs > cursor) {
      out.push(makeGap(cameraId, cursor, c.startMs, gapReason));
    }

    const emitStart = Math.max(c.startMs, cursor);
    out.push({
      cameraId,
      startUtc: toUtc(emitStart),
      endUtc: toUtc(c.endMs),
      tier: c.span.tier,
      key: c.span.key,
      bytes: c.span.bytes,
      codec: c.span.codec,
      bitrateKbps: c.span.bitrateKbps,
    });
    cursor = c.endMs;
  }

  if (cursor < rangeEnd) {
    out.push(makeGap(cameraId, cursor, rangeEnd, gapReason));
  }

  return out;
}

/** Bytes actually held. Gaps contribute nothing and are not counted as zero-cost
 *  footage — they are skipped outright. */
export function totalRecordedBytes(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => (s.bytes === null ? sum : sum + s.bytes), 0);
}

export function durationSeconds(segment: Segment): number {
  return (parseUtc(segment.endUtc) - parseUtc(segment.startUtc)) / 1000;
}

export interface Coverage {
  recordedSeconds: number;
  gapSeconds: number;
  /** 0..1. Reported, never rounded up for presentation. */
  ratio: number;
  gapsByReason: Record<string, number>;
}

/** What fraction of a window we actually hold, and why the rest is missing.
 *  This is a measurement, not a verdict — it does not decide whether coverage
 *  is "acceptable". */
export function coverage(segments: readonly Segment[]): Coverage {
  let recordedSeconds = 0;
  let gapSeconds = 0;
  const gapsByReason: Record<string, number> = {};

  for (const s of segments) {
    const secs = durationSeconds(s);
    if (isGap(s)) {
      gapSeconds += secs;
      const reason = s.gapReason ?? "unknown";
      gapsByReason[reason] = (gapsByReason[reason] ?? 0) + secs;
    } else {
      recordedSeconds += secs;
    }
  }

  const total = recordedSeconds + gapSeconds;
  return {
    recordedSeconds,
    gapSeconds,
    ratio: total === 0 ? 0 : recordedSeconds / total,
    gapsByReason,
  };
}

/**
 * Merge adjacent spans that share a tier, for rendering.
 *
 * `buildTimeline` deliberately keeps one span per file, because each is a
 * distinct object with its own key and byte count. A UI does not want that: a
 * day of unbroken recording is 1,440 identical abutting blocks, and a month is
 * 43,200. What a viewer needs to see is where the recording is and where it is
 * not.
 *
 * Gaps are merged only with gaps of the SAME reason. "Camera offline" followed
 * by "disk full" is two different facts and collapsing them into one band would
 * throw away the more useful half.
 */
export function coalesceForDisplay(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.tier === segment.tier &&
      previous.endUtc === segment.startUtc &&
      previous.gapReason === segment.gapReason;

    if (!mergeable) {
      out.push({ ...segment });
      continue;
    }
    previous.endUtc = segment.endUtc;
    // Bytes stay summable for recorded spans and stay null across gaps — a
    // merged gap must not acquire a byte count of zero.
    previous.bytes =
      previous.bytes === null || segment.bytes === null ? previous.bytes : previous.bytes + segment.bytes;
    // The key identified one file; a merged span is no longer one file.
    previous.key = null;
  }
  return out;
}
