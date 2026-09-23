/**
 * Known objects: a recurring, STILL false detection, learned once and then
 * hidden from events automatically. Pure: no I/O, and no clock of its own -
 * every "now" is passed in, so a harness can walk a day in a millisecond.
 *
 * WHY: on 2026-09-22 a furled patio umbrella by the fence was stored as a
 * PERSON 17 times in 25 minutes, the same box every time. Before it: a spray
 * bottle 77 times in 13 hours, a fence-post cap, a parked SUV recounted all
 * night. Every one of those is a notification someone learns to ignore, and at
 * 2,880 cameras nobody has the installer time to click each one away.
 *
 * WHOSE DECISION THIS IS: Austin decided on 2026-09-20 that suppressing a known
 * false positive applies AUTOMATICALLY - no operator click gates it. That
 * overrides build rule 13 (nothing auto-applies) for this one feature, and the
 * override is applied in exactly two places, both marked: learnKnownObjects
 * (which decides what is learned) and matchKnown (which decides what is
 * hidden). Moving or covering the object is never the fix: a real site is full
 * of things nobody will move.
 *
 * Because nobody clicks, the belts below are what make it safe. ALL of them
 * are required; none is a tuning knob:
 * 1. Tight geometry. A detection matches a known object only when its box
 *    overlaps the object's box by IoU >= KNOWN_IOU: a spot, not a region.
 * 2. Never learn, and never hide, a thing that TRAVELLED. An event's `travel`
 *    (contracts/detection.ts) is how far it got from where it was first seen,
 *    in its own box diagonals. A person arriving covers many; a static
 *    object's box never leaves itself. Unknown travel - every event stored
 *    before travel existed - is never read as "did not move" (rule 5).
 * 3. A learning floor: KNOWN_MIN_EVENTS events over KNOWN_MIN_SPAN_MS, grouped
 *    by contracts/fixtures.ts (whose doorway guard, the size spread, stays),
 *    every member within KNOWN_IOU of the object's median box.
 * 4. A lapse. Not matched for KNOWN_LAPSE_MS, or the camera re-aimed (its
 *    fingerprint changed), or reset by hand: the object stops hiding anything.
 * 5. Nothing destroyed. This file never deletes an event; hiding is a flag the
 *    storage layer keeps, and the Review page can show hidden events.
 * 6. The notification is the feature: knownObjectNotice says what was
 *    measured, and the owner's answer is kept as the training label.
 *
 * NO VERDICT (rule 11). Nothing here says what a known object IS. It says
 * "seen as a person 17 times at the same spot, never moving" - never "this is
 * an umbrella". Only a human's answer names it.
 */

import { EVENT_KINDS } from "./detection.js";
import type { Box, EventKind } from "./detection.js";
import { groupFixtures, FIXTURE_IOU } from "./fixtures.js";

/**
 * Belt 1: how tightly a detection must sit on a known object's box to be
 * hidden by it. 0.8 is a spot, not a region - tighter than fixtures.ts's 0.6,
 * because there a human reviews the group and here nobody does. A person
 * standing NEXT TO the umbrella overlaps it far less than this.
 */
export const KNOWN_IOU = 0.8;

/**
 * Belt 3: build rule 15's sample floor. Three sightings is the least that can
 * show a thing recurs rather than happened once. Must be at least fixtures.ts's
 * FIXTURE_MIN_SIGHTINGS, or groupFixtures would refuse a group this file means
 * to accept (the harness checks it).
 */
export const KNOWN_MIN_EVENTS = 3;

/**
 * Belt 3: and a span, so a busy half hour is never learned. The umbrella fired
 * 17 times in 25 minutes; a delivery driver waiting at a door can fire as many
 * in the same time. Two hours of the same box is something no visitor does.
 * Must be at least fixtures.ts's FIXTURE_MIN_SPAN_MS, for the same reason as
 * above.
 */
export const KNOWN_MIN_SPAN_MS = 2 * 3_600_000;

/**
 * Belt 2: an event whose travel reached this - half its own box diagonal -
 * moved. Wobble does not get there (boxJitter.ts, commit 5b751c7, measured that
 * wobble cannot separate a still person from an object, and this is not a
 * wobble test); someone walking in covers many diagonals.
 */
export const MOVED_TRAVEL = 0.5;

/**
 * Belt 4: a known object not matched for a day lapses. The thing was taken
 * away, or the camera now points elsewhere; either way, a spot that stopped
 * producing detections has stopped earning the right to hide them.
 */
export const KNOWN_LAPSE_MS = 24 * 3_600_000;

/**
 * How far back learning looks: two days of finished events. Long enough to see
 * an evening-only false detection on two evenings; short enough that evidence
 * from a camera that has since changed ages out on its own.
 */
export const LEARN_WINDOW_MS = 48 * 3_600_000;

/**
 * The score above which nothing is ever hidden, however well it matches.
 *
 * 0.85, set by Austin on 2026-09-23. He first chose to build without it
 * (2026-09-22: no real person far from the lens had been measured). Building
 * it showed what that costs: a still person at a fixed post - a cashier at a
 * till, a guard at a door - who turns up in SEPARATE events is learned and
 * hidden, because each new event starts with them already standing, so its
 * travel is small (pinned in harness/knownObjects.harness.mjs). Neither
 * travel nor the size guard can tell that from an umbrella.
 *
 * MEASURED on the bench camera, 2026-09-21/22: every confident real person
 * scored 0.87-0.95 (morning and evening, close to the lens); the false ones
 * scored 0.50-0.79 (the furled umbrella, 0.79 at its highest; the fence-post
 * cap 0.65). 0.85 sits between the two. What it does NOT cover: a real person
 * far from the lens scores lower, and none has been measured - but a far
 * person is small, and can only match (IoU >= 0.8) a known object that is
 * just as small and in the same place. Staged far walk-bys are what check it.
 * Revisit per camera once the answer key has them. null means "not set",
 * never "0".
 */
