/**
 * Streaming detection parsing and folding.
 *
 * Parses lines from the AI worker process and folds detections into events
 * as they arrive, matching the batch folding logic exactly so the scorer
 * grades what is stored.
 */

import { parseUtc } from "./time.js";
import { Detection, DetectionEvent, Box, checkDetection, iou, MERGE_GAP_MS, MERGE_MIN_IOU } from "./detection.js";

export const MAX_WORKER_LINE_BYTES = 65536;
export const MAX_DETECTIONS_PER_FRAME = 300;

export type WorkerLine =
  | { kind: "ready"; model: string }
  | { kind: "frame"; atUtc: string; detections: Detection[]; refused: string[] }
  | { kind: "error"; message: string }
  | { kind: "invalid"; reason: string };

/**
 * Parse one line from the worker. Never throws.
 *
 * - If not a string, or line.length > MAX_WORKER_LINE_BYTES -> invalid.
 * - JSON.parse in try/catch -> invalid "not_json".
 * - Must be a plain object (not null, not array) -> else invalid "not_an_object".
 * - Dispatch on `type` field:
 *   - "ready": model must be non-empty string -> { kind: "ready", model }
 *   - "error": message must be string -> { kind: "error", message: message.slice(0, 500) }
 *   - "frame": atUtc must parse; detections must be array, length <= MAX_DETECTIONS_PER_FRAME;
 *     each item validated with checkDetection.
 *   - any other type -> invalid "unknown_type".
 */
export function parseWorkerLine(line: string, cameraId: string): WorkerLine {
  if (typeof line !== "string") {
    return { kind: "invalid", reason: "not_json" };
  }

  if (line.length > MAX_WORKER_LINE_BYTES) {
    return { kind: "invalid", reason: "line_too_long" };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "not_json" };
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { kind: "invalid", reason: "not_an_object" };
  }

  const r = obj as Record<string, unknown>;
  const type = r.type;

  if (type === "ready") {
    const model = r.model;
    if (typeof model !== "string" || model === "") {
      return { kind: "invalid", reason: "bad_model" };
    }
    return { kind: "ready", model };
  }

  if (type === "error") {
    const message = r.message;
    if (typeof message !== "string") {
      return { kind: "invalid", reason: "bad_message" };
    }
    return { kind: "error", message: message.slice(0, 500) };
  }

  if (type === "frame") {
    const atUtc = r.atUtc as string;
    let atMs: number;
    try {
      atMs = parseUtc(atUtc);
    } catch {
      return { kind: "invalid", reason: "bad_time" };
    }

    const detectionsRaw = r.detections;
    if (!Array.isArray(detectionsRaw)) {
      return { kind: "invalid", reason: "bad_detections" };
    }

    if (detectionsRaw.length > MAX_DETECTIONS_PER_FRAME) {
      return { kind: "invalid", reason: "too_many_detections" };
    }

    const detections: Detection[] = [];
    const refused: string[] = [];

    for (const item of detectionsRaw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        refused.push("not_an_object");
        continue;
      }

      // Build a detection with forced cameraId and atUtc from the frame
      const raw = item as Record<string, unknown>;
      const toCheck = {
        cameraId,
        atUtc,
        kind: raw.kind,
        confidence: raw.confidence,
        box: raw.box,
        plate: raw.plate,
      };

      const checked = checkDetection(toCheck);
      if (checked.ok) {
        detections.push(checked.detection);
      } else {
        refused.push(checked.reason);
      }
    }

    return { kind: "frame", atUtc, detections, refused };
  }

  return { kind: "invalid", reason: "unknown_type" };
}

/**
 * An open detection event being built by the fold.
 */
export interface OpenEvent {
  id: string;
  event: DetectionEvent;
  lastBox: Box;
  lastMs: number;
}

/**
 * The state of the streaming fold.
 */
export interface FoldState {
  open: OpenEvent[];
  nextSeq: number;
}

/**
 * An update to an event (opened or changed).
 */
export interface EventUpdate {
  id: string;
  event: DetectionEvent;
}

/**
 * Initialize the fold state.
 */
export function emptyFold(): FoldState {
  return { open: [], nextSeq: 1 };
}

/**
 * Advance the fold with new detections and finish events that have aged out.
 *
 * Never mutates the input state. Returns a new state and the updates and
 * finished events, in exactly the order they were touched or finished.
 * The events produced match foldDetections' output when fed the same input.
 */
export function advanceFold(
  state: FoldState,
  detections: readonly Detection[],
  nowUtc: string
): { state: FoldState; updated: EventUpdate[]; finished: EventUpdate[] } {
  const nowMs = parseUtc(nowUtc);

  // Copy the state to avoid mutating it.
  const newOpen = state.open.map((oe) => ({
    id: oe.id,
    event: { ...oe.event, bestBox: { ...oe.event.bestBox } },
    lastBox: { ...oe.lastBox },
    lastMs: oe.lastMs,
  }));

  let nextSeq = state.nextSeq;
  const updated: EventUpdate[] = [];

  // Sort detections by atUtc (stable sort).
  const timed = detections.map((d) => ({ d, atMs: parseUtc(d.atUtc) }));
  timed.sort((a, b) => a.atMs - b.atMs);

  for (const { d, atMs } of timed) {
    let match: OpenEvent | undefined;
    let bestScore = -1;

    for (const candidate of newOpen) {
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
        score = iou(candidate.lastBox, d.box);
        if (score < MERGE_MIN_IOU) {
          continue;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        match = candidate;
      }
    }

    if (match === undefined) {
      const id = `${d.cameraId}:${atMs}:${nextSeq}`;
      nextSeq += 1;

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

      const oe: OpenEvent = {
        id,
        event,
        lastBox: { ...d.box },
        lastMs: atMs,
      };
      newOpen.push(oe);
      updated.push({ id, event: { ...event, bestBox: { ...event.bestBox } } });
    } else {
      const ev = match.event;
      ev.lastUtc = d.atUtc;
      ev.count += 1;
      match.lastBox = { ...d.box };
      match.lastMs = atMs;

      if (d.confidence > ev.bestConfidence) {
        ev.bestConfidence = d.confidence;
        ev.bestBox = { x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h };
        ev.bestUtc = d.atUtc;
      }

      updated.push({ id: match.id, event: { ...ev, bestBox: { ...ev.bestBox } } });
    }
  }

  // Finish events that have aged out.
  const finished: EventUpdate[] = [];
  const stillOpen: OpenEvent[] = [];

  for (const oe of newOpen) {
    if (nowMs - oe.lastMs > MERGE_GAP_MS) {
      finished.push({ id: oe.id, event: { ...oe.event, bestBox: { ...oe.event.bestBox } } });
    } else {
      stillOpen.push(oe);
    }
  }

  return {
    state: { open: stillOpen, nextSeq },
    updated,
    finished,
  };
}
