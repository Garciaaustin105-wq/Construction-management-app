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
  const out: ReplayRead = { detections: [], frames: 0, belowFloor: 0, unreadable: 0, errors: [] };
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
