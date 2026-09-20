/**
 * Following the same thing from one frame to the next. Pure: no I/O, no clock.
 *
 * WHY, and it is a mistake rather than a requirement: analysing a street on
 * 2026-09-20 I chained each detection to the last box it overlapped. With one
 * object in an empty room that works. With seven parked cars it does not — a
 * "track" walked across the frame and reported a wander of 5.78, which was two
 * different cars stitched together, not an object moving. Every number derived
 * that way described the method rather than the scene.
 *
 * So association is done properly here: per frame, the best available pairing
 * of tracks to detections, each track taking at most one detection and each
 * detection going to at most one track, with hard limits on how far a thing
 * may move and how long it may vanish before it is a different thing.
 *
 * This is offline analysis, not the live path. The detector's own event fold
 * (contracts/detection.ts) answers a different question — "is this the same
 * event" — over ten seconds; this answers "is this the same object" frame by
 * frame, so a measurement can be taken of how it moved.
 */

import type { Box, EventKind } from "./detection.js";

/** Boxes overlapping less than this are not the same thing. */
export const MIN_MATCH_IOU = 0.2;

/**
 * How far a thing's centre may move between frames, in diagonals of its own
 * box. Derived rather than guessed: at the detector's 5 fps, a person walking
 * at 1.5 m/s moves 0.3 m per frame and is about 1.8 m from corner to corner,
 * so 0.17 diagonals; a person running at 5 m/s is about 0.55. One diagonal is
 * therefore generous for anything human while still forbidding the leap across
 * a frame that started all this.
 */
export const MAX_STEP_DIAGONALS = 1;

/** Frames a track may go unmatched before it ends. One second at 5 fps. */
export const MAX_MISSES = 5;

export interface FrameDetections {
  frame: number;
  detections: ReadonlyArray<{ kind: EventKind; confidence: number; box: Box }>;
}

export interface Track {
  kind: EventKind;
  /** Every box that was matched to this thing, in frame order. */
  boxes: Box[];
  confidences: number[];
  frames: number[];
  firstFrame: number;
  lastFrame: number;
  /** How many frames it was not seen in, between first and last. */
  misses: number;
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function centreStep(a: Box, b: Box): number {
  const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
  const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
  const diag = Math.max(Math.hypot(a.w, a.h), Math.hypot(b.w, b.h));
  return diag <= 0 ? Infinity : Math.hypot(dx, dy) / diag;
}

interface Live extends Track {
  /** The frame this track was last matched in. */
  seenAt: number;
  /** Order of creation, so ties break the same way every run. */
  born: number;
}

function usableBox(b: unknown): b is Box {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const box = b as Box;
  for (const v of [box.x, box.y, box.w, box.h]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return box.w > 0 && box.h > 0;
}

/**
 * Turn per-frame detections into tracks.
 *
 * For each frame, in frame order:
 * 1. Score every (live track, detection) pair of the SAME kind by overlap.
 *    A pair is eligible only when iou >= MIN_MATCH_IOU and the centre moved no
 *    more than MAX_STEP_DIAGONALS — so nothing may teleport, however lonely.
 * 2. Take the eligible pairs in descending score, skipping any whose track or
 *    detection has already been taken. This is a greedy assignment over the
 *    whole frame rather than first-match per track: the pairing a caller would
 *    pick by eye. Ties break by the track's birth order, so the result does
 *    not depend on the order the detector happened to list boxes in.
 * 3. Every unmatched detection starts a new track.
 * 4. A track unmatched for more than MAX_MISSES frames ends. It cannot be
 *    resumed: a thing that comes back later is a new thing, because the
 *    alternative is a track that spans a gap it knows nothing about.
 *
 * Throws on input that is not an array of {frame, detections[]} — a tracker
 * that quietly skips malformed frames reports a shorter, jumpier world and
 * gives no clue why.
 */
export function trackBoxes(input: unknown): Track[] {
  if (!Array.isArray(input)) throw new TypeError("trackBoxes needs an array of frames");
  const done: Track[] = [];
  let live: Live[] = [];
  let born = 0;

  for (const f of input) {
    if (f === null || typeof f !== "object") throw new TypeError("a frame must be an object");
    const frame = (f as FrameDetections).frame;
    const detections = (f as FrameDetections).detections;
    if (typeof frame !== "number" || !Number.isFinite(frame)) throw new TypeError("a frame needs a numeric frame");
    if (!Array.isArray(detections)) throw new TypeError("a frame needs a detections array");

    type Pair = { t: number; d: number; score: number; bornAt: number };
    const pairs: Pair[] = [];
    detections.forEach((d, di) => {
      if (d === null || typeof d !== "object" || !usableBox(d.box)) throw new TypeError("a detection needs a readable box");
      live.forEach((t, ti) => {
        if (t.kind !== d.kind) return;
        const last = t.boxes[t.boxes.length - 1] as Box;
        const overlap = iou(last, d.box);
        if (overlap < MIN_MATCH_IOU) return;
        if (centreStep(last, d.box) > MAX_STEP_DIAGONALS) return;
        pairs.push({ t: ti, d: di, score: overlap, bornAt: t.born });
      });
    });
    // Best overlap first; ties by the older track, so the answer is the same
    // whatever order the detector listed things in.
    pairs.sort((a, b) => (b.score - a.score) || (a.bornAt - b.bornAt) || (a.d - b.d));

    const takenT = new Set<number>();
    const takenD = new Set<number>();
    for (const p of pairs) {
      if (takenT.has(p.t) || takenD.has(p.d)) continue;
      takenT.add(p.t);
      takenD.add(p.d);
      const t = live[p.t] as Live;
      const d = detections[p.d]!;
      t.boxes.push(d.box);
      t.confidences.push(d.confidence);
      t.frames.push(frame);
      t.lastFrame = frame;
      t.seenAt = frame;
    }

    detections.forEach((d, di) => {
      if (takenD.has(di)) return;
      live.push({
        kind: d.kind,
        boxes: [d.box],
        confidences: [d.confidence],
        frames: [frame],
        firstFrame: frame,
        lastFrame: frame,
        misses: 0,
        seenAt: frame,
        born: born++,
      });
    });

    const keep: Live[] = [];
    for (const t of live) {
      if (frame - t.seenAt > MAX_MISSES) done.push(finish(t));
      else keep.push(t);
    }
    live = keep;
  }

  for (const t of live) done.push(finish(t));
  return done;
}

function finish(t: Live): Track {
  const span = t.lastFrame - t.firstFrame + 1;
  return {
    kind: t.kind,
    boxes: t.boxes,
    confidences: t.confidences,
    frames: t.frames,
    firstFrame: t.firstFrame,
    lastFrame: t.lastFrame,
    misses: Math.max(0, span - t.boxes.length),
  };
}
