/**
 * Crash reconciliation: what the index believed, versus what is actually on disk.
 *
 * This is the contract behind the Phase 1 exit criterion — *pull the power
 * repeatedly and lose nothing but the outage seconds, with a correct gap*. An
 * appliance that dies mid-write leaves a file the index thinks is still open, a
 * file the index has never heard of, or a file the index expects that is not
 * there. Each of those has exactly one right answer and several plausible wrong
 * ones.
 *
 * Two standing rules:
 *   - Real footage is never discarded because the index lost track of it.
 *     An orphan file is adopted, not deleted.
 *   - Nothing unrecognised is deleted. A file we cannot parse is quarantined
 *     for a human, because "I do not understand this" is not "this is rubbish".
 */

import { parseUtc, toUtc } from "./time.js";
import type { GapReason } from "./segment.js";
import type { DiskFile, StoredSegment } from "./store.js";

export type RecoveryAction =
  /** Index and disk agree. Nothing to do. */
  | { kind: "confirm"; segment: StoredSegment }
  /** Both exist, byte counts differ. The disk is the truth. */
  | { kind: "correct_size"; segment: StoredSegment; indexedBytes: number | null; actualBytes: number }
  /**
   * Open when the process died. The end time in the index is not trustworthy.
   * `estimatedEndUtc` is derived from bytes and measured bitrate and is
   * explicitly an estimate — the caller must probe the media for the real last
   * timestamp before treating it as fact.
   */
  | {
      kind: "seal_partial";
      segment: StoredSegment;
      actualBytes: number;
      estimatedEndUtc: string | null;
      needsMediaValidation: true;
    }
  /** On disk, not in the index. Written before the index commit. Keep it. */
  | { kind: "adopt_orphan"; file: DiskFile; cameraId: string; startUtc: string }
  /** Created, never written to. Not footage. */
  | { kind: "drop_empty"; file: DiskFile }
  /** Unrecognised. Not deleted — set aside for a human. */
  | { kind: "quarantine"; file: DiskFile; reason: string }
  /** The index expected it; the disk does not have it. */
  | { kind: "lost"; segment: StoredSegment; reason: "file_missing" };

export interface RecoveredGap {
  cameraId: string;
  startUtc: string;
  endUtc: string;
  reason: GapReason;
}

export interface RecoveryPlan {
  actions: RecoveryAction[];
  gaps: RecoveredGap[];
  summary: {
    confirmed: number;
    corrected: number;
    partials: number;
    adopted: number;
    dropped: number;
    quarantined: number;
    lost: number;
  };
}

/**
 * Segment file naming: `<cameraId>/<epochMsStart>.mp4`.
 *
 * The camera id is a path component rather than part of the filename so a
 * per-camera directory can be moved, archived or scanned on its own.
 */
export function segmentPath(cameraId: string, startUtc: string): string {
  return `${cameraId}/${parseUtc(startUtc)}.mp4`;
}

export type ParsedPath =
  | { kind: "ok"; cameraId: string; startUtc: string }
  | { kind: "unparseable"; reason: string };

export function parseSegmentPath(path: string): ParsedPath {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) {
    return { kind: "unparseable", reason: `expected <cameraId>/<epochMs>.mp4, got ${JSON.stringify(path)}` };
  }
  const file = parts[parts.length - 1] as string;
  const cameraId = parts[parts.length - 2] as string;
  const match = /^(\d+)\.mp4$/.exec(file);
  if (!match) {
    return { kind: "unparseable", reason: `filename is not <epochMs>.mp4: ${JSON.stringify(file)}` };
  }
  const epochMs = Number(match[1]);
  if (!Number.isSafeInteger(epochMs) || epochMs <= 0) {
    return { kind: "unparseable", reason: `implausible epoch in filename: ${file}` };
  }
  return { kind: "ok", cameraId, startUtc: toUtc(epochMs) };
}

/** Conservative end estimate from bytes at a measured bitrate. Null when the
 *  bitrate was never measured — we do not invent one. */
export function estimateEndUtc(
  startUtc: string,
  bytes: number,
  bitrateKbps: number | null,
): string | null {
  if (bitrateKbps === null || bitrateKbps <= 0 || bytes <= 0) return null;
  const seconds = (bytes * 8) / (bitrateKbps * 1000);
  return toUtc(parseUtc(startUtc) + Math.floor(seconds * 1000));
}

/**
 * Reconcile the index against a directory scan.
 *
 * `scanBoundaryUtc` is when the scan ran — used as the end of the gap created
 * by a crash, since nothing was recorded between the crash and now.
 */
export function planRecovery(
  indexed: readonly StoredSegment[],
  onDisk: readonly DiskFile[],
  scanBoundaryUtc: string,
): RecoveryPlan {
  const boundaryMs = parseUtc(scanBoundaryUtc);
  const byPath = new Map<string, DiskFile>();
  for (const file of onDisk) byPath.set(file.path, file);

  const actions: RecoveryAction[] = [];
  const gaps: RecoveredGap[] = [];
  const claimed = new Set<string>();

  for (const segment of indexed) {
    const file = byPath.get(segment.path);

    if (file === undefined) {
      actions.push({ kind: "lost", segment, reason: "file_missing" });
      gaps.push({
        cameraId: segment.cameraId,
        startUtc: segment.startUtc,
        endUtc: segment.endUtc ?? scanBoundaryUtc,
        reason: "unknown",
      });
      continue;
    }

    claimed.add(file.path);

    if (segment.state === "open") {
      const estimatedEndUtc = estimateEndUtc(segment.startUtc, file.bytes, segment.bitrateKbps);
      actions.push({
        kind: "seal_partial",
        segment,
        actualBytes: file.bytes,
        estimatedEndUtc,
        needsMediaValidation: true,
      });
      // Everything from where the recording actually stopped to the scan is a
      // gap. When the end could not be estimated the whole span is unknown, and
      // saying so is better than implying coverage we cannot prove.
      const gapStart = estimatedEndUtc ?? segment.startUtc;
      if (parseUtc(gapStart) < boundaryMs) {
        gaps.push({
          cameraId: segment.cameraId,
          startUtc: gapStart,
          endUtc: scanBoundaryUtc,
          reason: "appliance_offline",
        });
      }
      continue;
    }

    if (segment.bytes !== file.bytes) {
      actions.push({
        kind: "correct_size",
        segment,
        indexedBytes: segment.bytes,
        actualBytes: file.bytes,
      });
      continue;
    }

    actions.push({ kind: "confirm", segment });
  }

  for (const file of onDisk) {
    if (claimed.has(file.path)) continue;

    if (file.bytes === 0) {
      actions.push({ kind: "drop_empty", file });
      continue;
    }

    const parsed = parseSegmentPath(file.path);
    if (parsed.kind === "unparseable") {
      actions.push({ kind: "quarantine", file, reason: parsed.reason });
      continue;
    }

    actions.push({
      kind: "adopt_orphan",
      file,
      cameraId: parsed.cameraId,
      startUtc: parsed.startUtc,
    });
  }

  const summary = {
    confirmed: actions.filter((a) => a.kind === "confirm").length,
    corrected: actions.filter((a) => a.kind === "correct_size").length,
    partials: actions.filter((a) => a.kind === "seal_partial").length,
    adopted: actions.filter((a) => a.kind === "adopt_orphan").length,
    dropped: actions.filter((a) => a.kind === "drop_empty").length,
    quarantined: actions.filter((a) => a.kind === "quarantine").length,
    lost: actions.filter((a) => a.kind === "lost").length,
  };

  return { actions, gaps, summary };
}
