/**
 * Scoring the detector against the answer key: turning what replay.py printed
 * into detections the way the live service would, and saying what the score
 * means. Pure: no I/O, no clock, no child processes. agent/score-clips.mjs
 * runs the detector and hands the lines here.
 *
 * WHY THIS IS CAREFUL. A score that flatters the detector looks exactly like
 * a good score. Every way this file could flatter it is a way the live
 * service would disagree:
 *   - live drops every box under detect.json's minConfidence (0.5) BEFORE
 *     folding; replay.py prints everything the model's own 0.25 floor keeps,
 *     so the floor is applied here or a 0.3 guess counts as a person found;
 *   - a detection's time is the start of the FILE it came from plus its
 *     offset, never the clip's start: clip footage is whole segments, wider
 *     than the clip, so the clip's start would shift every box early;
 *   - the saved clip is the recorder's footage, which is usually the MAIN
 *     stream, while the live detector reads the SUBSTREAM, a smaller and
 *     more compressed picture. That cannot be undone here, so the report says
 *     so every time it is true.
 * And a short answer key must never read as a pass: until exitGate says
 * there is enough, the report states measurements and what is missing, and
 * no bar is called met.
 */

import { checkDetection, type Detection } from "./detection.js";
import {
  GATE_FALSE_PER_HOUR,
  GATE_RECALL,
  type GateVerdict,
  type KindScore,
  type Score,
} from "./clipLibrary.js";

/** A clip's footage file, as agent/clip-library.mjs links it: <epochMs>.mp4. */
export interface ClipFile {
  name: string;
  startMs: number;
}

const FILE_NAME = /^(\d{10,16})\.mp4$/;

/**
 * The files of one clip, oldest first, with their start times read from their
 * names — the only place a linked segment records when it began. Anything
 * else in the directory is listed as ignored rather than guessed at.
 */
export function clipFiles(names: readonly string[]): { files: ClipFile[]; ignored: string[] } {
  const files: ClipFile[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const m = typeof name === "string" ? FILE_NAME.exec(name) : null;
    if (m === null) {
      ignored.push(String(name));
      continue;
    }
    files.push({ name, startMs: Number(m[1]) });
  }
  // Numerically: "999.mp4" before "1000.mp4", which a string sort gets wrong.
  files.sort((a, b) => a.startMs - b.startMs);
  return { files, ignored };
}

/**
 * detect.json's optional `motionGate` field, read the same way agent/score-
 * clips.mjs's runScore reads it (motion-gated inference, protocol item 1).
 */
export interface MotionGateSettings {
  enabled: boolean;
  /** Null means the worker's own default, not "zero". */
  threshold: number | null;
  keepaliveMs: number | null;
}

export type MotionGateCheck =
  | { ok: true; gate: MotionGateSettings }
  | { ok: false; reason: string };

const MOTION_GATE_KEYS = new Set(["enabled", "threshold", "keepaliveMs"]);

/**
 * Validate detect.json's `motionGate`, exactly as detect-service.mjs will
 * before it starts a worker: absent means the gate is off and nothing about
 * the launch changes; present but malformed — enabled not a boolean,
 * threshold or keepaliveMs out of range or the wrong type, or an unknown key
 * — refuses, naming the field, because the live service would not have
 * started either and there is no live behaviour left to match; enabled:false
 * is off, not a refusal.
 */
