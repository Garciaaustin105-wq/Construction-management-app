/**
 * contracts/clipLibrary.ts -- the answer key every detector stage is scored
 * against (AI-PLAN D0), and the gate that decides when scoring may stop (D1).
 *
 * A wrong answer key does not fail loudly: it makes a bad detector look good.
 * So this file is built around refusals:
 *   - checkLibrary refuses a key that could be wrong, and says why;
 *   - scoreLibrary refuses to flatter a detector;
 *   - exitGate refuses to state a verdict on a sample too small to support it.
 *
 * Pure functions only: no I/O, no clock, no dependencies.
 */

import type { DetectionEvent } from "./detection.js";

/**
 * The closed vocabulary of scene tags. Closed on purpose: an unknown tag is
 * refused, not dropped, because a silently dropped tag would let a clip pass
 * as something it is not.
 */
export const SCENE_TAGS = Object.freeze([
  "empty",
  "person",
  "vehicle",
  "shadows",
  "headlights",
  "rain",
  "animal",
  "night",
] as const);

/** One scene tag; derived from SCENE_TAGS so the type cannot drift from the vocabulary. */
export type SceneTag = (typeof SCENE_TAGS)[number];

/**
 * Longest clip the key accepts. Longer footage must be split: the key is
 * checked by humans, and an hour-long answer stops being checkable.
 */
export const MAX_CLIP_MS = 3_600_000;

/**
 * Fewer expected people than this and a recall percentage is noise, so the
 * gate refuses to state one instead of praising 3 out of 3.
 */
export const MIN_GATE_PERSONS = 20;

/**
 * Less empty-scene footage than this and a false-per-hour rate is noise, so
 * the gate refuses to state one instead of calling an empty sample clean.
 */
export const MIN_GATE_EMPTY_HOURS = 1;

/**
 * A detection starting this close to an expected window still counts as
 * inside it: the key is written by hand, to the second.
 */
export const DEFAULT_TOLERANCE_MS = 2000;

/** D1's bars (AI-PLAN): at least this share of expected people found... */
export const GATE_RECALL = 0.95;
/** ...and at most this many false people per hour of empty-scene footage.
 *  Exported so a report states the bar the gate applies, not a copy of it. */
export const GATE_FALSE_PER_HOUR = 1;

/** What the key promises about a clip: `count` of a kind within [fromUtc, toUtc]. */
export interface ExpectedEvent {
  kind: "person" | "vehicle";
  fromUtc: string;
  toUtc: string;
  count: number;
}

/** One reviewed stretch of footage on one camera: its scenes and its expected events. */
export interface Clip {
  id: string;
  cameraId: string;
  startUtc: string;
  endUtc: string;
  scenes: SceneTag[];
  expected: ExpectedEvent[];
  note?: string;
}

/**
 * The whole answer key. Clips on one camera must not overlap in time, or one
 * detection would be scored twice.
 */
export interface ClipLibrary {
  version: 1;
  clips: Clip[];
}

/** Either a fresh, trusted copy of the library, or every reason it was refused. */
export type CheckResult = { ok: true; library: ClipLibrary } | { ok: false; errors: string[] };

/** How one kind (person or vehicle) scored against the key. */
export interface KindScore {
  expected: number;
  found: number;
  duplicates: number;
  falseEvents: number;
  /** False events inside clips tagged "empty": the only footage where every
   *  detection of this kind is false by definition. */
  emptyFalseEvents: number;
  missed: { clipId: string; fromUtc: string; count: number }[];
  recall: number | null;
  /** False events over ALL hours scored. Informational: busy clips add hours
   *  in which, with whole-clip windows, no false event can even occur. */
  falsePerHour: number | null;
  /** False events in empty-scene clips over empty-scene hours: the rate
   *  AI-PLAN D1's bar is written against, and the one the gate judges. */
  falsePerEmptyHour: number | null;
}

/**
 * The score of a whole library. A null rate means "not measurable", never 0:
 * a null must not be readable as a pass.
 */
export interface Score {
  hoursScored: number;
  emptyHours: number;
  person: KindScore;
  vehicle: KindScore;
}

/**
 * The verdict against the AI-PLAN D1 bars: a detector passes only if it finds
 * at least 95% of people and raises at most 1 false person per hour.
 */