export const CONFIDENCE_CEILING: number | null = 0.85;

/**
 * How many member event ids a known object keeps. The OLDEST are dropped past
 * this, so the stored file stays small on a camera that fires all day;
 * `members` keeps the true count, and knownObjectNotice says when the list is
 * short of it.
 */
export const KNOWN_MAX_MEMBER_IDS = 500;

/** The version of the stored file, `{ "version": 1, "objects": [...] }`. */
export const KNOWN_OBJECTS_VERSION = 1;

/**
 * What learning and matching read from an event. Its own type - the shape
 * agent/events-db.mjs returns - so this file does not wait on any other.
 */
export interface KnownInputEvent {
  id: string;
  cameraId: string;
  kind: EventKind;
  firstUtc: string;
  lastUtc: string;
  bestConfidence: number;
  bestBox: Box;
  /**
   * Box diagonals travelled from the first sighting. null (or absent) means
   * NOT MEASURED - every event stored before travel existed - and is never
   * read as 0.
   */
  travel: number | null;
  /** Only a finished event is learned from: an open one may still walk away. */
  finished?: boolean;
  species?: string;
}

/**
 * What matchKnown needs: a subset, so the service can pass the event the fold
 * just made (a DetectionEvent, which has no id yet) as well as a stored one.
 */
export interface KnownMatchInput {
  cameraId: string;
  kind: EventKind;
  bestBox: Box;
  bestConfidence: number;
  travel?: number | null;
  firstUtc?: string;
  lastUtc?: string;
}

export type KnownLapseReason = "unseen" | "camera_changed" | "reset_by_hand";

/** The owner's answer to "is it meant to be there?": the training label. */
export interface KnownAnswer {
  belongs: boolean;
  atUtc: string;
  by: string;
}

export interface KnownObject {
  /** Stable: `${cameraId}:${kind}:${learnedAtMs}`, with `-2`, `-3`... only if
   *  two objects of one camera and kind are learned in the same millisecond. */
  id: string;
  cameraId: string;
  kind: EventKind;
  /** The MEDIAN of its members' boxes, per axis, so one wild sighting cannot drag it. */
  box: Box;
  state: "active" | "lapsed";
  lapsedAtUtc: string | null;
  lapseReason: KnownLapseReason | null;
  learnedAtUtc: string;
  /** From the members, then widened by every match. */
  firstSeenUtc: string;
  lastSeenUtc: string;
  lastMatchedUtc: string | null;
  /** How many events taught it. */
  members: number;
  /** How many events it has hidden since it was learned. */
  matched: number;
  /** The highest score any member was given. */
  confidenceMax: number;
  /** The most confident member: the still the page shows. */
  sampleEventId: string;
  /** Capped at KNOWN_MAX_MEMBER_IDS, oldest dropped; `members` keeps the true count. */
  memberEventIds: string[];
  /** The camera's config fingerprint when it was learned; a change lapses it. */
  cameraFingerprint: string;
  answer: KnownAnswer | null;
}

/**
 * Current config fingerprint per camera id, from agent/known-objects.mjs's
 * cameraFingerprint. A plain object keyed by camera id; a Map works too.
 */
export type Fingerprints = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

/**
 * Why a group of events was not learned from (build rule 16: say what could
 * not be used, and why). The spec's seven, plus four this file found it needs:
 * - before_lapse: the events ended before an object at that spot (or, for a
 *   camera change, anywhere on that camera) lapsed. Evidence that was already
 *   used and then withdrawn - by a person resetting it, by a re-aim, by a day
 *   unseen - must not teach the same object again ten minutes later.
 * - stale: the group's last sighting is already KNOWN_LAPSE_MS old; the object
 *   would be lapsed the moment it was learned.
 * - no_fingerprint: the camera is not in the current config, so a re-aim could
 *   never be noticed; nothing is learned for it.
 * - above_ceiling: only when a confidence ceiling is set (it is not yet).
 */
export type KnownRejectReason =
  | "moved"
  | "travel_unknown"
  | "too_few"
  | "too_brief"
  | "not_tight"
  | "size_spread"
  | "already_known"
  | "before_lapse"
  | "stale"
  | "no_fingerprint"
  | "above_ceiling";

export interface KnownRejected {
  cameraId: string;
  kind: EventKind;
  eventIds: string[];
  reason: KnownRejectReason;
}

export interface LearnArgs {
  events: readonly KnownInputEvent[];
  existing: readonly KnownObject[];
  nowUtc: string;
  fingerprints: Fingerprints;
  /** Defaults to CONFIDENCE_CEILING (not set). */
  confidenceCeiling?: number | null;
}

export interface Learning {
  /** NEW objects only; the caller adds them to `existing`. */
  learned: KnownObject[];
  /** How many events were in scope: finished, not a plate, inside the window. */
  considered: number;
  /** Every in-scope event that taught nothing sits in exactly one of these. */
  rejected: KnownRejected[];
}

export interface MatchOptions {
  /** Defaults to CONFIDENCE_CEILING (not set). */
  confidenceCeiling?: number | null;
}

export type KnownCheck = { ok: true; objects: KnownObject[] } | { ok: false; errors: string[] };

