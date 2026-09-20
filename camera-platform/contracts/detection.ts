/**
 * What the detector reports, and how a stream of frames becomes a few events.
 * AI-PLAN.md stage D0. Pure: no I/O, no clock.
 *
 * The detector sees about five frames a second. A person standing at a counter
 * for ten minutes is 3,000 detections and ONE event. THE FEARED FAILURES:
 * - the opposite merge: two people in different parts of the frame at the same
 *   moment folded into one, so the second is never shown;
 * - a detector glitch (confidence 7, a box off the frame, a plate on a person)
 *   stored as if it were real.
 */

import { parseUtc } from "./time.js";

export type EventKind = "person" | "vehicle" | "plate";
export const EVENT_KINDS: readonly EventKind[] = Object.freeze(["person", "vehicle", "plate"]);

/** A box in the frame, as fractions of its width and height (0..1). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One detection in one frame. */
export interface Detection {
  cameraId: string;
  atUtc: string;
  kind: EventKind;
  /** 0..1. */
  confidence: number;
  box: Box;
  /** Plate kind only: the normalised text. */
  plate?: string;
}

/** Many detections of the same thing, folded. */
export interface DetectionEvent {
  cameraId: string;
  kind: EventKind;
  firstUtc: string;
  lastUtc: string;
  /** How many detections were folded into it. */
  count: number;
  bestConfidence: number;
  /** The box of the most confident detection. */
  bestBox: Box;
  /** The time of the most confident detection: the crop Review shows. */
  bestUtc: string;
  plate?: string;
}

export type Checked = { ok: true; detection: Detection } | { ok: false; reason: string };

/** Detections of the same thing further apart than this start a new event. */
export const MERGE_GAP_MS = 10_000;
/** Boxes overlapping less than this are different things by overlap alone. */
export const MERGE_MIN_IOU = 0.3;
/**
 * The centre fallback's reach, as a fraction of the larger box's diagonal.
 * A person walking toward the camera grows fast between sightings (bench
 * 2026-09-19: 0.29 x 0.72 to 0.43 x 0.99 of the frame in 200 ms), so the
 * overlap falls under MERGE_MIN_IOU while the centre barely moves. Two people
 * a body-width apart have centres well beyond half a diagonal.
 */
export const MERGE_CENTRE_REACH = 0.5;

/**
 * A plate as the reader gives it, normalised: uppercase, with spaces, dashes
 * and dots removed. Returns null unless the result is 2 to 10 characters, all
 * A-Z or 0-9.
 *
 * 1. If `raw` is not a string, return null.
 * 2. s = raw.toUpperCase() with every " ", "-" and "." removed.
 * 3. Return s if it matches /^[A-Z0-9]{2,10}$/, else null.
 */
export function normalisePlate(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const s = raw.toUpperCase().replaceAll(" ", "").replaceAll("-", "").replaceAll(".", "");
  return /^[A-Z0-9]{2,10}$/.test(s) ? s : null;
}

/**
 * Check one raw detection from the detector. Refusals are values.
 *
 * 1. `raw` must be a non-null object (not an array): else reason "not_an_object".
 * 2. cameraId: a non-empty string: else "bad_camera".
 * 3. atUtc: a string that parseUtc accepts (it throws on bad input; catch it):
 *    else "bad_time".
 * 4. kind: one of EVENT_KINDS: else "bad_kind".
 * 5. confidence: a finite number with 0 <= confidence <= 1: else "bad_confidence".
 * 6. box: an object whose x, y, w, h are all finite numbers, with x >= 0,
 *    y >= 0, w > 0, h > 0, x + w <= 1 + 1e-6, y + h <= 1 + 1e-6: else "bad_box".
 * 7. plate: when kind is "plate", normalisePlate(raw.plate) must not be null:
 *    else "bad_plate". When kind is not "plate", raw.plate must be undefined:
 *    else "plate_on_non_plate".
 * 8. Return { ok: true, detection } with a NEW object holding exactly cameraId,
 *    atUtc, kind, confidence, box (a new {x, y, w, h}), and plate (normalised)
 *    only for the plate kind. Never return the caller's objects.
 */
export function checkDetection(raw: unknown): Checked {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not_an_object" };
  }
  const r = raw as Record<string, unknown>;
  const cameraId = r.cameraId;
  if (typeof cameraId !== "string" || cameraId === "") {
    return { ok: false, reason: "bad_camera" };
  }
  const atUtc = r.atUtc as string;
  try {
    parseUtc(atUtc);
  } catch {
    return { ok: false, reason: "bad_time" };
  }
  const kind = r.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: "bad_kind" };
  }
  const confidence = r.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: "bad_confidence" };
  }
  const rawBox = r.box;
  if (typeof rawBox !== "object" || rawBox === null || Array.isArray(rawBox)) {
    return { ok: false, reason: "bad_box" };
  }
  const b = rawBox as Record<string, unknown>;
  const x = b.x;
  const y = b.y;
  const w = b.w;
  const h = b.h;
  if (
    typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number" ||
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) ||
    x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + 1e-6 || y + h > 1 + 1e-6
  ) {
    return { ok: false, reason: "bad_box" };
  }
  const box = { x, y, w, h };
  if (kind === "plate") {
    const plate = normalisePlate(r.plate);
    if (plate === null) {
      return { ok: false, reason: "bad_plate" };
    }
    return { ok: true, detection: { cameraId, atUtc, kind: kind as EventKind, confidence, box, plate } };
  }
  if (r.plate !== undefined) {
    return { ok: false, reason: "plate_on_non_plate" };
  }
  return { ok: true, detection: { cameraId, atUtc, kind: kind as EventKind, confidence, box } };
}

