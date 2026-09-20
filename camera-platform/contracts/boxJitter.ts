/**
 * How much a detection's box moved across the frames it was seen in. Pure: no
 * I/O, no clock, no model.
 *
 * WHY: on 2026-09-20 a spray bottle on a shelf was reported as a person 77
 * times in 13 hours. Austin's observation is the discriminator, and it is a
 * physical one rather than a statistical one: a person cannot hold still the
 * way an object does. Breathing and postural sway move a human's box even when
 * they are trying not to move; an object's box moves only by the detector's own
 * noise. So measure the movement.
 *
 * THIS MODULE STATES NO VERDICT. It returns numbers — no isStatic, no
 * isPerson, no threshold (build rule 11). The number that separates furniture
 * from a person has to be MEASURED, by replaying footage of each on the same
 * camera, and until that measurement exists nothing here may pretend to know
 * it. Anyone tempted to add `if (stepMedian < 0.01) suppress()` should read
 * build rule 10 first, and then go and measure.
 *
 * Everything is expressed as a fraction of the box's OWN diagonal, so the same
 * wobble reads the same whether the subject is by the lens or across the room.
 * A reading in frame-fractions would be a measurement of distance wearing the
 * costume of a measurement of movement.
 */

import type { Box } from "./detection.js";

/**
 * Below this many sightings there is nothing to say (build rule 15: gate on
 * sample size). Five sightings is one second at the detector's 5 fps.
 */
export const MIN_SIGHTINGS_FOR_JITTER = 5;

export interface Jitter {
  ok: true;
  /** How many boxes went into this. */
  sightings: number;
  /**
   * The TYPICAL movement between one sighting and the next, as a fraction of
   * the box's diagonal. Median, not mean (build rule 14): one mis-detection
   * that jumps across the frame must not become "it moved a lot".
   */
  stepMedian: number;
  /** The worst single step. Reported so a wild jump is visible, not hidden. */
  stepMax: number;
  /**
   * How far the centre wandered overall: the diagonal of the box containing
   * every centre, over the median diagonal. A slow drift — a trolley rolling,
   * a shadow creeping — has tiny steps and a large spread.
   */
  spread: number;
  /** How much the box's area varied: (max - min) / median, on the diagonal. */
  sizeSpread: number;
  /** How much its shape varied: (max - min) / median of width over height. */
  aspectSpread: number;
}

export interface JitterRefusal {
  ok: false;
  reason: "too_few_sightings" | "unreadable_box";
  sightings: number;
  message: string;
}

function usable(b: unknown): b is Box {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const box = b as Box;
  for (const v of [box.x, box.y, box.w, box.h]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  // A box with no extent has no diagonal to divide by, and dividing by it
  // would produce Infinity dressed up as a measurement.
  return box.w > 0 && box.h > 0;
}

/** The middle value. For an even count, the mean of the two middle ones. */
function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Measure one detection's movement.
 *
 * 1. `boxes` must be an array; each entry must be a readable box with a
 *    positive width and height, else refuse with "unreadable_box" — a box that
 *    cannot be read is not a box that did not move.
 * 2. Fewer than MIN_SIGHTINGS_FOR_JITTER boxes: refuse with
 *    "too_few_sightings". Two frames cannot describe how something moves.
 * 3. Let diag_i = hypot(w_i, h_i) and D = median of all diag_i. Every distance
 *    below is divided by D, so the answer is in units of the thing's own size.
 * 4. stepMedian = median over consecutive pairs of |centre_i - centre_(i-1)| / D.
 *    stepMax = the largest such step.
 * 5. spread = hypot(max cx - min cx, max cy - min cy) / D.
 * 6. sizeSpread = (max diag - min diag) / D.
 *    aspectSpread = (max a - min a) / median a, where a = w / h.
 */
export function jitterOf(boxes: unknown): Jitter | JitterRefusal {
  if (!Array.isArray(boxes)) {
    return { ok: false, reason: "unreadable_box", sightings: 0, message: "jitterOf needs an array of boxes" };
  }
  for (const b of boxes) {
    if (!usable(b)) {
      return {
        ok: false,
        reason: "unreadable_box",
        sightings: boxes.length,
        message: "a sighting carried a box that could not be read; refusing rather than counting it as motionless",
      };
    }
  }
  if (boxes.length < MIN_SIGHTINGS_FOR_JITTER) {
    return {
      ok: false,
      reason: "too_few_sightings",
      sightings: boxes.length,
      message: `${boxes.length} sightings is below the floor of ${MIN_SIGHTINGS_FOR_JITTER}`,
    };
  }

  const list = boxes as Box[];
  const diags = list.map((b) => Math.hypot(b.w, b.h));
  const D = median([...diags].sort((a, b) => a - b));
  const cx = list.map((b) => b.x + b.w / 2);
  const cy = list.map((b) => b.y + b.h / 2);

  const steps: number[] = [];
  for (let i = 1; i < list.length; i++) {
    steps.push(Math.hypot((cx[i] as number) - (cx[i - 1] as number), (cy[i] as number) - (cy[i - 1] as number)) / D);
  }
  const aspects = list.map((b) => b.w / b.h);
  const aspectMedian = median([...aspects].sort((a, b) => a - b));

  return {
    ok: true,
    sightings: list.length,
    stepMedian: median([...steps].sort((a, b) => a - b)),
    stepMax: steps.length === 0 ? 0 : Math.max(...steps),
    spread: Math.hypot(Math.max(...cx) - Math.min(...cx), Math.max(...cy) - Math.min(...cy)) / D,
    sizeSpread: (Math.max(...diags) - Math.min(...diags)) / D,
    aspectSpread: aspectMedian === 0 ? 0 : (Math.max(...aspects) - Math.min(...aspects)) / aspectMedian,
  };
}
