/**
 * From index rows to what a viewer is shown: coverage for a window, and which
 * file answers "play from this instant".
 *
 * The index (agent/segindex.mjs) holds two tables. Segments are what we have.
 * Gaps are what we know we lack, each with the reason we logged at the time.
 * `buildTimeline` in segment.ts predates the gaps table and gives every hole ONE
 * reason; this module exists so that a camera offline from 02:00 to 03:00 and a
 * full disk from 04:00 to 05:00 show as two different facts, and so that a hole
 * nobody logged says "unknown" rather than borrowing its neighbour's reason.
 *
 * TWO THINGS ABOUT THE ROWS THAT ARE NOT OBVIOUS FROM THE SCHEMA:
 *
 * 1. A sealed segment's `endUtc` is NOMINAL — start + segment length — not
 *    measured (agent/recorder.mjs). ffmpeg splits at the first keyframe after a
 *    clock boundary, so the real boundary drifts by up to a GOP either way, and
 *    the first segment after an ffmpeg restart is short but indexed as full.
 *    Hence: an overlap is resolved in favour of the later segment, whose start
 *    comes from its filename; and a hole no longer than SEAM_TOLERANCE_MS
 *    between two segments, with no logged gap in it, is a seam, not an outage.
 *    Both are counted and returned, never absorbed silently.
 * 2. The open segment has `endUtc` null and `bytes` null. It extends to now.
 *    Null bytes are not zero bytes and not a gap: a segment whose size is
 *    unknown is still a segment we hold.
 */

import { checkRange, parseUtc, toUtc, type UtcRange } from "./time.js";
import type { GapReason, Segment } from "./segment.js";
import { segmentId } from "./apiQuery.js";

/**
 * The widest hole between consecutive segments still treated as a seam.
 *
 * ASSUMED, NOT MEASURED: a 2 s main-stream GOP (the "2x fps" setting) plus the
 * 1 s resolution of the epoch-second filenames. Re-derive it from real segment
 * boundaries on an appliance before trusting it; `seamsBridged` is returned so
 * that a wrong value shows up as a number, not as missing gaps.
 */
export const SEAM_TOLERANCE_MS = 3_000;

/** One row of `segments`, as segindex's rowToSegment returns it. */
export interface IndexedSegment {
  cameraId: string;
  startUtc: string;
  /** Null exactly when `state` is "open". */
  endUtc: string | null;
  /** Relative to the camera's store root. Internal: never sent to or accepted from a client. */
  path: string;
  bytes: number | null;
  state: string;
  bitrateKbps: number | null;
}

/** One row of `gaps`, as segindex's gapsFor returns it. */
export interface IndexedGap {
  cameraId: string;
  startUtc: string;
  endUtc: string;
  reason: GapReason;
}

export interface CoverageRun {
  startUtc: string;
  endUtc: string;
  kind: "recorded" | "gap";
  /** Recorded: how many index segments intersect this run. Gap: 0. */
  segmentCount: number;
  /** Recorded: the run ends in the segment still being written. Gap: false. */
  includesOpen: boolean;
  /** Gap only; null for a recorded run. */
  gapReason: GapReason | null;
  /** Gap only: "logged" came from the gaps table; "inferred" is a hole nobody logged, reason "unknown". */
  gapSource: "logged" | "inferred" | null;
}

export interface IndexCoverage {
  cameraId: string;
  range: UtcRange;
  /** Contiguous, ordered, and covering `range` exactly. Never empty. */
  runs: CoverageRun[];
  recordedSeconds: number;
  gapSeconds: number;
  /** Every reason present, zeros included — zero seconds of a reason is a measured zero. */
  gapSecondsByReason: Record<GapReason, number>;
  /** Holes closed as seams (see SEAM_TOLERANCE_MS), among the segments supplied. */
  seamsBridged: number;
  /** Segments whose end was pulled back to the next segment's start. */
  overlapsTruncated: number;
}

export class IndexCoverageError extends Error {}