export interface GateVerdict {
  enough: boolean;
  why: string[];
  recall: number | null;
  /** False people per hour of EMPTY-SCENE footage: what the bar is about. */
  falsePerEmptyHour: number | null;
  meetsRecall: boolean | null;
  meetsFalseRate: boolean | null;
}

/** Clip ids become file names and report keys: lowercase letters, digits, hyphens. */
const CLIP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The unit hours are measured in; a one-hour clip adds exactly 1 to hoursScored. */
const MS_PER_HOUR = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** UTC time in epoch ms, or null when the value is not a string Date.parse understands. */
function parseUtcMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A short, safe rendering of an untrusted value for an error message. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * Validate untrusted data as a clip library. Never throws: junk comes back as
 * { ok: false } with every reason it was refused, because a key that is wrong
 * in three ways should say so in one pass. On success the library is a fresh
 * copy, so nothing can edit the answer key through the validated handle.
 */
export function checkLibrary(raw: unknown): CheckResult {
  try {
    return validateLibrary(raw);
  } catch (err) {
    // The checker must refuse, never crash: a crashed checker looks like a
    // missing answer key, and someone will be tempted to skip the check.
    const message = err instanceof Error ? err.message : describe(err);
    return { ok: false, errors: [`clip library could not be checked: ${message}`] };
  }
}

