/**
 * The thumbnail for one event: the WHOLE frame, with the detection marked on
 * it. Pure: no I/O, no ffmpeg, no clock.
 *
 * This replaced a cropping contract on 2026-09-20, the same afternoon it was
 * written, because the first real thumbnail settled the question. A crop of a
 * person at 35% of the thumbnail's area still read as "a car in a driveway" to
 * someone seeing it cold: strong scene context, no subject context. Austin's
 * call was the whole view — "needs to be full view if it can" — and he is
 * right for a reason the crop could not fix. An operator scanning a day's
 * events needs to know WHERE something happened as much as what it was, and a
 * tight crop throws the where away. A box drawn on the whole frame keeps both.
 *
 * So this module no longer chooses what to cut. It decides where to draw.
 */

import type { Box } from "./detection.js";

/**
 * How wide the stored thumbnail is. Wide enough that a person a tenth of the
 * frame across is still tens of pixels — a 240px thumbnail made them 39 and
 * that was the complaint — and small enough that a busy day's worth is cheap
 * to cache and to send.
 */
export const THUMB_WIDTH = 480;

export interface MarkRect {
  ok: true;
  /** Whole pixels of the recorded frame; ffmpeg's drawbox takes no fractions. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Line thickness in pixels of the SOURCE frame, so the mark survives being
   * scaled down to THUMB_WIDTH instead of thinning to nothing. A 2-pixel line
   * on a 2560-wide frame is a quarter of a pixel once shrunk, which is to say
   * invisible.
   */
  thickness: number;
}

export interface MarkRefusal {
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
  return box.w > 0 && box.h > 0
    && box.x >= 0 && box.y >= 0
    && box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001;
}

/**
 * Where to draw the mark on the full frame.
 *
 * 1. Refuse an unreadable box ("bad_box") or frame ("bad_frame"). A mark drawn
 *    from a guessed rectangle points the operator at the wrong part of the
 *    picture, which is worse than an unmarked picture.
 * 2. Convert the box to whole pixels of the frame, rounding outwards so the
 *    mark never sits inside the thing it is marking.
 * 3. Clamp to the frame. A box touching the edge draws along the edge.
 * 4. Thickness scales with the frame so the line survives the shrink to
 *    THUMB_WIDTH: frame width / THUMB_WIDTH, rounded up, at least 2 — about
 *    two pixels once scaled, whatever the camera's resolution.
 */
export function markRect(box: unknown, frame: unknown): MarkRect | MarkRefusal {
  if (!readableFrame(frame)) {
    return { ok: false, reason: "bad_frame", message: "the frame size could not be read" };
  }
  if (!readableBox(box)) {
    return { ok: false, reason: "bad_box", message: "the detection box could not be read" };
  }
  const fw = Math.floor(frame.width);
  const fh = Math.floor(frame.height);

  const x = Math.max(0, Math.floor(box.x * fw));
  const y = Math.max(0, Math.floor(box.y * fh));
  const w = Math.min(fw - x, Math.max(1, Math.ceil(box.w * fw)));
  const h = Math.min(fh - y, Math.max(1, Math.ceil(box.h * fh)));

  return { ok: true, x, y, w, h, thickness: Math.max(2, Math.ceil(fw / THUMB_WIDTH) * 2) };
}
