/**
 * Which recorded files an export of one camera's range delivers, and which gaps
 * it must declare, or a refusal. Pure: the route in api-server.mjs streams
 * what this plans. See EXPORT-SPEC.md.
 *
 * THE FEARED FAILURE: an export across an outage that plays as unbroken
 * footage. So files are whole segments, never joined or trimmed, and every gap
 * run of the requested range is listed with its reason and source, taken from
 * coverageFromIndex so the manifest and the review strip can never disagree.
 */
import { parseUtc, toUtc, type UtcRange } from "./time.js";
import type { GapReason } from "./segment.js";
import { coverageFromIndex, type IndexedSegment, type IndexedGap } from "./indexCoverage.js";
import { segmentId } from "./apiQuery.js";
import { ZIP32_MAX, ZIP32_MAX_ENTRIES } from "./zipStore.js";

/**
 * Bytes reserved below ZIP32_MAX for everything in the archive that is not a
 * segment's bytes: headers, data descriptors, central directory and manifest.
 */
export const EXPORT_OVERHEAD_BYTES = 64 * 1024 * 1024;

export type ExportRefusalCode =
  | "export_reaches_recording"
  | "export_nothing_recorded"
  | "export_size_unknown"
  | "export_too_large";

export interface ExportRefusal {
  ok: false;
  status: 422;
  code: ExportRefusalCode;
  /** For a person. Never contains a storage path. */
  message: string;
}

export interface ExportFile {
  /** `segmentId(cameraId, startMs)`. */
  segmentId: string;
  /** For the server only, from the index. Never sent to a client or written to the manifest. */
  path: string;
  /** Archive entry name: `${cameraId}/${startUtc with every ":" replaced by "-"}.mp4`. */
  name: string;
  /** toUtc of the segment's own start and end: not clipped, not seam-adjusted. */
  startUtc: string;
  endUtc: string;
  bytes: number;
}

export interface ExportGap {
  startUtc: string;
  endUtc: string;
  reason: GapReason;
  source: "logged" | "inferred";
}

export interface ExportPlan {
  ok: true;
  cameraId: string;
  /** The range as passed in, normalised with toUtc. */
  requested: UtcRange;
  /** Earliest file start to latest file end. Whole files, so usually wider than requested. */
  delivered: UtcRange;
  /** Sorted by start. */
  files: ExportFile[];
  /** The gap runs of coverageFromIndex over `requested`, in order. */
  gaps: ExportGap[];
  /** From that same coverage, over `requested`. */
  recordedSeconds: number;
  gapSeconds: number;
  /** Sum of files' bytes. */
  totalBytes: number;
}

/**
 * Plan an export of `range` for `cameraId`.
 *
 * `segments` and `gaps`: every row for the camera. `range`: the `effective`
 * range from parseWindow, so it ends at or before `nowUtc`.
 *
 * 1. coverage = coverageFromIndex(cameraId, segments, gaps, range, nowUtc).
 *    Whatever it throws propagates unchanged (a foreign camera, a range past
 *    now, an inconsistent index).
 * 2. Select the segments whose own extent intersects the range, half-open:
 *    start < range end AND end > range start, where an open segment's end is
 *    `nowUtc`. So a segment ending exactly at the range start, or starting
 *    exactly at the range end, is not selected. Sort the selection by start.
 * 3. Refuse, first match wins, each `{ ok: false, status: 422, code, message }`:
 *    a. any selected segment is open: `export_reaches_recording`. The message
 *       names that segment's start (toUtc form) as the instant to end before.
 *    b. nothing selected: `export_nothing_recorded`.
 *    c. any selected segment's bytes is null, or not a non-negative safe
 *       integer: `export_size_unknown`. A blank is not a zero.
 *    d. files + 1 (the manifest) > ZIP32_MAX_ENTRIES, or the total bytes >
 *       ZIP32_MAX - EXPORT_OVERHEAD_BYTES: `export_too_large`. Exactly equal
 *       to either limit is allowed.
 * 4. Otherwise the plan, as ExportPlan documents. `delivered` ends at the
 *    LATEST end among the files, which is not always the last file's end.
 *    Gap runs map as startUtc, endUtc, reason = gapReason, source = gapSource.
 */