function validateLibrary(raw: unknown): CheckResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: [`clip library must be an object, got ${describe(raw)}`] };
  }

  const errors: string[] = [];
  if (raw.version !== 1) {
    errors.push(`clip library version must be 1, got ${describe(raw.version)}`);
  }
  if (!Array.isArray(raw.clips)) {
    errors.push(`clip library clips must be an array, got ${describe(raw.clips)}`);
  }
  if (errors.length > 0) {
    return { ok: false, errors: errors };
  }

  const rawClips = raw.clips as unknown[];
  const clips: Clip[] = [];
  const seenIds: string[] = [];
  const ranges: { clipId: string; cameraId: string; startMs: number; endMs: number }[] = [];

  for (let index = 0; index < rawClips.length; index++) {
    const rawClip = rawClips[index];
    const where = `clip ${index}`;
    if (!isRecord(rawClip)) {
      errors.push(`${where}: clip must be an object, got ${describe(rawClip)}`);
      continue;
    }

    // The id is checked hard: it names the clip in reports and on disk.
    const id = rawClip.id;
    if (typeof id !== "string" || !CLIP_ID_PATTERN.test(id)) {
      errors.push(`${where}: clip id ${describe(id)} must match /^[a-z0-9][a-z0-9-]{0,63}$/`);
    } else if (seenIds.indexOf(id) !== -1) {
      errors.push(`${where}: duplicate clip id "${id}" -- scores are reported by clip id, so two clips must not share one`);
    } else {
      seenIds.push(id);
    }

    const cameraId = rawClip.cameraId;
    if (typeof cameraId !== "string" || cameraId.length === 0) {
      errors.push(`${where}: cameraId must be a non-empty string, got ${describe(cameraId)}`);
    }

    const startMs = parseUtcMs(rawClip.startUtc);
    const endMs = parseUtcMs(rawClip.endUtc);
    if (startMs === null) {
      errors.push(`${where}: startUtc is not a parseable UTC time, got ${describe(rawClip.startUtc)}`);
    }
    if (endMs === null) {
      errors.push(`${where}: endUtc is not a parseable UTC time, got ${describe(rawClip.endUtc)}`);
    }
    if (startMs !== null && endMs !== null) {
      if (endMs <= startMs) {
        errors.push(`${where}: endUtc must come after startUtc (end <= start)`);
      } else if (endMs - startMs > MAX_CLIP_MS) {
        errors.push(`${where}: clip is too long (${endMs - startMs} ms exceeds MAX_CLIP_MS); split the footage`);
      }
      if (typeof cameraId === "string" && cameraId.length > 0) {
        ranges.push({
          clipId: typeof id === "string" && CLIP_ID_PATTERN.test(id) ? id : where,
          cameraId: cameraId,
          startMs: startMs,
          endMs: endMs,
        });
      }
    }

    const scenes: SceneTag[] = [];
    if (!Array.isArray(rawClip.scenes) || rawClip.scenes.length === 0) {
      errors.push(`${where}: scenes must be a non-empty array of scene tags, got ${describe(rawClip.scenes)}`);
    } else {
      for (const tag of rawClip.scenes) {
        if (typeof tag !== "string" || (SCENE_TAGS as readonly string[]).indexOf(tag) === -1) {
          errors.push(`${where}: unknown scene tag ${describe(tag)} (known tags: ${SCENE_TAGS.join(", ")})`);
        } else {
          scenes.push(tag as SceneTag);
        }
      }
    }

    const expected: ExpectedEvent[] = [];
    const expectedCount = Array.isArray(rawClip.expected) ? rawClip.expected.length : 0;
    if (!Array.isArray(rawClip.expected)) {
      errors.push(`${where}: expected must be an array, got ${describe(rawClip.expected)}`);
    } else {
      for (let j = 0; j < rawClip.expected.length; j++) {
        const rawEvent = rawClip.expected[j];
        const evWhere = `${where} expected[${j}]`;
        if (!isRecord(rawEvent)) {
          errors.push(`${evWhere}: expected event must be an object, got ${describe(rawEvent)}`);
          continue;
        }
        const kind = rawEvent.kind;
        if (kind !== "person" && kind !== "vehicle") {
          errors.push(`${evWhere}: kind must be "person" or "vehicle", got ${describe(kind)}`);
        }
        const count = rawEvent.count;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
          errors.push(`${evWhere}: count must be an integer >= 1, got ${describe(count)}`);
        }
        const fromMs = parseUtcMs(rawEvent.fromUtc);
        const toMs = parseUtcMs(rawEvent.toUtc);
        if (fromMs === null) {
          errors.push(`${evWhere}: fromUtc is not a parseable UTC time, got ${describe(rawEvent.fromUtc)}`);
        }
        if (toMs === null) {
          errors.push(`${evWhere}: toUtc is not a parseable UTC time, got ${describe(rawEvent.toUtc)}`);
        }
        if (fromMs !== null && toMs !== null && toMs < fromMs) {
          errors.push(`${evWhere}: window is outside the clip (toUtc is before fromUtc)`);
        }
        if (
          startMs !== null && endMs !== null && fromMs !== null && toMs !== null &&
          (fromMs < startMs || toMs > endMs)
        ) {
          errors.push(`${evWhere}: window is outside the clip [startUtc, endUtc]`);
        }
        if (
          (kind === "person" || kind === "vehicle") &&
          typeof count === "number" && Number.isInteger(count) && count >= 1 &&
          fromMs !== null && toMs !== null && startMs !== null && endMs !== null &&
          toMs >= fromMs && fromMs >= startMs && toMs <= endMs
        ) {
          expected.push({
            kind: kind,
            fromUtc: typeof rawEvent.fromUtc === "string" ? rawEvent.fromUtc : "",
            toUtc: typeof rawEvent.toUtc === "string" ? rawEvent.toUtc : "",
            count: count,
          });
        }
      }
    }

    // The key must refuse to be wrong in either direction: an "empty" clip
    // that expects someone would score every correct detection in it as
    // false, and a clip that expects nobody without saying "empty" turns a
    // forgotten answer into "nobody was there".
    if (scenes.indexOf("empty") !== -1 && expectedCount > 0) {
      errors.push(`${where}: scenes include "empty" but ${expectedCount} expected event(s) are listed -- an empty clip must expect nobody`);
    }
    if (scenes.indexOf("empty") === -1 && expectedCount === 0) {
      errors.push(`${where}: expected is empty but scenes do not include "empty" -- a clip that expects nobody must say it is empty`);
    }

    const clipCopy: Clip = {
      id: typeof id === "string" ? id : "",
      cameraId: typeof cameraId === "string" ? cameraId : "",
      startUtc: typeof rawClip.startUtc === "string" ? rawClip.startUtc : "",
      endUtc: typeof rawClip.endUtc === "string" ? rawClip.endUtc : "",
      scenes: scenes,
      expected: expected,
    };
    if (typeof rawClip.note === "string") {
      clipCopy.note = rawClip.note;
    }
    clips.push(clipCopy);
  }

  // Two clips on one camera may not share time: overlapping [start, end)
  // ranges would let one detection count twice. Touching ranges are fine.
  for (let i = 0; i < ranges.length; i++) {
    for (let k = i + 1; k < ranges.length; k++) {
      const a = ranges[i]!;
      const b = ranges[k]!;
      if (a.cameraId === b.cameraId && a.startMs < b.endMs && b.startMs < a.endMs) {
        errors.push(`clips ${a.clipId} and ${b.clipId} overlap on camera ${a.cameraId} -- one detection would count twice`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors };
  }
  return { ok: true, library: { version: 1, clips: clips } };
}

/** An event with its times parsed once, so sorting and overlap tests do not re-parse. */
interface TimedEvent {
  firstMs: number;
  lastMs: number;
}

/** An expected event widened by the tolerance on both sides. */
interface ExpectedWindow {
  fromUtc: string;
  count: number;
  startMs: number;
  endMs: number;
}

function newKindScore(): KindScore {
  return {
    expected: 0, found: 0, duplicates: 0, falseEvents: 0, emptyFalseEvents: 0, missed: [],
    recall: null, falsePerHour: null, falsePerEmptyHour: null,
  };
}

/**
 * Score detected events against the key, per clip and per kind. The score must
 * not flatter: one detection is claimed by at most one expected event (one
 * event is never two people), an unclaimed detection inside an expected window
 * is a duplicate (a split track), not a false person, and events that match no
 * clip are ignored entirely -- footage the key does not describe can neither
 * help nor hurt. Plate events are scored elsewhere and never match here.
 * Does not mutate its inputs.
 */
export function scoreLibrary(
  library: ClipLibrary,
  events: readonly DetectionEvent[],
  opts?: { toleranceMs?: number },
): Score {
  const toleranceMs = opts?.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const person = newKindScore();
  const vehicle = newKindScore();
  let hoursScored = 0;
  let emptyHours = 0;

  for (const clip of library.clips) {
    const startMs = Date.parse(clip.startUtc);
    const endMs = Date.parse(clip.endUtc);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      // checkLibrary refuses such clips; refusing to score them keeps a
      // broken key from producing a confident-looking number.
      continue;
    }
    const hours = (endMs - startMs) / MS_PER_HOUR;
    hoursScored += hours;
    if (clip.scenes.indexOf("empty") !== -1) {
      emptyHours += hours;
    }
    scoreOneClip(clip, startMs, endMs, events, toleranceMs, person, vehicle, clip.scenes.indexOf("empty") !== -1);
  }

  // Null means "not measurable", never 0: with nothing expected, recall says
  // nothing; with no footage, a false rate says nothing.
  person.recall = person.expected === 0 ? null : person.found / person.expected;
  person.falsePerHour = hoursScored === 0 ? null : person.falseEvents / hoursScored;
  // The gate's rate. Dividing by ALL hours let walk-by clips dilute it: two
  // false people in one empty hour beside five hours of walk-bys read 0.33 an
  // hour and passed a bar of 1, when the empty-scene rate was 2.
  person.falsePerEmptyHour = emptyHours === 0 ? null : person.emptyFalseEvents / emptyHours;
  vehicle.recall = vehicle.expected === 0 ? null : vehicle.found / vehicle.expected;
  vehicle.falsePerHour = hoursScored === 0 ? null : vehicle.falseEvents / hoursScored;
  vehicle.falsePerEmptyHour = emptyHours === 0 ? null : vehicle.emptyFalseEvents / emptyHours;

  return { hoursScored: hoursScored, emptyHours: emptyHours, person: person, vehicle: vehicle };
}

