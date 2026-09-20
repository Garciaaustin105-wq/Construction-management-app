/**
 * Where to cut a thumbnail out of a recorded frame. Pure: no I/O, no ffmpeg,
 * no clock.
 *
 * WHY: on 2026-09-20 a spray bottle was reported as a person 77 times in 13
 * hours. Working out that it WAS a bottle cost an ffmpeg cut, a copy across
 * the network and an agent looking at the picture. With the crop already on
 * the event's tile it would have been a glance. This module decides the
 * rectangle; agent/event-crop.mjs does the cutting.
 *
 * Everything here is in PIXELS of the recorded frame, because that is what
 * ffmpeg's crop filter takes and because rounding belongs in one place. The
 * detector reports boxes as fractions (contracts/detection.ts), so this is
 * also the single point where that conversion happens.
 */

import type { Box } from "./detection.js";

/**
 * How much context to keep around the subject, as a fraction of the box's own
 * size on each side. A tight cut-out of a person is a texture; the same person
 * with a doorway behind them is recognisable.
 */
export const CROP_PAD = 0.35;

/**
 * No crop narrower or shorter than this, so a distant detection is still
 * something a person can identify rather than a smudge. Below this the crop
 * grows around the subject instead.
 */
export const CROP_MIN_PX = 96;

export interface CropRect {
  ok: true;
  /** All in whole pixels of the recorded frame; ffmpeg cannot crop a fraction. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropRefusal {
  ok: false;
  reason: "bad_box" | "bad_frame";
  message: string;
}

export interface FrameSize {
  width: number;
  height: number;
}

function readableFrame(f: unknown): f is FrameSize {
  if (f === null || typeof f !== "object") return false;
  const { width, height } = f as FrameSize;
  return typeof width === "number" && typeof height === "number"
    && Number.isFinite(width) && Number.isFinite(height)
    && width >= 1 && height >= 1;
}

function readableBox(b: unknown): b is Box {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const box = b as Box;
  for (const v of [box.x, box.y, box.w, box.h]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  // Fractions of the frame, and a box with no extent cannot be cropped to.
  return box.w > 0 && box.h > 0
    && box.x >= 0 && box.y >= 0
    && box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001;
}

/**
 * The rectangle to cut, given a detection's box and the size of the recorded
 * frame.
 *
 * 1. Refuse an unreadable box ("bad_box") or frame ("bad_frame") — a crop from
 *    a guessed rectangle shows the operator the wrong part of the picture,
 *    which is worse than no picture.
 * 2. Convert the box to pixels; grow it by CROP_PAD of its own size on every
 *    side.
 * 3. Grow it further, about its centre, until it is at least CROP_MIN_PX in
 *    each direction — or the whole frame, whichever is smaller.
 * 4. SHIFT it back inside the frame rather than shrinking it. A box at the very
 *    edge (the bottle was at x = 0.0015) must still produce a full thumbnail,
 *    not a sliver. Only when the crop is larger than the frame is it clipped.
 * 5. Round outwards to whole pixels, and never return a rectangle that leaves
 *    the frame.
 *
 * The result always contains every pixel of the original box.
 */
export function planCrop(box: unknown, frame: unknown): CropRect | CropRefusal {
  if (!readableFrame(frame)) {
    return { ok: false, reason: "bad_frame", message: "the frame size could not be read" };
  }
  if (!readableBox(box)) {
    return { ok: false, reason: "bad_box", message: "the detection box could not be read" };
  }
  const fw = Math.floor(frame.width);
  const fh = Math.floor(frame.height);

  const bx = box.x * fw;
  const by = box.y * fh;
  const bw = box.w * fw;
  const bh = box.h * fh;

  // Padded, then floored to the minimum, then capped at the frame.
  let w = Math.min(fw, Math.max(bw * (1 + 2 * CROP_PAD), CROP_MIN_PX));
  let h = Math.min(fh, Math.max(bh * (1 + 2 * CROP_PAD), CROP_MIN_PX));

  // Keep the subject centred, then slide the window back inside the frame so
  // an edge subject keeps a full-size crop.
  let x = bx + bw / 2 - w / 2;
  let y = by + bh / 2 - h / 2;
  x = Math.min(Math.max(0, x), fw - w);
  y = Math.min(Math.max(0, y), fh - h);

  // Whole pixels, rounded outwards, so the box can never fall outside by a
  // rounding error; then clamped once more in case rounding pushed it out.
  const rx = Math.max(0, Math.floor(x));
  const ry = Math.max(0, Math.floor(y));
  const rw = Math.min(fw - rx, Math.ceil(w));
  const rh = Math.min(fh - ry, Math.ceil(h));

  return { ok: true, x: rx, y: ry, w: rw, h: rh };
}
