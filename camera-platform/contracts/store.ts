/**
 * What the appliance believes is on its disk.
 *
 * Kept separate from `segment.ts` on purpose: `Segment` is what a viewer sees
 * on a timeline, `StoredSegment` is what the recorder manages. They differ in
 * the ways that matter here — a stored segment can be open, can be under
 * evidence hold, and can be awaiting a cloud copy.
 */

export type SegmentState =
  /** Closed cleanly. Byte count and end time are trustworthy. */
  | "sealed"
  /** Being written right now. End time unknown until it is sealed. */
  | "open"
  /** Was open when the process died. End time is NOT trustworthy. */
  | "partial";

export interface StoredSegment {
  cameraId: string;
  startUtc: string;
  /** Null while open, and untrustworthy while partial. */
  endUtc: string | null;
  path: string;
  /** Null when unknown — never 0 as a stand-in for "not measured yet". */
  bytes: number | null;
  state: SegmentState;
  /** Evidence or legal hold. Never evicted, whatever the disk pressure. */
  hold: boolean;
  /**
   * Carries an incident whose cloud copy has not been confirmed. Evicting one
   * of these destroys the only copy of the footage someone asked for.
   */
  pendingUpload: boolean;
  /** Measured bitrate of the stream that produced it. Null if unmeasured. */
  bitrateKbps: number | null;
}

/** A file as a directory scan sees it. No interpretation. */
export interface DiskFile {
  path: string;
  bytes: number;
}

export function isEvictable(segment: StoredSegment): boolean {
  return !segment.hold && !segment.pendingUpload && segment.state !== "open";
}
