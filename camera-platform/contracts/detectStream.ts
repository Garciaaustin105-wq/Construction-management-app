/**
 * Streaming detection parsing and folding.
 *
 * Parses lines from the AI worker process and folds detections into events
 * as they arrive, matching the batch folding logic exactly so the scorer
 * grades what is stored.
 */

import { parseUtc } from "./time.js";
import { Detection, DetectionEvent, Box, checkDetection, matchScore, travelFrom, MERGE_GAP_MS } from "./detection.js";

export const MAX_WORKER_LINE_BYTES = 65536;
export const MAX_DETECTIONS_PER_FRAME = 300;

// The names motion_gate.py's decide() can hand back as a look's reason
// (LOOK_REASONS there). Duplicated rather than imported, same as MERGE_GAP_MS
// is duplicated into that Python file: the two sides cannot drift silently,
// because a name only one side knows about fails the "subset of exactly
// these six" check below, out loud, as bad_gate.
export const GATE_REASONS: readonly string[] = Object.freeze(["first", "unsure", "clock", "motion", "hold", "keepalive"]);

// yolox_worker.py's timeSource: "arrival" when atUtc came from the wall
// clock the frame's packet ARRIVED at (ffmpeg's showinfo, paired by frame
// index - see detector/yolox_worker.py's module docstring), "read" when it
// fell back to the wall clock the frame was READ from the pipe (today's
// only behaviour). Absent means an older worker that has never heard of
// either - still accepted, same as a line with no species.
export type FrameTimeSource = "arrival" | "read";

export type WorkerLine =
  | { kind: "ready"; model: string }
  | { kind: "frame"; atUtc: string; timeSource?: FrameTimeSource; detections: Detection[]; refused: string[] }
  | { kind: "error"; message: string }
  | { kind: "gate"; windowS: number; frames: number; looked: number; reasons: Record<string, number> }
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
 *     each item validated with checkDetection, species carried through - a
 *     worker that starts reporting a species not of its kind, or not in the
 *     vocabulary, is refused ("bad_species") rather than silently widening
 *     what gets stored. timeSource, if present, must be exactly "arrival" or
 *     "read" -> else invalid "bad_time_source"; absent is fine (an older
 *     worker that has never heard of it) and carried through as undefined,
 *     never defaulted to either value - a default here would claim to know
 *     which clock atUtc came from when the line never said.
 *   - "gate": a motion gate's once-a-minute summary of what it looked at.
 *     Valid only as a whole: windowS a positive number; frames and looked
 *     integers >= 0 with looked <= frames; reasons an object whose keys are a
 *     subset of GATE_REASONS (unknown keys refused, not dropped), each value
 *     an integer >= 0, summing to exactly looked. Anything else -> invalid
 *     "bad_gate", never a partly-trusted reading.
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

    // Optional: absent (an older worker) is fine and stays undefined; present
    // must be exactly one of the two names yolox_worker.py can send. Refused
    // whole rather than dropped, the same discipline as bad_species and
    // bad_gate - a worker that starts sending a third value here must not
    // slide silently into "read" or "arrival" by accident.
    const timeSourceRaw = r.timeSource;
    let timeSource: FrameTimeSource | undefined;
    if (timeSourceRaw !== undefined) {
      if (timeSourceRaw !== "arrival" && timeSourceRaw !== "read") {
        return { kind: "invalid", reason: "bad_time_source" };
      }
      timeSource = timeSourceRaw;
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

      // Build a detection with forced cameraId and atUtc from the frame.
      // species rides through to checkDetection unchanged: it is the only
      // field a worker can add that widens what gets stored, so it gets the
      // same discipline as cameraId and atUtc, not a free pass.
      const raw = item as Record<string, unknown>;
      const toCheck = {
        cameraId,
        atUtc,
        kind: raw.kind,
        confidence: raw.confidence,
        box: raw.box,
        plate: raw.plate,
        species: raw.species,
      };

      const checked = checkDetection(toCheck);
      if (checked.ok) {
        detections.push(checked.detection);
      } else {
        refused.push(checked.reason);
      }
    }

    return timeSource === undefined
      ? { kind: "frame", atUtc, detections, refused }
      : { kind: "frame", atUtc, timeSource, detections, refused };
  }

  if (type === "gate") {
    const windowSRaw = r.windowS;
    if (!Number.isFinite(windowSRaw) || (windowSRaw as number) <= 0) {
      return { kind: "invalid", reason: "bad_gate" };
    }
    const windowS = windowSRaw as number;

    const framesRaw = r.frames;
    if (!Number.isInteger(framesRaw) || (framesRaw as number) < 0) {
      return { kind: "invalid", reason: "bad_gate" };
    }
    const frames = framesRaw as number;

    const lookedRaw = r.looked;
    if (!Number.isInteger(lookedRaw) || (lookedRaw as number) < 0 || (lookedRaw as number) > frames) {
      return { kind: "invalid", reason: "bad_gate" };
    }
    const looked = lookedRaw as number;

    const reasonsRaw = r.reasons;
    if (typeof reasonsRaw !== "object" || reasonsRaw === null || Array.isArray(reasonsRaw)) {
      return { kind: "invalid", reason: "bad_gate" };
    }

    // Every key must be one of the six known reasons (an unknown key is
    // refused whole, not dropped - the same discipline as bad_species: a
    // reason only one side knows about must not slide through half-read),
    // every value a non-negative integer, and they must sum to exactly
    // `looked` - the reasons ARE the accounting for every look, not a sample.
    const reasons: Record<string, number> = {};
    let sum = 0;
    for (const [key, value] of Object.entries(reasonsRaw as Record<string, unknown>)) {
      if (!GATE_REASONS.includes(key)) {
        return { kind: "invalid", reason: "bad_gate" };
      }
      if (!Number.isInteger(value) || (value as number) < 0) {
        return { kind: "invalid", reason: "bad_gate" };
      }
      reasons[key] = value as number;
      sum += value as number;
    }
    if (sum !== looked) {
      return { kind: "invalid", reason: "bad_gate" };
    }

    return { kind: "gate", windowS, frames, looked, reasons };
  }

  return { kind: "invalid", reason: "unknown_type" };
}