/**
 * Intersection over union of two boxes, 0..1.
 *
 * 1. ix = max(0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x)); iy likewise on y/h.
 * 2. inter = ix * iy; union = a.w * a.h + b.w * b.h - inter.
 * 3. Return union > 0 ? inter / union : 0.
 */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Whether a sighting `next` is the same thing as the last sighting `last`,
 * and how strongly. The one rule both folds use (foldDetections here,
 * advanceFold in detectStream.ts), so the scorer grades what the service
 * stores.
 *
 * 1. If iou(last, next) >= MERGE_MIN_IOU, return that iou.
 * 2. Else let d = distance between the two centres and reach =
 *    MERGE_CENTRE_REACH * max(diagonal(last), diagonal(next)). If d <= reach,
 *    return MERGE_MIN_IOU * (1 - d / reach) * 0.999: above 0, and always
 *    below any overlap match, so overlap wins when both apply.
 * 3. Else return null: different things.
 */
export function matchScore(last: Box, next: Box): number | null {
  const overlap = iou(last, next);
  if (overlap >= MERGE_MIN_IOU) return overlap;
  const dx = (last.x + last.w / 2) - (next.x + next.w / 2);
  const dy = (last.y + last.h / 2) - (next.y + next.h / 2);
  const d = Math.sqrt(dx * dx + dy * dy);
  const reach = MERGE_CENTRE_REACH * Math.max(Math.hypot(last.w, last.h), Math.hypot(next.w, next.h));
  if (reach <= 0 || d > reach) return null;
  return MERGE_MIN_IOU * (1 - d / reach) * 0.999;
}

/**
 * Fold checked detections into events.
 *
 * 1. Copy `detections` and sort the copy by parseUtc(atUtc) ascending; ties
 *    keep input order (Array.prototype.sort is stable). Never mutate the input.
 * 2. Keep a list of open events. For each detection d at time t:
 *    a. Candidates are open events with the same cameraId and kind whose
 *       lastUtc is at most MERGE_GAP_MS before t.
 *    b. For kind "plate": a candidate matches when its plate === d.plate
 *       (the box does not matter: a car moves).
 *       For other kinds: a candidate matches when iou(candidate's LAST box,
 *       d.box) >= MERGE_MIN_IOU. Track each event's last box internally; it is
 *       not part of DetectionEvent.
 *    c. Among matches take the one with the highest match score (plate: 1;
 *       others: the iou), first in open order on a tie.
 *    d. If there is a match: lastUtc = d.atUtc, count += 1, last box = d.box;
 *       if d.confidence > bestConfidence (strictly), set bestConfidence,
 *       bestBox and bestUtc from d.
 *    e. Otherwise open a new event: firstUtc = lastUtc = bestUtc = d.atUtc,
 *       count 1, bestConfidence d.confidence, bestBox d.box, plate only for
 *       the plate kind.
 * 3. Return all events (none are dropped) sorted by firstUtc ascending, ties
 *    in the order they were opened. Each has exactly the DetectionEvent keys
 *    (plate only for plates), with times copied as the original atUtc strings.
 */
export function foldDetections(detections: readonly Detection[]): DetectionEvent[] {
  type Open = { event: DetectionEvent; lastBox: Box; lastMs: number };
  // Each atUtc is parsed once, into a sorted copy; the input is never mutated.
  const timed = detections.map((d) => ({ d, atMs: parseUtc(d.atUtc) }));
  timed.sort((a, b) => a.atMs - b.atMs);
  const open: Open[] = [];
  for (const { d, atMs } of timed) {
    let match: Open | undefined;
    let bestScore = -1;
    for (const candidate of open) {
      const ev = candidate.event;
      if (ev.cameraId !== d.cameraId || ev.kind !== d.kind) {
        continue;
      }
      if (atMs - candidate.lastMs > MERGE_GAP_MS) {
        continue;
      }
      let score: number;
      if (d.kind === "plate") {
        if (ev.plate !== d.plate) {
          continue;
        }
        score = 1;
      } else {
        const s = matchScore(candidate.lastBox, d.box);
        if (s === null) {
          continue;
        }
        score = s;
      }
      if (score > bestScore) {
        bestScore = score;
        match = candidate;
      }
    }
    if (match === undefined) {
      const event: DetectionEvent = {
        cameraId: d.cameraId,
        kind: d.kind,
        firstUtc: d.atUtc,
        lastUtc: d.atUtc,
        count: 1,
        bestConfidence: d.confidence,
        bestBox: { x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h },
        bestUtc: d.atUtc,
      };
      if (d.kind === "plate") {
        event.plate = d.plate;
      }
      open.push({ event, lastBox: d.box, lastMs: atMs });
    } else {
      const ev = match.event;
      ev.lastUtc = d.atUtc;
      ev.count += 1;
      match.lastBox = d.box;
      match.lastMs = atMs;
      if (d.confidence > ev.bestConfidence) {
        ev.bestConfidence = d.confidence;
        ev.bestBox = { x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h };
        ev.bestUtc = d.atUtc;
      }
    }
  }
  // Events were opened in ascending firstUtc order (the input was sorted), ties in open order.
  return open.map((oe) => oe.event);
}