export function checkMotionGate(raw: unknown): MotionGateCheck {
  if (raw === undefined) return { ok: true, gate: { enabled: false, threshold: null, keepaliveMs: null } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `detect.json motionGate must be an object, got ${JSON.stringify(raw)}` };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!MOTION_GATE_KEYS.has(key)) {
      return { ok: false, reason: `detect.json motionGate has an unknown key "${key}"` };
    }
  }
  if (typeof obj.enabled !== "boolean") {
    return { ok: false, reason: `detect.json motionGate.enabled must be a boolean, got ${JSON.stringify(obj.enabled)}` };
  }
  let threshold: number | null = null;
  if (obj.threshold !== undefined) {
    const t = obj.threshold;
    if (typeof t !== "number" || !Number.isFinite(t) || !(t > 0 && t < 1)) {
      return { ok: false, reason: `detect.json motionGate.threshold must be a number greater than 0 and less than 1, got ${JSON.stringify(t)}` };
    }
    threshold = t;
  }
  let keepaliveMs: number | null = null;
  if (obj.keepaliveMs !== undefined) {
    const k = obj.keepaliveMs;
    if (!Number.isInteger(k) || (k as number) < 1000 || (k as number) > 600_000) {
      return { ok: false, reason: `detect.json motionGate.keepaliveMs must be an integer from 1000 to 600000, got ${JSON.stringify(k)}` };
    }
    keepaliveMs = k as number;
  }
  // enabled:false is off outright: a threshold or keepaliveMs given alongside
  // it is still validated above (a malformed one refuses regardless), but is
  // not part of the settings a run actually used, so it is not carried
  // forward as if it had been — the caller need not remember to ignore it.
  if (!obj.enabled) return { ok: true, gate: { enabled: false, threshold: null, keepaliveMs: null } };
  return { ok: true, gate: { enabled: true, threshold, keepaliveMs } };
}

export interface ReplayRead {
  /** Detections that the live service would have kept, ready to fold. */
  detections: Detection[];
  /** Frames the replay reported. */
  frames: number;
  /** Boxes under the live floor, dropped as live drops them. */
  belowFloor: number;
  /** Lines or boxes that could not be read: counted, never quietly skipped. */
  unreadable: number;
  /** What replay.py itself reported as going wrong. */
  errors: string[];
  /**
   * replay.py's final `{"type":"gate",...}` line (motion-gated inference,
   * protocol item 4): totals for the whole file. Null when the gate was off
   * (no such line is printed) or every "gate" line in the output was
   * malformed — a bad one is unreadable, never a guessed total.
   */
  gate: GateTotals | null;
}

/** The six reasons motion_gate.py can look, in the order it counts them. */
const GATE_REASONS = ["first", "unsure", "clock", "motion", "hold", "keepalive"] as const;
type GateReason = (typeof GATE_REASONS)[number];

/** replay.py's final gate line, once it has been checked. */
export interface GateTotals {
  frames: number;
  looked: number;
  reasons: Partial<Record<GateReason, number>>;
}

/**
 * Validate one `{"type":"gate",...}` object from replay.py's stdout: the
 * worker's own per-minute line (protocol item 3) minus `windowS`, since a
 * whole-file total has no window to name. Valid only if frames and looked are
 * integers >= 0 with looked <= frames, and reasons is an object whose keys
 * are a subset of exactly the six names above, each an integer >= 0, summing
 * to looked. Anything else is invalid — never partly accepted, because a
 * gate total that quietly dropped a bad reason would still look like a real
 * measurement of the load.
 */
function checkGateTotals(p: Record<string, unknown>): GateTotals | null {
  const { frames, looked, reasons } = p;
  if (!Number.isInteger(frames) || (frames as number) < 0) return null;
  if (!Number.isInteger(looked) || (looked as number) < 0) return null;
  if ((looked as number) > (frames as number)) return null;
  if (typeof reasons !== "object" || reasons === null || Array.isArray(reasons)) return null;
  const out: Partial<Record<GateReason, number>> = {};
  let sum = 0;
  for (const [key, value] of Object.entries(reasons as Record<string, unknown>)) {
    if (!(GATE_REASONS as readonly string[]).includes(key)) return null;
    if (!Number.isInteger(value) || (value as number) < 0) return null;
    out[key as GateReason] = value as number;
    sum += value as number;
  }
  if (sum !== looked) return null;
  return { frames: frames as number, looked: looked as number, reasons: out };
}

/**
 * Read replay.py's stdout for ONE file into detections, as live would keep
 * them. `lines` are the raw stdout lines; blank lines are ignored.
 */