/**
 * Coverage of `range` for one camera.
 *
 * Refuses (throws IndexCoverageError) rather than guessing when:
 * - any segment or gap belongs to another camera;
 * - `range` ends after `nowUtc` (the caller clips with parseWindow first);
 * - a segment's endUtc is null but its state is not "open", or the reverse;
 * - a sealed segment ends at or before it starts;
 * - there is more than one open segment, or the open one is not the latest
 *   start, or it starts at or after now — recovery has not run, or the clock
 *   is wrong, and either way the answer would be invented;
 * - two segments share a start.
 * `range` itself is checked with checkRange (TimeRangeError).
 *
 * Method:
 * 1. Sort segments by start. The open segment ends at `nowUtc`.
 * 2. Where a segment ends after the next one starts, end it at the next start
 *    (overlapsTruncated++).
 * 3. Where the next segment starts 1..SEAM_TOLERANCE_MS after this one ends and
 *    no logged gap overlaps that hole, end this one at the next start
 *    (seamsBridged++).
 * 4. Clip to `range`. Consecutive segments that now touch form one recorded run.
 * 5. Fill each hole in `range`: logged gaps in start order, each clipped to the
 *    part of the hole not yet filled (so where two logged gaps overlap, the one
 *    that started earlier wins); what no logged gap covers is an "unknown",
 *    "inferred" gap. A logged gap never covers recorded time. Adjacent gap runs
 *    with the same reason and source merge.
 * Seconds are (end - start) / 1000 of the runs, not rounded.
 */
export function coverageFromIndex(
  cameraId: string,
  segments: readonly IndexedSegment[],
  gaps: readonly IndexedGap[],
  range: UtcRange,
  nowUtc: string,
): IndexCoverage {
  const { startMs, endMs } = checkRange(range);
  const nowMs = parseUtc(nowUtc);
  if (endMs > nowMs) {
    throw new IndexCoverageError(
      `range ends after now (${range.endUtc} > ${nowUtc}); clip the window with parseWindow first`,
    );
  }
  const normalised = normalise(cameraId, segments, gaps, nowMs);

  const runs: MutableRun[] = [];
  let cursor = startMs;
  for (const seg of normalised.segments) {
    const a = Math.max(seg.startMs, startMs);
    const b = Math.min(seg.endMs, endMs);
    if (b <= a) continue;
    if (a > cursor) fillHole(runs, cursor, a, normalised.gaps);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === "recorded" && last.endMs === a) {
      last.endMs = b;
      last.segmentCount += 1;
      last.includesOpen = last.includesOpen || seg.open;
    } else {
      runs.push({
        startMs: a, endMs: b, kind: "recorded", segmentCount: 1,
        includesOpen: seg.open, gapReason: null, gapSource: null,
      });
    }
    cursor = b;
  }
  if (cursor < endMs) fillHole(runs, cursor, endMs, normalised.gaps);

  const gapSecondsByReason: Record<GapReason, number> = {
    camera_offline: 0, appliance_offline: 0, disk_full: 0,
    evicted_by_retention: 0, tampered: 0, unknown: 0,
  };
  let recordedSeconds = 0;
  let gapSeconds = 0;
  for (const run of runs) {
    const seconds = (run.endMs - run.startMs) / 1000;
    if (run.kind === "recorded") {
      recordedSeconds += seconds;
    } else {
      gapSeconds += seconds;
      const reason = run.gapReason ?? "unknown";
      gapSecondsByReason[reason] += seconds;
    }
  }

  return {
    cameraId,
    range: { startUtc: toUtc(startMs), endUtc: toUtc(endMs) },
    runs: runs.map((run) => ({
      startUtc: toUtc(run.startMs),
      endUtc: toUtc(run.endMs),
      kind: run.kind,
      segmentCount: run.segmentCount,
      includesOpen: run.includesOpen,
      gapReason: run.gapReason,
      gapSource: run.gapSource,
    })),
    recordedSeconds,
    gapSeconds,
    gapSecondsByReason,
    seamsBridged: normalised.seamsBridged,
    overlapsTruncated: normalised.overlapsTruncated,
  };
}

/** A segment after steps 1-3, in epoch ms. `path` is the index's, never a client's. */
interface AdjustedSegment {
  startMs: number;
  endMs: number;
  open: boolean;
  path: string;
}

interface LoggedGapMs {
  startMs: number;
  endMs: number;
  reason: GapReason;
}

interface Normalised {
  /** Sorted by start, non-overlapping, each of positive length. */
  segments: AdjustedSegment[];
  /** Sorted by start; ties keep the order supplied. */
  gaps: LoggedGapMs[];
  seamsBridged: number;
  overlapsTruncated: number;
}

interface MutableRun {
  startMs: number;
  endMs: number;
  kind: "recorded" | "gap";
  segmentCount: number;
  includesOpen: boolean;
  gapReason: GapReason | null;
  gapSource: "logged" | "inferred" | null;
}