export function planExport(
  cameraId: string,
  segments: readonly IndexedSegment[],
  gaps: readonly IndexedGap[],
  range: UtcRange,
  nowUtc: string,
): ExportPlan | ExportRefusal {
  const coverage = coverageFromIndex(cameraId, segments, gaps, range, nowUtc);
  const rangeStartMs = parseUtc(range.startUtc);
  const rangeEndMs = parseUtc(range.endUtc);
  const selected: IndexedSegment[] = [];
  for (const seg of segments) {
    const segStartMs = parseUtc(seg.startUtc);
    const segEndMs = seg.endUtc === null ? parseUtc(nowUtc) : parseUtc(seg.endUtc);
    if (segStartMs < rangeEndMs && segEndMs > rangeStartMs) {
      selected.push(seg);
    }
  }
  const sortedSelected = [...selected].sort((a, b) => parseUtc(a.startUtc) - parseUtc(b.startUtc));
  for (const seg of sortedSelected) {
    if (seg.endUtc === null) {
      return {
        ok: false,
        status: 422,
        code: "export_reaches_recording",
        message: `export reaches recording at ${toUtc(parseUtc(seg.startUtc))}`
      };
    }
  }
  if (sortedSelected.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "export_nothing_recorded",
      message: "no recorded segments selected"
    };
  }
  let totalBytes = 0;
  for (const seg of sortedSelected) {
    const b = seg.bytes;
    if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) {
      return {
        ok: false,
        status: 422,
        code: "export_size_unknown",
        message: "segment size unknown"
      };
    }
    totalBytes += b;
  }
  if (sortedSelected.length + 1 > ZIP32_MAX_ENTRIES || totalBytes > ZIP32_MAX - EXPORT_OVERHEAD_BYTES) {
    return {
      ok: false,
      status: 422,
      code: "export_too_large",
      message: "export too large"
    };
  }
  const files: ExportFile[] = [];
  for (const seg of sortedSelected) {
    const startMs = parseUtc(seg.startUtc);
    const endMs = seg.endUtc === null ? parseUtc(nowUtc) : parseUtc(seg.endUtc);
    const bytes = seg.bytes;
    if (bytes === null) throw new Error("unreachable: bytes validated above");
    files.push({
      segmentId: segmentId(cameraId, startMs),
      path: seg.path,
      name: `${cameraId}/${toUtc(startMs).split(":").join("-")}.mp4`,
      startUtc: toUtc(startMs),
      endUtc: toUtc(endMs),
      bytes
    });
  }
  const gapsArr: ExportGap[] = [];
  for (const run of coverage.runs) {
    if (run.kind !== "gap") continue;
    if (run.gapReason === null || run.gapSource === null) continue;
    gapsArr.push({
      startUtc: run.startUtc,
      endUtc: run.endUtc,
      reason: run.gapReason,
      source: run.gapSource
    });
  }
  const first = files[0];
  if (first === undefined) {
    return {
      ok: false,
      status: 422,
      code: "export_nothing_recorded",
      message: "no recorded segments selected"
    };
  }
  const deliveredStartMs = parseUtc(first.startUtc);
  let deliveredEndMs = parseUtc(first.endUtc);
  for (const f of files) {
    const endMs = parseUtc(f.endUtc);
    if (endMs > deliveredEndMs) {
      deliveredEndMs = endMs;
    }
  }
  const delivered: UtcRange = { startUtc: toUtc(deliveredStartMs), endUtc: toUtc(deliveredEndMs) };
  const requested: UtcRange = { startUtc: toUtc(rangeStartMs), endUtc: toUtc(rangeEndMs) };
  return {
    ok: true,
    cameraId,
    requested,
    delivered,
    files,
    gaps: gapsArr,
    recordedSeconds: coverage.recordedSeconds,
    gapSeconds: coverage.gapSeconds,
    totalBytes
  };
}