export function detectionsFromReplay(input: {
  cameraId: string;
  fileStartMs: number;
  lines: readonly string[];
  minConfidence: number;
}): ReplayRead {
  const out: ReplayRead = { detections: [], frames: 0, belowFloor: 0, unreadable: 0, errors: [], gate: null };
  const { cameraId, fileStartMs, lines, minConfidence } = input ?? ({} as never);
  if (typeof cameraId !== "string" || cameraId === "" || !Number.isFinite(fileStartMs) ||
      !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1 || !Array.isArray(lines)) {
    out.errors.push("detectionsFromReplay needs a cameraId, a file start, a floor from 0 to 1 and a list of lines");
    return out;
  }
  for (const line of lines) {
    if (typeof line !== "string" || line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.unreadable++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      out.unreadable++;
      continue;
    }
    const p = parsed as Record<string, unknown>;
    if (p.type === "error") {
      out.errors.push(typeof p.message === "string" ? p.message : "replay reported an error");
      continue;
    }
    if (p.type === "gate") {
      // With the gate off there is no such line; with it on there is exactly
      // one, at the end. A malformed one is unreadable, not a zero total —
      // reporting "0 looked" for a line that failed to parse would read as a
      // gate that skipped everything, not as a line nobody could trust.
      const totals = checkGateTotals(p);
      if (totals) out.gate = totals;
      else out.unreadable++;
      continue;
    }
    if (typeof p.tSec !== "number" || !Number.isFinite(p.tSec) || p.tSec < 0 || !Array.isArray(p.detections)) {
      out.unreadable++;
      continue;
    }
    out.frames++;
    const atUtc = new Date(fileStartMs + Math.round(p.tSec * 1000)).toISOString();
    for (const d of p.detections) {
      const raw = typeof d === "object" && d !== null ? { ...(d as object), cameraId, atUtc } : null;
      const checked = checkDetection(raw);
      if (!checked.ok) {
        out.unreadable++;
        continue;
      }
      if (checked.detection.confidence < minConfidence) {
        out.belowFloor++;
        continue;
      }
      out.detections.push(checked.detection);
    }
  }
  return out;
}

/** What the run used, so a score can be compared with the next one honestly. */
export interface RunMeta {
  /** Clips in the answer key, and those that could be scored. */
  clips: number;
  clipsScored: number;
  /** Clips that could not be scored, and why. */
  clipsRefused: { clipId: string; reason: string }[];
  /** Frame rate each camera was replayed at, and where that number came from. */
  fps: { cameraId: string; fps: number; source: "live" | "by_hand" }[];
  minConfidence: number;
  model: string;
  /** Per camera: the stream its clips were recorded from. */
  streams: { cameraId: string; recorded: "main" | "sub" | "unknown" }[];
  frames: number;
  belowFloor: number;
  unreadable: number;
  replayErrors: string[];
  /** The motion gate as this run used it (agent/score-clips.mjs, protocol item 1). */
  gate: { enabled: true; threshold: number | null; keepaliveMs: number | null } | { enabled: false };
  /** Summed from every replayed file's final gate line (protocol item 4); both 0 with the gate off. */
  gateFrames: number;
  gateLooked: number;
}

const pct = (x: number | null) => (x === null ? "not measured" : `${(x * 100).toFixed(0)}%`);
// The gate lines carry one more decimal than the summary: 94.6% must never
// print as "95%" beside "BELOW the 95% bar".
const pctExact = (x: number | null) => (x === null ? "not measured" : `${(x * 100).toFixed(1)}%`);
const perEmptyHour = (x: number | null, places = 1) =>
  (x === null ? "not measured: no empty-scene footage" : `${x.toFixed(places)} per hour of empty scene`);
// Under an hour in minutes, so a 75-second clip is not "0.0 h"; above it,
// two places, so 0.96 h of empty scene never rounds up to the 1 h it lacks.
const hrs = (h: number) => (h < 1 ? `${(h * 60).toFixed(1)} min` : `${h.toFixed(2)} h`);

/**
 * One line stating the motion gate as this run used it: off, or on with its
 * threshold and keepalive (as given, or "the worker's default" when the
 * setting was left out) and the share of frames the model actually ran on.
 * Never a percentage of zero frames — that would read as a measurement where
 * there was none.
 */
function gateLine(gate: RunMeta["gate"], gateFrames: number, gateLooked: number): string {
  if (!gate.enabled) return "Motion gate: off, as live runs it.";
  const threshold = gate.threshold === null ? "the worker's default" : String(gate.threshold);
  const keepalive = gate.keepaliveMs === null ? "the worker's default" : `${gate.keepaliveMs / 1000} s`;
  let line = `Motion gate: on (threshold ${threshold}, keepalive ${keepalive}), as live runs it; ` +
    `the model looked at ${gateLooked} of ${gateFrames} frame${gateFrames === 1 ? "" : "s"}`;
  if (gateFrames > 0) line += ` (${((gateLooked / gateFrames) * 100).toFixed(1)}%)`;
  return `${line}.`;
}