/**
 * Steps 1-3, plus every refusal. coverageFromIndex and resolvePlayback both go
 * through here, so a timeline can never show recording at an instant that
 * playback then calls a gap.
 */
function normalise(
  cameraId: string,
  segments: readonly IndexedSegment[],
  gaps: readonly IndexedGap[],
  nowMs: number,
): Normalised {
  const rows: AdjustedSegment[] = [];
  let openStartMs: number | null = null;

  for (const segment of segments) {
    if (segment.cameraId !== cameraId) {
      throw new IndexCoverageError(
        `segment belongs to ${JSON.stringify(segment.cameraId)}, not ${JSON.stringify(cameraId)}`,
      );
    }
    const startMs = parseUtc(segment.startUtc);
    if (segment.state === "open") {
      if (segment.endUtc !== null) {
        throw new IndexCoverageError(`open segment at ${segment.startUtc} has an end — it has not been sealed`);
      }
      if (openStartMs !== null) {
        throw new IndexCoverageError("two open segments — recovery has not run");
      }
      if (startMs >= nowMs) {
        throw new IndexCoverageError(`open segment starts at or after now: ${segment.startUtc}`);
      }
      openStartMs = startMs;
      rows.push({ startMs, endMs: nowMs, open: true, path: segment.path });
      continue;
    }
    const endUtc = segment.endUtc;
    if (endUtc === null) {
      throw new IndexCoverageError(
        `segment at ${segment.startUtc} has no end but state ${JSON.stringify(segment.state)}, not "open"`,
      );
    }
    const endMs = parseUtc(endUtc);
    if (endMs <= startMs) {
      throw new IndexCoverageError(`segment at ${segment.startUtc} ends at or before it starts`);
    }
    rows.push({ startMs, endMs, open: false, path: segment.path });
  }

  rows.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1];
    const current = rows[i];
    if (previous !== undefined && current !== undefined && previous.startMs === current.startMs) {
      throw new IndexCoverageError(`two segments share a start: ${toUtc(current.startMs)}`);
    }
  }
  const latest = rows[rows.length - 1];
  if (openStartMs !== null && (latest === undefined || latest.startMs !== openStartMs)) {
    throw new IndexCoverageError("the open segment is not the latest — recovery has not run");
  }

  const logged: LoggedGapMs[] = [];
  for (const entry of gaps) {
    if (entry.cameraId !== cameraId) {
      throw new IndexCoverageError(
        `gap belongs to ${JSON.stringify(entry.cameraId)}, not ${JSON.stringify(cameraId)}`,
      );
    }
    const startMs = parseUtc(entry.startUtc);
    const endMs = parseUtc(entry.endUtc);
    // A zero-length or inverted logged gap covers no instant; it is dropped
    // rather than refused, because it changes no answer.
    if (endMs > startMs) logged.push({ startMs, endMs, reason: entry.reason });
  }
  logged.sort((a, b) => a.startMs - b.startMs);

  let overlapsTruncated = 0;
  let seamsBridged = 0;
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const current = rows[i];
    const next = rows[i + 1];
    if (current === undefined || next === undefined) continue;
    if (current.endMs > next.startMs) {
      current.endMs = next.startMs;
      overlapsTruncated += 1;
      continue;
    }
    const hole = next.startMs - current.endMs;
    if (hole < 1 || hole > SEAM_TOLERANCE_MS) continue;
    const holeStart = current.endMs;
    const logHere = logged.some((g) => g.startMs < next.startMs && g.endMs > holeStart);
    if (logHere) continue;
    current.endMs = next.startMs;
    seamsBridged += 1;
  }

  return { segments: rows, gaps: logged, seamsBridged, overlapsTruncated };
}

/**
 * Step 5 for one instant: the logged gap with the earliest start covering it,
 * else "unknown"/"inferred". Processing logged gaps in start order and clipping
 * each to what is still unfilled gives exactly this answer per instant, so
 * coverage and playback can share it.
 */
function gapAt(atMs: number, logged: readonly LoggedGapMs[]): { reason: GapReason; source: "logged" | "inferred" } {
  for (const g of logged) {
    if (g.startMs <= atMs && atMs < g.endMs) {
      return { reason: g.reason, source: "logged" };
    }
  }
  return { reason: "unknown", source: "inferred" };
}