function scoreOneClip(
  clip: Clip,
  startMs: number,
  endMs: number,
  events: readonly DetectionEvent[],
  toleranceMs: number,
  person: KindScore,
  vehicle: KindScore,
  isEmptyScene: boolean,
): void {
  for (const kind of ["person", "vehicle"] as const) {
    const score = kind === "person" ? person : vehicle;

    // Events on this camera, of this kind, whose [firstUtc, lastUtc] touches
    // the clip. Everything else is ignored before it can skew anything.
    const inClip: TimedEvent[] = [];
    for (const event of events) {
      if (event.cameraId !== clip.cameraId || event.kind !== kind) {
        continue;
      }
      const firstMs = Date.parse(event.firstUtc);
      const lastMs = Date.parse(event.lastUtc);
      if (Number.isNaN(firstMs) || Number.isNaN(lastMs)) {
        continue;
      }
      if (firstMs <= endMs && lastMs >= startMs) {
        inClip.push({ firstMs: firstMs, lastMs: lastMs });
      }
    }
    inClip.sort((a, b) => a.firstMs - b.firstMs);

    // The expected windows for this kind, widened by the tolerance.
    const windows: ExpectedWindow[] = [];
    for (const expected of clip.expected) {
      if (expected.kind !== kind) {
        continue;
      }
      const fromMs = Date.parse(expected.fromUtc);
      const toMs = Date.parse(expected.toUtc);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        continue;
      }
      windows.push({
        fromUtc: expected.fromUtc,
        count: expected.count,
        startMs: fromMs - toleranceMs,
        endMs: toMs + toleranceMs,
      });
    }

    // Each detection can be claimed once, in firstUtc order, so a crowd of
    // one can never satisfy a count of two.
    const claimed: boolean[] = inClip.map(() => false);
    for (const window of windows) {
      let take = 0;
      for (let i = 0; i < inClip.length && take < window.count; i++) {
        if (claimed[i]) {
          continue;
        }
        const candidate = inClip[i]!;
        if (candidate.firstMs <= window.endMs && candidate.lastMs >= window.startMs) {
          claimed[i] = true;
          take += 1;
        }
      }
      score.expected += window.count;
      score.found += take;
      if (take < window.count) {
        score.missed.push({ clipId: clip.id, fromUtc: window.fromUtc, count: window.count - take });
      }
    }

    // An unclaimed detection inside an expected window is the same detection
    // seen twice (a split track) -- worth knowing, but not the same failure
    // as a person where there was nobody.
    for (let i = 0; i < inClip.length; i++) {
      if (claimed[i]) {
        continue;
      }
      const candidate = inClip[i]!;
      let insideAWindow = false;
      for (const window of windows) {
        if (candidate.firstMs <= window.endMs && candidate.lastMs >= window.startMs) {
          insideAWindow = true;
          break;
        }
      }
      if (insideAWindow) {
        score.duplicates += 1;
      } else {
        score.falseEvents += 1;
        if (isEmptyScene) score.emptyFalseEvents += 1;
      }
    }
  }
}