// ---------------------------------------------------------------- helpers

const MS_PER_HOUR = 3_600_000;

/** Stored times are ISO 8601 UTC, exactly as toISOString writes them (ms optional). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const OBJECT_KEYS: readonly string[] = [
  "id", "cameraId", "kind", "box", "state", "lapsedAtUtc", "lapseReason", "learnedAtUtc",
  "firstSeenUtc", "lastSeenUtc", "lastMatchedUtc", "members", "matched", "confidenceMax",
  "sampleEventId", "memberEventIds", "cameraFingerprint", "answer",
];
const LAPSE_REASONS: readonly string[] = ["unseen", "camera_changed", "reset_by_hand"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

/** Epoch ms of a string Date.parse understands, else null - never NaN. */
function parseMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms of a stored ISO UTC time, else null. Stricter than parseMs on purpose. */
function isoMs(value: unknown): number | null {
  return typeof value === "string" && ISO_UTC.test(value) ? parseMs(value) : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A short, safe rendering of an untrusted value for an error message. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
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

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function medianBox(events: readonly KnownInputEvent[]): Box {
  return {
    x: median(events.map((e) => e.bestBox.x)),
    y: median(events.map((e) => e.bestBox.y)),
    w: median(events.map((e) => e.bestBox.w)),
    h: median(events.map((e) => e.bestBox.h)),
  };
}

/**
 * Why a box cannot be read, or null. The same rule checkDetection applies, so
 * every box that reached an event passes it - and a median of in-frame boxes
 * is itself in frame, so everything learned passes checkKnownObjects.
 */
function boxProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return `must be an object, got ${describe(raw)}`;
  const { x, y, w, h } = raw;
  for (const [name, v] of [["x", x], ["y", y], ["w", w], ["h", h]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a finite number, got ${describe(v)}`;
  }
  const bx = x as number;
  const by = y as number;
  const bw = w as number;
  const bh = h as number;
  if (bx < 0 || by < 0 || bw <= 0 || bh <= 0 || bx + bw > 1 + 1e-6 || by + bh > 1 + 1e-6) {
    return `must lie inside the frame with w, h > 0 (fractions 0..1), got ${describe(raw)}`;
  }
  return null;
}

/**
 * The event's travel, or null when it was not measured. A negative, NaN or
 * non-number travel is not a measurement either: refused the same way, never
 * rounded to "did not move".
 */
function travelOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function checkCeiling(value: unknown, who: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    // A typo here must not quietly turn the belt off (or on): refuse loudly.
    throw new TypeError(`${who}: confidenceCeiling must be null (not set) or a score in (0, 1], got ${describe(value)}`);
  }
  return value;
}

function checkFingerprints(value: unknown, who: string): Fingerprints {
  if (value instanceof Map) {
    for (const [k, v] of value) {
      if (typeof k !== "string" || typeof v !== "string" || v === "") {
        throw new TypeError(`${who}: fingerprints must map camera ids to non-empty strings`);
      }
    }
    return value as ReadonlyMap<string, string>;
  }
  if (!isRecord(value)) throw new TypeError(`${who}: fingerprints must be an object keyed by camera id`);
  for (const v of Object.values(value)) {
    // A blank fingerprint is not a fingerprint (rule 5): it would "match" any
    // other blank and hide a re-aim.
    if (typeof v !== "string" || v === "") {
      throw new TypeError(`${who}: fingerprints must map camera ids to non-empty strings`);
    }
  }
  return value as Readonly<Record<string, string>>;
}

/** The camera's current fingerprint, or null when it is not in the config. */
function fingerprintOf(fingerprints: Fingerprints, cameraId: string): string | null {
  if (fingerprints instanceof Map) {
    const v: unknown = fingerprints.get(cameraId);
    return typeof v === "string" && v !== "" ? v : null;
  }
  // Own keys only: a camera called "constructor" must not find Object's.
  if (!Object.prototype.hasOwnProperty.call(fingerprints, cameraId)) return null;
  const v: unknown = (fingerprints as Record<string, unknown>)[cameraId];
  return typeof v === "string" && v !== "" ? v : null;
}

function eventProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return `must be an object, got ${describe(raw)}`;
  if (typeof raw.id !== "string" || raw.id === "") return `id must be a non-empty string, got ${describe(raw.id)}`;
  if (typeof raw.cameraId !== "string" || raw.cameraId === "") return `cameraId must be a non-empty string`;
  if (!isKind(raw.kind)) return `kind must be one of ${EVENT_KINDS.join(", ")}, got ${describe(raw.kind)}`;
  const c = raw.bestConfidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return `bestConfidence must be 0..1, got ${describe(c)}`;
  const first = parseMs(raw.firstUtc);
  const last = parseMs(raw.lastUtc);
  if (first === null || last === null) return `firstUtc and lastUtc must be UTC times`;
  if (last < first) return `lastUtc comes before firstUtc`;
  const box = boxProblem(raw.bestBox);
  if (box !== null) return `bestBox ${box}`;
  return null;
}

/**
 * The active object this box sits on, or null. Same camera and kind, IoU at
 * least KNOWN_IOU; when two qualify the higher IoU wins, and a tie goes to the
 * OLDER object - the one that has been standing there longer is the better
 * explanation, and the answer must not flip with the order of the list.
 */
function bestActive(box: Box, cameraId: string, kind: EventKind, objects: readonly KnownObject[]): KnownObject | null {
  let best: KnownObject | null = null;
  let bestIou = -1;
  let bestLearned = Infinity;
  for (const o of objects) {
    if (!isRecord(o) || o.state !== "active") continue;
    if (o.cameraId !== cameraId || o.kind !== kind) continue;
    if (boxProblem(o.box) !== null) continue;
    const overlap = iou(box, o.box);
    if (overlap < KNOWN_IOU) continue;
    const learned = parseMs(o.learnedAtUtc) ?? Infinity;
    if (overlap > bestIou || (overlap === bestIou && learned < bestLearned)) {
      best = o;
      bestIou = overlap;
      bestLearned = learned;
    }
  }
  return best;
}

/**
 * Did this event end before an object it could have taught lapsed? A camera
 * change withdraws everything that camera saw before it (the view is not the
 * same view); an unseen lapse or a reset withdraws what sat near that spot -
 * near meaning close enough that groupFixtures could have grouped it there.
 */
function beforeLapse(e: KnownInputEvent, lastMs: number, existing: readonly KnownObject[]): boolean {
  for (const o of existing) {
    if (o.state !== "lapsed" || o.cameraId !== e.cameraId) continue;
    const lapsedMs = parseMs(o.lapsedAtUtc);
    if (lapsedMs === null || lastMs > lapsedMs) continue;
    if (o.lapseReason === "camera_changed") return true;
    if (o.kind === e.kind && iou(e.bestBox, o.box) >= FIXTURE_IOU) return true;
  }
  return false;
}

function copyObject(o: KnownObject): KnownObject {
  return {
    id: o.id,
    cameraId: o.cameraId,
    kind: o.kind,
    box: { x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h },
    state: o.state,
    lapsedAtUtc: o.lapsedAtUtc,
    lapseReason: o.lapseReason,
    learnedAtUtc: o.learnedAtUtc,
    firstSeenUtc: o.firstSeenUtc,
    lastSeenUtc: o.lastSeenUtc,
    lastMatchedUtc: o.lastMatchedUtc,
    members: o.members,
    matched: o.matched,
    confidenceMax: o.confidenceMax,
    sampleEventId: o.sampleEventId,
    memberEventIds: [...o.memberEventIds],
    cameraFingerprint: o.cameraFingerprint,
    answer: o.answer === null ? null : { belongs: o.answer.belongs, atUtc: o.answer.atUtc, by: o.answer.by },
  };
}

/** Throw unless every object is one checkKnownObjects would accept. */
function requireObjects(raw: unknown, who: string): KnownObject[] {
  if (!Array.isArray(raw)) throw new TypeError(`${who}: known objects must be an array`);
  const errors: string[] = [];
  raw.forEach((o: unknown, i: number) => {
    checkObject(o, `object ${i}`, errors);
  });
  if (errors.length > 0) throw new TypeError(`${who}: ${errors.join("; ")}`);
  return raw as KnownObject[];
}

function requireNow(nowUtc: unknown, who: string): number {
  const ms = parseMs(nowUtc);
  if (ms === null) throw new TypeError(`${who}: nowUtc must be a UTC time, got ${describe(nowUtc)}`);
  return ms;
}

// ---------------------------------------------------------------- learning

/**
 * Learn new known objects from recent finished events.
 *
 * AUSTIN'S DECISION (2026-09-20) APPLIES HERE: what this returns is hidden
 * without anyone clicking - the service flags every member as hidden and
 * matches new events against it at once. Build rule 13 is overridden for this
 * feature only; every gate below is what stands in for the click.
 *
 * 1. Scope: FINISHED events, not plates (a plate is a reading of a real
 *    vehicle, never furniture), whose lastUtc is within LEARN_WINDOW_MS of
 *    now. `considered` counts them. Every event must be readable, else THROW,
 *    like groupFixtures: a learner that skips bad rows reports a smaller world
 *    with no clue why.
 * 2. Each in-scope event is refused, with its reason, when its travel is
 *    unknown (travel_unknown) or reached MOVED_TRAVEL (moved); when a ceiling
 *    is set and it scored above it (above_ceiling); when its camera has no
 *    fingerprint (no_fingerprint); when it ended before a lapse that withdrew
 *    it (before_lapse); or when it already sits on an ACTIVE known object
 *    (already_known - that one is just matched, never learned twice).
 * 3. The rest are grouped by groupFixtures, oldest first so the result does
 *    not depend on the caller's order. Its refusals (too_few, too_brief,
 *    size_spread - the doorway guard) are passed on as they are.
 * 4. Each fixture is tightened: members not within KNOWN_IOU of the median box
 *    are dropped (not_tight) and the median re-taken, until every remaining
 *    member sits on it. Then the fixture must not sit on an active object -
 *    including one learned earlier in this same pass (already_known), must
 *    still have KNOWN_MIN_EVENTS members (too_few) spanning KNOWN_MIN_SPAN_MS
 *    (too_brief), and its last sighting must be younger than KNOWN_LAPSE_MS
 *    (stale).
 * 5. What survives is learned: box = the median, sample = the most confident
 *    member (the earliest, on a tie), fingerprint = the camera's current one.
 */
export function learnKnownObjects(args: LearnArgs): Learning {
  const who = "learnKnownObjects";
  if (!isRecord(args)) throw new TypeError(`${who} needs { events, existing, nowUtc, fingerprints }`);
  const nowMs = requireNow(args.nowUtc, who);
  const ceiling = checkCeiling(args.confidenceCeiling === undefined ? CONFIDENCE_CEILING : args.confidenceCeiling, who);
  const fingerprints = checkFingerprints(args.fingerprints, who);
  const existing = requireObjects(args.existing, who);
  if (!Array.isArray(args.events)) throw new TypeError(`${who} needs an array of events`);

  const seenIds = new Set<string>();
  args.events.forEach((e: unknown, i: number) => {
    const problem = eventProblem(e);
    if (problem !== null) throw new TypeError(`${who} was given an event it could not read (index ${i}): ${problem}`);
    const id = (e as KnownInputEvent).id;
    // Two rows with one id would make "which event taught it" ambiguous.
    if (seenIds.has(id)) throw new TypeError(`${who} was given two events with the id ${describe(id)}`);
    seenIds.add(id);
  });

  const inScope = (args.events as readonly KnownInputEvent[])
    .filter((e) => e.finished === true && e.kind !== "plate" && nowMs - Date.parse(e.lastUtc) <= LEARN_WINDOW_MS)
    .sort((a, b) =>
      Date.parse(a.firstUtc) - Date.parse(b.firstUtc) ||
      Date.parse(a.lastUtc) - Date.parse(b.lastUtc) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rejected: KnownRejected[] = [];
  // Event-level refusals are gathered per camera, kind and reason, so a day of
  // walkers is one line that says "moved", not four hundred.
  const byReason = new Map<string, KnownRejected>();
  const refuse = (e: KnownInputEvent, reason: KnownRejectReason): void => {
    const key = `${reason}\u0000${e.cameraId}\u0000${e.kind}`;
    let entry = byReason.get(key);
    if (entry === undefined) {
      entry = { cameraId: e.cameraId, kind: e.kind, eventIds: [], reason };
      byReason.set(key, entry);
      rejected.push(entry);
    }
    entry.eventIds.push(e.id);
  };

  const usable: KnownInputEvent[] = [];
  for (const e of inScope) {
    const travel = travelOf(e.travel);
    if (travel === null) refuse(e, "travel_unknown");
    else if (travel >= MOVED_TRAVEL) refuse(e, "moved");
    else if (ceiling !== null && e.bestConfidence > ceiling) refuse(e, "above_ceiling");
    else if (fingerprintOf(fingerprints, e.cameraId) === null) refuse(e, "no_fingerprint");
    else if (beforeLapse(e, Date.parse(e.lastUtc), existing)) refuse(e, "before_lapse");
    else if (bestActive(e.bestBox, e.cameraId, e.kind, existing) !== null) refuse(e, "already_known");
    else usable.push(e);
  }

  const byId = new Map(usable.map((e) => [e.id, e] as const));
  const grouping = groupFixtures(usable);
  for (const r of grouping.rejected) {
    rejected.push({ cameraId: r.cameraId, kind: r.kind, eventIds: [...r.eventIds], reason: r.reason });
  }

  const learned: KnownObject[] = [];
  const takenIds = new Set<string>(existing.map((o) => o.id));

  for (const fixture of grouping.fixtures) {
    const members = fixture.eventIds.map((id) => byId.get(id) as KnownInputEvent);
    const base = { cameraId: fixture.cameraId, kind: fixture.kind };

    // Tighten: the stored box is the median, so every member must sit on the
    // median - not merely on the cluster's running box at the moment it joined.
    let kept = members;
    for (;;) {
      const box = medianBox(kept);
      const next = kept.filter((m) => iou(m.bestBox, box) >= KNOWN_IOU);
      if (next.length === kept.length || next.length === 0) {
        kept = next;
        break;
      }
      kept = next;
    }
    const keptIds = new Set(kept.map((m) => m.id));
    const dropped = members.filter((m) => !keptIds.has(m.id)).map((m) => m.id);
    if (dropped.length > 0) rejected.push({ ...base, eventIds: dropped, reason: "not_tight" });
    if (kept.length === 0) continue;

    const box = medianBox(kept);
    const ids = kept.map((m) => m.id);
    const firstMs = Math.min(...kept.map((m) => Date.parse(m.firstUtc)));
    const lastMs = Math.max(...kept.map((m) => Date.parse(m.lastUtc)));

    let reason: KnownRejectReason | null = null;
    if (bestActive(box, fixture.cameraId, fixture.kind, [...existing, ...learned]) !== null) reason = "already_known";
    else if (kept.length < KNOWN_MIN_EVENTS) reason = "too_few";
    else if (lastMs - firstMs < KNOWN_MIN_SPAN_MS) reason = "too_brief";
    // The same comparison lapseKnownObjects makes, so nothing is ever learned
    // only to lapse on the next pass.
    else if (nowMs - lastMs >= KNOWN_LAPSE_MS) reason = "stale";
    if (reason !== null) {
      rejected.push({ ...base, eventIds: ids, reason });
      continue;
    }

    let sample = kept[0] as KnownInputEvent;
    for (const m of kept) if (m.bestConfidence > sample.bestConfidence) sample = m;

    const baseId = `${fixture.cameraId}:${fixture.kind}:${nowMs}`;
    let id = baseId;
    for (let n = 2; takenIds.has(id); n++) id = `${baseId}-${n}`;
    takenIds.add(id);

    learned.push({
      id,
      cameraId: fixture.cameraId,
      kind: fixture.kind,
      box,
      state: "active",
      lapsedAtUtc: null,
      lapseReason: null,
      learnedAtUtc: iso(nowMs),
      firstSeenUtc: iso(firstMs),
      lastSeenUtc: iso(lastMs),
      lastMatchedUtc: null,
      members: kept.length,
      matched: 0,
      confidenceMax: Math.max(...kept.map((m) => m.bestConfidence)),
      sampleEventId: sample.id,
      // Oldest dropped past the cap; `members` still says how many there were.
      memberEventIds: ids.slice(-KNOWN_MAX_MEMBER_IDS),
      cameraFingerprint: fingerprintOf(fingerprints, fixture.cameraId) as string,
      answer: null,
    });
  }

  return { learned, considered: inScope.length, rejected };
}

// ---------------------------------------------------------------- matching

/**
 * The id of the active known object this event sits on, or null.
 *
 * AUSTIN'S DECISION (2026-09-20) APPLIES HERE: a non-null answer hides the
 * event with no click (build rule 13 overridden for this feature only). So
 * every doubt answers null - hiding nothing is the safe side:
 * - a plate, an unknown kind, or a box that cannot be read: null;
 * - travel unknown, or at least MOVED_TRAVEL: null. The person who walks in
 *   and stands exactly where the umbrella is has travelled, and is shown;
 * - a ceiling set and the score above it: null (not set yet - see
 *   CONFIDENCE_CEILING);
 * - otherwise the best active object of the same camera and kind with IoU at
 *   least KNOWN_IOU; the higher IoU wins, a tie goes to the older object. A
 *   lapsed object never matches.
 * An invalid confidenceCeiling option THROWS: that is a bug in the caller, not
 * data, and must not quietly switch a belt off.
 */
export function matchKnown(event: KnownMatchInput, objects: readonly KnownObject[], opts: MatchOptions = {}): string | null {
  const ceiling = checkCeiling(
    isRecord(opts) && opts.confidenceCeiling !== undefined ? opts.confidenceCeiling : CONFIDENCE_CEILING,
    "matchKnown",
  );
  // Read as untrusted: this runs on every upsert, and a malformed event must
  // come back "hide nothing", not crash the detector.
  const raw: unknown = event;
  if (!isRecord(raw)) return null;
  const cameraId = raw.cameraId;
  const kind = raw.kind;
  const bestBox = raw.bestBox;
  if (typeof cameraId !== "string" || cameraId === "") return null;
  if (!isKind(kind) || kind === "plate") return null;
  if (boxProblem(bestBox) !== null) return null;
  const travel = travelOf(raw.travel);
  if (travel === null || travel >= MOVED_TRAVEL) return null;
  if (ceiling !== null) {
    const c = raw.bestConfidence;
    if (typeof c !== "number" || !Number.isFinite(c) || c > ceiling) return null;
  }
  if (!Array.isArray(objects)) return null;
  return bestActive(bestBox as Box, cameraId, kind, objects)?.id ?? null;
}

/**
 * Record that `event` was hidden by `object`: matched + 1, lastMatchedUtc =
 * now, and the seen range widened to cover the event's own times when it has
 * them (a missing time widens nothing - a blank is not "now"). Counts calls:
 * note each finished event once. Throws when the event is on another camera or
 * of another kind - that is a caller bug, not a match. A new object; the
 * argument is not changed.
 */
export function noteMatch(object: KnownObject, event: KnownMatchInput, nowUtc: string): KnownObject {
  const nowMs = requireNow(nowUtc, "noteMatch");
  requireObjects([object], "noteMatch");
  if (!isRecord(event) || event.cameraId !== object.cameraId || event.kind !== object.kind) {
    throw new TypeError("noteMatch: the event is not on this object's camera and kind; match it with matchKnown first");
  }
  const next = copyObject(object);
  next.matched = object.matched + 1;
  next.lastMatchedUtc = iso(nowMs);
  const first = parseMs(event.firstUtc);
  const last = parseMs(event.lastUtc);
  if (first !== null && first < Date.parse(next.firstSeenUtc)) next.firstSeenUtc = iso(first);
  if (last !== null && last > Date.parse(next.lastSeenUtc)) next.lastSeenUtc = iso(last);
  return next;
}

// ---------------------------------------------------------------- lapsing

/**
 * Belt 4. Every ACTIVE object whose camera's fingerprint now differs from the
 * one it was learned under lapses as "camera_changed" (host, channel, stream
 * or address changed: the spot may be a different spot); otherwise one not
 * matched for KNOWN_LAPSE_MS - counted from lastMatchedUtc, else lastSeenUtc -
 * lapses as "unseen". A camera ABSENT from `fingerprints` is left entirely
 * alone: a camera nobody is watching has not changed, and "not seen" would be
 * a claim about looking that nobody made. Already-lapsed objects are never
 * touched (their first reason stands). Returns a new array; changed objects
 * are new objects, unchanged ones are the same references.
 */
export function lapseKnownObjects(objects: readonly KnownObject[], nowUtc: string, fingerprints: Fingerprints): KnownObject[] {
  const who = "lapseKnownObjects";
  const nowMs = requireNow(nowUtc, who);
  const fp = checkFingerprints(fingerprints, who);
  const list = requireObjects(objects, who);
  return list.map((o) => {
    if (o.state !== "active") return o;
    const current = fingerprintOf(fp, o.cameraId);
    if (current === null) return o;
    let reason: KnownLapseReason | null = null;
    if (current !== o.cameraFingerprint) reason = "camera_changed";
    else if (nowMs - Date.parse(o.lastMatchedUtc ?? o.lastSeenUtc) >= KNOWN_LAPSE_MS) reason = "unseen";
    if (reason === null) return o;
    const next = copyObject(o);
    next.state = "lapsed";
    next.lapsedAtUtc = iso(nowMs);
    next.lapseReason = reason;
    return next;
  });
}

/**
 * A human's reset (camctl known-objects --reset): an active object lapses with
 * "reset_by_hand" at now. An already-lapsed object comes back unchanged - its
 * first reason is the true one. The caller also un-hides its events.
 */
export function resetKnownObject(object: KnownObject, nowUtc: string): KnownObject {
  const nowMs = requireNow(nowUtc, "resetKnownObject");
  requireObjects([object], "resetKnownObject");
  if (object.state !== "active") return object;
  const next = copyObject(object);
  next.state = "lapsed";
  next.lapsedAtUtc = iso(nowMs);
  next.lapseReason = "reset_by_hand";
  return next;
}

/**
 * Record the owner's answer to "is it meant to be there?" - the training
 * label. It changes nothing about hiding: nobody is asked before it applies,
 * and the answer is kept, not acted on. A later answer replaces an earlier one
 * (people change their minds; the time and name say which is which).
 */
export function answerKnownObject(object: KnownObject, answer: { belongs: boolean; by: string }, nowUtc: string): KnownObject {
  const nowMs = requireNow(nowUtc, "answerKnownObject");
  requireObjects([object], "answerKnownObject");
  if (!isRecord(answer) || typeof answer.belongs !== "boolean") {
    throw new TypeError("answerKnownObject: belongs must be true or false");
  }
  if (typeof answer.by !== "string" || answer.by.trim() === "") {
    throw new TypeError("answerKnownObject: by must name who answered");
  }
  const next = copyObject(object);
  next.answer = { belongs: answer.belongs, atUtc: iso(nowMs), by: answer.by };
  return next;
}

// ---------------------------------------------------------------- the stored file

/**
 * Validate the stored file `{ "version": 1, "objects": [...] }`. Never throws.
 * Strict: exact keys at every level, ISO UTC times, boxes inside the frame,
 * a lapse reason exactly when lapsed, unique ids. A file that cannot be
 * trusted is refused WHOLE - hiding people on the strength of a half-read
 * file is worse than hiding nothing. On success the objects are fresh copies.
 */
export function checkKnownObjects(raw: unknown): KnownCheck {
  try {
    return validateFile(raw);
  } catch (err) {
    // The checker must refuse, never crash: a crashed checker looks like an
    // empty store, and an empty store hides nothing without saying why.
    const message = err instanceof Error ? err.message : describe(err);
    return { ok: false, errors: [`known objects could not be checked: ${message}`] };
  }
}

function validateFile(raw: unknown): KnownCheck {
  if (!isRecord(raw)) return { ok: false, errors: [`known objects file must be an object, got ${describe(raw)}`] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "objects") errors.push(`known objects file has an unknown key ${describe(key)}`);
  }
  if (raw.version !== KNOWN_OBJECTS_VERSION) {
    errors.push(`known objects version must be ${KNOWN_OBJECTS_VERSION}, got ${describe(raw.version)}`);
  }
  if (!Array.isArray(raw.objects)) {
    errors.push(`known objects must be an array, got ${describe(raw.objects)}`);
    return { ok: false, errors };
  }
  const objects: KnownObject[] = [];
  const ids = new Set<string>();
  raw.objects.forEach((o: unknown, i: number) => {
    const checked = checkObject(o, `object ${i}`, errors);
    if (checked === null) return;
    if (ids.has(checked.id)) {
      // An id names the object in every hidden event; two would make an event's
      // flag point at either.
      errors.push(`object ${i}: duplicate id ${describe(checked.id)}`);
      return;
    }
    ids.add(checked.id);
    objects.push(checked);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, objects };
}

function checkObject(raw: unknown, where: string, errors: string[]): KnownObject | null {
  if (!isRecord(raw)) {
    errors.push(`${where}: must be an object, got ${describe(raw)}`);
    return null;
  }
  const before = errors.length;
  const bad = (msg: string): void => {
    errors.push(`${where}: ${msg}`);
  };
  for (const key of Object.keys(raw)) {
    if (!OBJECT_KEYS.includes(key)) bad(`unknown key ${describe(key)}`);
  }
  for (const key of OBJECT_KEYS) {
    if (!(key in raw)) bad(`missing ${key}`);
  }
  if (errors.length > before) return null;

  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
  if (!nonEmpty(raw.id)) bad(`id must be a non-empty string, got ${describe(raw.id)}`);
  if (!nonEmpty(raw.cameraId)) bad(`cameraId must be a non-empty string, got ${describe(raw.cameraId)}`);
  // A plate is never a known object; refusing it here keeps a hand-edited file
  // from hiding plate reads.
  if (!isKind(raw.kind) || raw.kind === "plate") bad(`kind must be person or vehicle, got ${describe(raw.kind)}`);
  const boxBad = boxProblem(raw.box);
  if (boxBad !== null) bad(`box ${boxBad}`);
  else {
    for (const key of Object.keys(raw.box as object)) {
      if (!["x", "y", "w", "h"].includes(key)) bad(`box has an unknown key ${describe(key)}`);
    }
  }

  if (raw.state === "active") {
    if (raw.lapsedAtUtc !== null || raw.lapseReason !== null) bad("an active object must have lapsedAtUtc and lapseReason null");
  } else if (raw.state === "lapsed") {
    if (isoMs(raw.lapsedAtUtc) === null) bad(`lapsedAtUtc must be an ISO UTC time, got ${describe(raw.lapsedAtUtc)}`);
    if (typeof raw.lapseReason !== "string" || !LAPSE_REASONS.includes(raw.lapseReason)) {
      bad(`lapseReason must be one of ${LAPSE_REASONS.join(", ")}, got ${describe(raw.lapseReason)}`);
    }
  } else {
    bad(`state must be "active" or "lapsed", got ${describe(raw.state)}`);
  }

  if (isoMs(raw.learnedAtUtc) === null) bad(`learnedAtUtc must be an ISO UTC time, got ${describe(raw.learnedAtUtc)}`);
  const firstMs = isoMs(raw.firstSeenUtc);
  const lastMs = isoMs(raw.lastSeenUtc);
  if (firstMs === null) bad(`firstSeenUtc must be an ISO UTC time, got ${describe(raw.firstSeenUtc)}`);
  if (lastMs === null) bad(`lastSeenUtc must be an ISO UTC time, got ${describe(raw.lastSeenUtc)}`);
  if (firstMs !== null && lastMs !== null && lastMs < firstMs) bad("lastSeenUtc comes before firstSeenUtc");
  if (raw.lastMatchedUtc !== null && isoMs(raw.lastMatchedUtc) === null) {
    bad(`lastMatchedUtc must be null or an ISO UTC time, got ${describe(raw.lastMatchedUtc)}`);
  }

  const members = raw.members;
  if (typeof members !== "number" || !Number.isInteger(members) || members < 1) bad(`members must be a positive whole number, got ${describe(members)}`);
  const matched = raw.matched;
  if (typeof matched !== "number" || !Number.isInteger(matched) || matched < 0) bad(`matched must be a whole number >= 0, got ${describe(matched)}`);
  const conf = raw.confidenceMax;
  if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) bad(`confidenceMax must be 0..1, got ${describe(conf)}`);
  if (!nonEmpty(raw.sampleEventId)) bad(`sampleEventId must be a non-empty string, got ${describe(raw.sampleEventId)}`);

  const memberIds = raw.memberEventIds;
  if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > KNOWN_MAX_MEMBER_IDS) {
    bad(`memberEventIds must be an array of 1 to ${KNOWN_MAX_MEMBER_IDS} ids`);
  } else {
    if (!memberIds.every(nonEmpty)) bad("memberEventIds must all be non-empty strings");
    else if (new Set(memberIds).size !== memberIds.length) bad("memberEventIds has a duplicate");
    if (typeof members === "number" && memberIds.length > members) bad("memberEventIds lists more events than members");
  }
  if (!nonEmpty(raw.cameraFingerprint)) bad(`cameraFingerprint must be a non-empty string, got ${describe(raw.cameraFingerprint)}`);

  const answer = raw.answer;
  if (answer !== null) {
    if (!isRecord(answer)) bad(`answer must be null or { belongs, atUtc, by }, got ${describe(answer)}`);
    else {
      for (const key of Object.keys(answer)) {
        if (!["belongs", "atUtc", "by"].includes(key)) bad(`answer has an unknown key ${describe(key)}`);
      }
      if (typeof answer.belongs !== "boolean") bad(`answer.belongs must be true or false, got ${describe(answer.belongs)}`);
      if (isoMs(answer.atUtc) === null) bad(`answer.atUtc must be an ISO UTC time, got ${describe(answer.atUtc)}`);
      if (typeof answer.by !== "string" || answer.by.trim() === "") bad("answer.by must name who answered");
    }
  }

  if (errors.length > before) return null;
  return copyObject(raw as unknown as KnownObject);
}

// ---------------------------------------------------------------- the notice

const KIND_WORDS: Readonly<Record<EventKind, string>> = { person: "a person", vehicle: "a vehicle", plate: "a plate" };

function times(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Plain-English MEASUREMENT lines for the Review page and the CLI - what was
 * seen, where, when, how often, and what has been hidden. Never what the thing
 * IS (rule 11): no "umbrella", no "false", no "not a person".
 *
 * Times are given as the stored ISO UTC strings, exactly (toISOString form), so
 * the page can find each one - /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/ -
 * and show it in the viewer's local time; the CLI can print them as they are.
 */
export function knownObjectNotice(object: KnownObject): string[] {
  const o = object;
  const lines: string[] = [];
  const seen = o.members + o.matched;
  lines.push(
    `Seen as ${KIND_WORDS[o.kind] ?? "a detection"} ${times(seen, "time", "times")} at the same spot, never moving, ` +
      `from ${o.firstSeenUtc} to ${o.lastSeenUtc}.`,
  );
  const taught = o.memberEventIds.length < o.members
    ? `the ${o.memberEventIds.length} most recent of the ${o.members} sightings it was learned from`
    : `the ${o.members} sightings it was learned from`;
  if (o.state === "active") {
    lines.push(`Hidden from events since ${o.learnedAtUtc}: ${taught}, and ${o.matched} more since.`);
  } else {
    lines.push(`Learned at ${o.learnedAtUtc}; it hid ${taught}, and ${o.matched} more after that.`);
  }
  lines.push(`Highest score as ${KIND_WORDS[o.kind] ?? "a detection"}: ${o.confidenceMax.toFixed(2)}.`);
  if (o.state === "lapsed") {
    const why = o.lapseReason === "unseen"
      ? `not matched for ${KNOWN_LAPSE_MS / MS_PER_HOUR} hours`
      : o.lapseReason === "camera_changed"
        ? "the camera's connection settings changed"
        : o.lapseReason === "reset_by_hand"
          ? "reset by hand"
          : "no reason recorded";
    lines.push(`Stopped hiding new events at ${o.lapsedAtUtc}: ${why}.`);
  }
  if (o.answer === null) {
    lines.push("No answer recorded yet.");
  } else {
    lines.push(`Answered at ${o.answer.atUtc} by ${o.answer.by}: ${o.answer.belongs ? "it belongs there" : "it should not be there"}.`);
  }
  return lines;
}