/** Fill [a, b) with gap runs, merging into `runs` when the neighbour is identical. */
function fillHole(runs: MutableRun[], a: number, b: number, logged: readonly LoggedGapMs[]): void {
  let t = a;
  while (t < b) {
    const found = gapAt(t, logged);
    let end = b;
    if (found.source === "logged") {
      for (const g of logged) {
        if (g.startMs <= t && t < g.endMs) { end = Math.min(g.endMs, b); break; }
      }
    } else {
      // Runs to the start of the next logged gap, since none covers `t` now.
      for (const g of logged) {
        if (g.startMs > t && g.startMs < end) end = g.startMs;
      }
    }
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === "gap" && last.endMs === t
      && last.gapReason === found.reason && last.gapSource === found.source) {
      last.endMs = end;
    } else {
      runs.push({
        startMs: t, endMs: end, kind: "gap", segmentCount: 0,
        includesOpen: false, gapReason: found.reason, gapSource: found.source,
      });
    }
    t = end;
  }
}

/**
 * The runs as Segment[], for buildReviewTimeline's per-bucket coverage.
 * Recorded runs are tier "edge"; gaps are tier "gap" with their gapReason.
 * key, bytes, codec and bitrateKbps are null: a run is not one file, the index
 * has no codec column, and a byte sum over clipped files would be invented.
 */
export function runsAsSegments(coverage: IndexCoverage): Segment[] {
  return coverage.runs.map((run) => {
    const span: Segment = {
      cameraId: coverage.cameraId,
      startUtc: run.startUtc,
      endUtc: run.endUtc,
      tier: run.kind === "recorded" ? "edge" : "gap",
      key: null,
      bytes: null,
      codec: null,
      bitrateKbps: null,
    };
    if (run.kind === "gap") span.gapReason = run.gapReason ?? "unknown";
    return span;
  });
}

export type PlaybackResolution =
  | {
      kind: "segment";
      cameraId: string;
      /** For the client: `segmentId(cameraId, startMs)`. */
      segmentId: string;
      /** For the server only — from the index, never from the request. */
      path: string;
      segmentStartUtc: string;
      /** After the overlap and seam adjustments of coverageFromIndex. */
      segmentEndUtc: string;
      /** Seconds from the segment's start to the instant asked for. */
      offsetSeconds: number;
    }
  | {
      kind: "gap";
      cameraId: string;
      reason: GapReason;
      source: "logged" | "inferred";
      /** Start of the first segment after the instant, or null if none was supplied. */
      nextRecordedUtc: string | null;
    }
  /** The instant falls in the segment still being written. Use live, or wait for it to seal. */
  | { kind: "recording"; cameraId: string; segmentStartUtc: string }
  /** The instant is at or after now. */
  | { kind: "future"; cameraId: string; nowUtc: string };

/**
 * Which file, and where in it, answers "play camera X from instant T".
 *
 * Pass EVERY segment and gap for the camera (forCamera / gapsFor), not a
 * window: `nextRecordedUtc` is only as good as what was supplied.
 *
 * Same refusals and the same steps 1–3 as coverageFromIndex, so a viewer never
 * sees coverage at an instant that playback then calls a gap. Intervals are
 * half-open: an instant exactly on a boundary belongs to the later segment.
 * A gap's reason is found as in step 5 of coverageFromIndex.
 */
export function resolvePlayback(
  cameraId: string,
  segments: readonly IndexedSegment[],
  gaps: readonly IndexedGap[],
  atUtc: string,
  nowUtc: string,
): PlaybackResolution {
  const nowMs = parseUtc(nowUtc);
  const atMs = parseUtc(atUtc);
  const normalised = normalise(cameraId, segments, gaps, nowMs);
  if (atMs >= nowMs) return { kind: "future", cameraId, nowUtc: toUtc(nowMs) };

  let next: AdjustedSegment | null = null;
  for (const seg of normalised.segments) {
    if (seg.startMs <= atMs && atMs < seg.endMs) {
      if (seg.open) return { kind: "recording", cameraId, segmentStartUtc: toUtc(seg.startMs) };
      return {
        kind: "segment",
        cameraId,
        segmentId: segmentId(cameraId, seg.startMs),
        path: seg.path,
        segmentStartUtc: toUtc(seg.startMs),
        segmentEndUtc: toUtc(seg.endMs),
        offsetSeconds: (atMs - seg.startMs) / 1000,
      };
    }
    if (seg.startMs > atMs) { next = seg; break; }
  }

  const found = gapAt(atMs, normalised.gaps);
  return {
    kind: "gap",
    cameraId,
    reason: found.reason,
    source: found.source,
    nextRecordedUtc: next === null ? null : toUtc(next.startMs),
  };
}