/**
 * The exit gate for AI-PLAN D1: a detector may leave this stage only if it
 * finds at least 95% of people and raises at most 1 false person per hour.
 * On a sample too small to support a bar the verdict is null -- 3 people out
 * of 3 is not 100%, and without empty-scene footage the false rate says
 * nothing. A wrong verdict is worse than no verdict.
 */
export function exitGate(score: Score): GateVerdict {
  const why: string[] = [];
  if (score.person.expected < MIN_GATE_PERSONS) {
    why.push(`need at least ${MIN_GATE_PERSONS} expected people, have ${score.person.expected}`);
  }
  if (score.emptyHours < MIN_GATE_EMPTY_HOURS) {
    // Rounded DOWN: 0.996 must never read as the 1 it falls short of.
    why.push(`need at least ${MIN_GATE_EMPTY_HOURS} hour of empty-scene footage, have ${Math.floor(score.emptyHours * 100) / 100}`);
  }

  let meetsRecall: boolean | null = null;
  if (score.person.expected >= MIN_GATE_PERSONS && score.person.recall !== null) {
    meetsRecall = score.person.recall >= GATE_RECALL;
  }
  let meetsFalseRate: boolean | null = null;
  if (score.emptyHours >= MIN_GATE_EMPTY_HOURS && score.person.falsePerEmptyHour !== null) {
    meetsFalseRate = score.person.falsePerEmptyHour <= GATE_FALSE_PER_HOUR;
  }

  return {
    enough: why.length === 0,
    why: why,
    recall: score.person.recall,
    falsePerEmptyHour: score.person.falsePerEmptyHour,
    meetsRecall: meetsRecall,
    meetsFalseRate: meetsFalseRate,
  };
}
