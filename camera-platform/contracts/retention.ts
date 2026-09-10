/**
 * Retention arithmetic.
 *
 * This is the number printed on a quote, shown in the console, and relied on by
 * someone looking for footage from three weeks ago. It is a pure function with
 * a harness so it can be checked in a second, and it REFUSES rather than
 * guessing: a camera whose bitrate we have not measured makes the answer
 * unknowable, and a plausible-looking wrong retention figure is worse than no
 * figure at all.
 */

import { SECONDS_PER_DAY } from "./time.js";

export interface CameraBitrate {
  cameraId: string;
  /** Measured kilobits per second. Null means NOT MEASURED — never assume a
   *  default. A camera silently pushing 4 Mbps where 2 was assumed halves a
   *  store's retention and looks completely normal on screen. */
  bitrateKbps: number | null;
}

export type RetentionEstimate =
  | {
      kind: "ok";
      days: number;
      totalKbps: number;
      camerasCounted: number;
      usableBytes: number;
    }
  | {
      kind: "refused";
      reason: "unmeasured_cameras" | "no_cameras" | "no_usable_bytes" | "zero_bitrate";
      message: string;
      unmeasuredCameraIds: string[];
    };

const BITS_PER_KILOBIT = 1000;
const BITS_PER_BYTE = 8;

/**
 * How many days of continuous recording fit in `usableBytes`.
 *
 * Deliberately returns a discriminated result rather than throwing or returning
 * a sentinel: callers must handle the refusal, and a UI that cannot show a
 * number must say why.
 */
export function computeRetentionDays(
  cameras: readonly CameraBitrate[],
  usableBytes: number,
): RetentionEstimate {
  if (cameras.length === 0) {
    return {
      kind: "refused",
      reason: "no_cameras",
      message: "no cameras supplied; retention is undefined rather than infinite",
      unmeasuredCameraIds: [],
    };
  }

  const unmeasured = cameras.filter((c) => c.bitrateKbps === null).map((c) => c.cameraId);
  if (unmeasured.length > 0) {
    return {
      kind: "refused",
      reason: "unmeasured_cameras",
      message:
        `${unmeasured.length} of ${cameras.length} cameras have no measured bitrate; ` +
        "retention cannot be computed without guessing",
      unmeasuredCameraIds: unmeasured,
    };
  }

  if (!Number.isFinite(usableBytes) || usableBytes <= 0) {
    return {
      kind: "refused",
      reason: "no_usable_bytes",
      message: `usableBytes must be a positive number, got ${usableBytes}`,
      unmeasuredCameraIds: [],
    };
  }

  const totalKbps = cameras.reduce((sum, c) => sum + (c.bitrateKbps as number), 0);
  if (totalKbps <= 0) {
    return {
      kind: "refused",
      reason: "zero_bitrate",
      message: "total bitrate is zero; a camera producing no data is a fault, not infinite retention",
      unmeasuredCameraIds: [],
    };
  }

  const bytesPerSecond = (totalKbps * BITS_PER_KILOBIT) / BITS_PER_BYTE;
  const days = usableBytes / (bytesPerSecond * SECONDS_PER_DAY);

  return { kind: "ok", days, totalKbps, camerasCounted: cameras.length, usableBytes };
}

/** Inverse: bytes needed to hold `days` of these cameras. Used for sizing disk
 *  before an appliance is ordered. */
export type SizingEstimate =
  | { kind: "ok"; bytes: number }
  | Extract<RetentionEstimate, { kind: "refused" }>;

export function requiredBytesForDays(
  cameras: readonly CameraBitrate[],
  days: number,
): SizingEstimate {
  const probe = computeRetentionDays(cameras, 1);
  if (probe.kind === "refused") return probe;
  if (!Number.isFinite(days) || days <= 0) {
    return {
      kind: "refused",
      reason: "no_usable_bytes",
      message: `days must be a positive number, got ${days}`,
      unmeasuredCameraIds: [],
    };
  }
  const bytesPerSecond = (probe.totalKbps * BITS_PER_KILOBIT) / BITS_PER_BYTE;
  return { kind: "ok", bytes: bytesPerSecond * SECONDS_PER_DAY * days };
}

/** Filesystems, RAID and reserve mean raw disk is never all usable.
 *  Explicit rather than a magic 0.9 buried in a caller. */
export function usableBytesFromRaw(rawBytes: number, overheadFraction = 0.1): number {
  if (overheadFraction < 0 || overheadFraction >= 1) {
    throw new RangeError(`overheadFraction must be in [0,1), got ${overheadFraction}`);
  }
  return rawBytes * (1 - overheadFraction);
}

export const TERABYTE = 1_000_000_000_000;