/**
 * An open detection event being built by the fold.
 */
export interface OpenEvent {
  id: string;
  event: DetectionEvent;
  /**
   * The box of the sighting that opened the event: what event.travel is
   * measured from. Carried here because the streaming fold never sees the
   * event's earlier sightings again, and the batch fold keeps the same thing,
   * so the two measure travel from the same place.
   */
  firstBox: Box;
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
 * The events produced match foldDetections' output when fed the same input,
 * species included: it follows the most confident sighting there too, so the
 * word and the crop (cut at bestUtc) always describe the same frame. Travel
 * included too, to the bit: both folds measure it with the same travelFrom
 * from the same first box, and keep the largest.
 *
 * `assigned` is the id of the event each input detection joined or opened,
 * one per detection, in INPUT order (not the sorted order the fold walks).
 * `updated` cannot answer that on its own: two sightings in one batch can
 * touch the same event, and the batch is sorted before it is folded. The gate
 * check needs it to say which event a sighting belongs to exactly, rather
 * than guessing from time overlap. The live service ignores it.
 */
export function advanceFold(
  state: FoldState,
  detections: readonly Detection[],
  nowUtc: string
): { state: FoldState; updated: EventUpdate[]; finished: EventUpdate[]; assigned: string[] } {
  const nowMs = parseUtc(nowUtc);

  // Copy the state to avoid mutating it.
  const newOpen = state.open.map((oe) => ({
    id: oe.id,
    event: { ...oe.event, bestBox: { ...oe.event.bestBox } },
    firstBox: { ...oe.firstBox },
    lastBox: { ...oe.lastBox },
    lastMs: oe.lastMs,
  }));

  let nextSeq = state.nextSeq;
  const updated: EventUpdate[] = [];

  // Sort detections by atUtc (stable sort). Each keeps its input position, so
  // `assigned` can be written back in the order the caller gave them.
  const timed = detections.map((d, index) => ({ d, atMs: parseUtc(d.atUtc), index }));
  timed.sort((a, b) => a.atMs - b.atMs);
  const assigned: string[] = new Array<string>(detections.length);

  for (const { d, atMs, index } of timed) {
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
        // 0, the same call foldDetections makes: the first sighting is where
        // the thing started, and the call refuses a box with no diagonal.
        travel: travelFrom(d.box, d.box),
      };
      if (d.kind === "plate") {
        event.plate = d.plate;
      }
      if (d.species !== undefined) {
        event.species = d.species;
      }

      const oe: OpenEvent = {
        id,
        event,
        firstBox: { ...d.box },
        lastBox: { ...d.box },
        lastMs: atMs,
      };
      newOpen.push(oe);
      updated.push({ id, event: { ...event, bestBox: { ...event.bestBox } } });
      assigned[index] = id;
    } else {
      const ev = match.event;
      ev.lastUtc = d.atUtc;
      ev.count += 1;
      match.lastBox = { ...d.box };
      match.lastMs = atMs;
      // The farthest it has been, not where it is now, exactly as
      // foldDetections keeps it: a thing that walked in and back out still
      // walked.
      const travel = travelFrom(match.firstBox, d.box);
      if (travel > ev.travel) {
        ev.travel = travel;
      }

      if (d.confidence > ev.bestConfidence) {
        ev.bestConfidence = d.confidence;
        ev.bestBox = { x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h };
        ev.bestUtc = d.atUtc;
        // The species moves with the box and the moment, so the word and the
        // crop beside it always describe the same frame.
        if (d.species === undefined) {
          delete ev.species;
        } else {
          ev.species = d.species;
        }
      }

      updated.push({ id: match.id, event: { ...ev, bestBox: { ...ev.bestBox } } });
      assigned[index] = match.id;
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
    assigned,
  };
}