function kindLine(label: string, k: KindScore): string {
  return `${label}: ${k.expected} expected, ${k.found} found (${pct(k.recall)}), ${k.missed.length} missed, ` +
    `${k.duplicates} split into extra events, ${k.falseEvents} false, ${k.emptyFalseEvents} of them in empty scenes ` +
    `(${perEmptyHour(k.falsePerEmptyHour)}).`;
}

/**
 * The report, as lines of plain text. It states what was measured, with what
 * settings, and — only when the answer key is big enough — whether D1's bars
 * are met. It never calls a bar met on a short key, and it always names what
 * it could not use.
 */
export function scoreReport(score: Score, gate: GateVerdict, meta: RunMeta): string[] {
  const lines: string[] = [];
  if (meta.clips === 0) {
    lines.push("The answer key is empty: no clips have been saved with Teach the AI on the Review page.");
    lines.push(`Nothing was scored yet. To judge, the gate would ${gate.why.length > 0 ? gate.why.join("; ") : "need clips"}.`);
    return lines;
  }
  lines.push(`Answer key: ${meta.clips} clip${meta.clips === 1 ? "" : "s"}, ${meta.clipsScored} scored, ` +
    `${hrs(score.hoursScored)} of footage, ${hrs(score.emptyHours)} of it empty scene.`);
  const fps = meta.fps.map((f) => `${f.cameraId} at ${f.fps} fps${f.source === "by_hand" ? " (set by hand, not the live rate)" : ""}`);
  lines.push(`Run as live runs it: ${fps.length > 0 ? fps.join(", ") : "no camera"}; confidence floor ${meta.minConfidence.toFixed(2)}; model ${meta.model}.`);
  lines.push(gateLine(meta.gate, meta.gateFrames, meta.gateLooked));
  for (const s of meta.streams) {
    if (s.recorded === "main") {
      lines.push(`  ${s.cameraId}: this footage is the MAIN stream. The live detector reads the substream, a smaller, ` +
        "more compressed picture, so this score may read better than live does.");
    } else if (s.recorded === "unknown") {
      lines.push(`  ${s.cameraId}: which stream this footage came from is not known, so how closely it matches live is not known either.`);
    }
  }

  lines.push(kindLine("People", score.person));
  for (const m of score.person.missed) lines.push(`  missed: ${m.count} in ${m.clipId} (from ${m.fromUtc})`);
  lines.push(kindLine("Vehicles (scored, not gated)", score.vehicle));

  const bar = `AI-PLAN D1: ${(GATE_RECALL * 100).toFixed(0)}% of people found, at most ${GATE_FALSE_PER_HOUR} false person per empty hour`;
  if (!gate.enough) {
    lines.push(`Not enough to judge against ${bar}: ${gate.why.join("; ")}.`);
  } else {
    lines.push(`Against ${bar}:`);
    lines.push(`  people found ${pctExact(gate.recall)}: ${gate.meetsRecall === true ? "meets" : gate.meetsRecall === false ? "BELOW" : "not judged against"} the ${(GATE_RECALL * 100).toFixed(1)}% bar`);
    lines.push(`  false people ${perEmptyHour(gate.falsePerEmptyHour, 2)}: ${gate.meetsFalseRate === true ? "meets" : gate.meetsFalseRate === false ? "ABOVE" : "not judged against"} the limit of ${GATE_FALSE_PER_HOUR}`);
  }

  const couldNot: string[] = [];
  for (const r of meta.clipsRefused) couldNot.push(`${r.clipId}: ${r.reason}`);
  if (meta.unreadable > 0) couldNot.push(`${meta.unreadable} detector line${meta.unreadable === 1 ? "" : "s"} or box${meta.unreadable === 1 ? "" : "es"} could not be read`);
  for (const e of meta.replayErrors) couldNot.push(`replay: ${e}`);
  if (couldNot.length > 0) lines.push(`Could not use: ${couldNot.join("; ")}.`);
  lines.push(`${meta.frames} frames replayed; ${meta.belowFloor} boxes under the floor dropped, as live drops them.`);
  return lines;
}
