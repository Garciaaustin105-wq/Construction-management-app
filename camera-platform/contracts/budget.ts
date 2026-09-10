/**
 * Bitrate budgeting.
 *
 * WHY this exists: with disk sized close to the retention target there is no
 * spare capacity absorbing a bad estimate. A camera drifting above its share
 * does not announce itself — the ring buffer simply starts evicting sooner, and
 * nobody notices until someone asks for day 28 and it is gone.
 *
 * So retention stops being something the console reports after the fact and
 * becomes a budget the appliance checks continuously: here is the bitrate each
 * camera may average to hold the target, here is what each is actually doing,
 * and here is who is over. Reported as measurements, never as an automatic
 * action — nothing re-encodes a camera on its own.
 */

import { SECONDS_PER_DAY } from "./time.js";
import type { CameraBitrate } from "./retention.js";

const BITS_PER_KILOBIT = 1000;
const BITS_PER_BYTE = 8;

export type BudgetResult =
  | {
      kind: "ok";
      /** Average kbps each camera may sustain to hold the target. */
      perCameraKbps: number;
      totalKbps: number;
      targetDays: number;
      cameraCount: number;
      usableBytes: number;
    }
  | { kind: "refused"; reason: string };

/**
 * The per-camera bitrate that exactly fills `usableBytes` in `targetDays`.
 *
 * `usableBytes` should already have filesystem overhead AND ring-buffer
 * headroom taken off it — a buffer run to the rim thrashes and leaves no room
 * for a busy day.
 */
export function computePerCameraBudget(
  targetDays: number,
  usableBytes: number,
  cameraCount: number,
): BudgetResult {
  if (!Number.isFinite(targetDays) || targetDays <= 0) {
    return { kind: "refused", reason: `targetDays must be positive, got ${targetDays}` };
  }
  if (!Number.isFinite(usableBytes) || usableBytes <= 0) {
    return { kind: "refused", reason: `usableBytes must be positive, got ${usableBytes}` };
  }
  if (!Number.isInteger(cameraCount) || cameraCount <= 0) {
    return { kind: "refused", reason: `cameraCount must be a positive integer, got ${cameraCount}` };
  }

  const bytesPerSecond = usableBytes / (targetDays * SECONDS_PER_DAY);
  const totalKbps = (bytesPerSecond * BITS_PER_BYTE) / BITS_PER_KILOBIT;

  return {
    kind: "ok",
    perCameraKbps: totalKbps / cameraCount,
    totalKbps,
    targetDays,
    cameraCount,
    usableBytes,
  };
}

export interface BudgetOverrun {
  cameraId: string;
  measuredKbps: number;
  budgetKbps: number;
  /** 1.5 means it is using 150% of its share. */
  ratio: number;
}

export type BudgetCheck =
  | {
      kind: "ok";
      /** Total measured against total allowed. Under 1.0 means the target holds. */
      utilisation: number;
      projectedDays: number;
      over: BudgetOverrun[];
      unmeasured: string[];
    }
  | { kind: "refused"; reason: string; unmeasured: string[] };

/**
 * Check measured cameras against the budget.
 *
 * Refuses when any camera has no measured bitrate: with no headroom, one
 * unmeasured camera can be the one eating the margin, and a projection that
 * quietly excludes it would read as reassuring while being wrong.
 *
 * Note that `over` can be non-empty while `utilisation` is still under 1 — some
 * cameras exceeding their equal share is normal and fine, as long as others are
 * below theirs. The fleet number is what decides whether the target holds; the
 * per-camera list is for finding which one changed.
 */
export function checkAgainstBudget(
  cameras: readonly CameraBitrate[],
  budget: Extract<BudgetResult, { kind: "ok" }>,
): BudgetCheck {
  const unmeasured = cameras.filter((c) => c.bitrateKbps === null).map((c) => c.cameraId);
  if (unmeasured.length > 0) {
    return {
      kind: "refused",
      reason:
        `${unmeasured.length} camera(s) have no measured bitrate; with no spare disk ` +
        "an unmeasured camera may be the one consuming the margin",
      unmeasured,
    };
  }
  if (cameras.length === 0) {
    return { kind: "refused", reason: "no cameras supplied", unmeasured: [] };
  }

  const totalKbps = cameras.reduce((sum, c) => sum + (c.bitrateKbps as number), 0);
  if (totalKbps <= 0) {
    return { kind: "refused", reason: "total measured bitrate is zero; that is a fault", unmeasured: [] };
  }

  const over: BudgetOverrun[] = [];
  for (const camera of cameras) {
    const measuredKbps = camera.bitrateKbps as number;
    if (measuredKbps > budget.perCameraKbps) {
      over.push({
        cameraId: camera.cameraId,
        measuredKbps,
        budgetKbps: budget.perCameraKbps,
        ratio: measuredKbps / budget.perCameraKbps,
      });
    }
  }
  over.sort((a, b) => b.ratio - a.ratio);

  const bytesPerSecond = (totalKbps * BITS_PER_KILOBIT) / BITS_PER_BYTE;
  return {
    kind: "ok",
    utilisation: totalKbps / budget.totalKbps,
    projectedDays: budget.usableBytes / (bytesPerSecond * SECONDS_PER_DAY),
    over,
    unmeasured: [],
  };
}

/** Ring buffers should not run to the rim. Applied on top of filesystem overhead. */
export function withRingHeadroom(usableBytes: number, fillFraction = 0.85): number {
  if (fillFraction <= 0 || fillFraction > 1) {
    throw new RangeError(`fillFraction must be in (0,1], got ${fillFraction}`);
  }
  return usableBytes * fillFraction;
}
