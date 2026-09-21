/**
 * Grouping repeated detections into fixtures. Pure: no I/O, no clock.
 *
 * WHY: the spray bottle was reported 77 times in 13 hours, the child's bike
 * 163 times in an afternoon. Each of those is a labelled training set that
 * costs one human decision instead of hundreds — IF "these are all the same
 * object" is decided correctly. agent/harvest.mjs cuts the crops; this decides
 * which events belong together.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT, and it is worse than any other in
 * the project: a doorway that DIFFERENT PEOPLE walk through all day looks, to
 * a careless grouper, exactly like one object that never leaves. Label that
 * "furniture" and harvest it, and you have built a training set whose lesson
 * is "ignore people in doorways". So agreement is required in SIZE as well as
 * position: a child and a courier do not share a silhouette, while a parked
 * car is the same silhouette every time.
 *
 * This module states NO verdict about what a fixture IS — no isFurniture, no
 * label. It says "these detections are the same recurring thing, here is the
 * evidence". A human says what it is (build rule 11, and 13: nothing
 * auto-applies).
 */

import type { Box, EventKind } from "./detection.js";

/** Boxes must properly agree, not merely touch. */
export const FIXTURE_IOU = 0.6;
/** Build rule 15's sample floor. */
export const FIXTURE_MIN_SIGHTINGS = 3;
/** And a span, so a busy ten minutes is never mistaken for furniture. */
export const FIXTURE_MIN_SPAN_MS = 30 * 60_000;
/**
 * How much the members' sizes may vary: (largest diagonal - smallest) over the
 * median. This is the doorway guard. A parked car redetected all afternoon
 * varies by a few percent; a stream of different people varies by far more.
 */
export const FIXTURE_MAX_SIZE_SPREAD = 0.35;

/** What a caller must supply. The shape agent/events-db.mjs already returns. */
export interface FixtureEvent {
  id: string;
  cameraId: string;
  kind: EventKind;
  firstUtc: string;
  lastUtc: string;
  bestConfidence: number;
  bestBox: Box;
  species?: string;
}

export interface Fixture {
  cameraId: string;
  kind: EventKind;
  /** The MEDIAN box of its members, so one wild sighting cannot drag it. */
  box: Box;
  eventIds: string[];
  firstUtc: string;
  lastUtc: string;
  spanMs: number;
  confidenceMax: number;
  /** The species, when every sighting agreed; null when they did not. */
  species: string | null;
  /** Every species seen, sorted. Two sources disagreeing is information. */
  speciesSeen: string[];
}

export interface Rejected {
  cameraId: string;
  kind: EventKind;
  eventIds: string[];
  reason: "too_few" | "too_brief" | "size_spread";
}

export interface Grouping {
  fixtures: Fixture[];
  /** Events that belong to no fixture: a human still has to look at these. */
  ungrouped: string[];
  /** Clusters that ALMOST qualified, and why they did not (build rule 16). */
  rejected: Rejected[];
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

function usable(e: unknown): e is FixtureEvent {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return false;
  const ev = e as FixtureEvent;
  if (typeof ev.id !== "string" || ev.id === "") return false;
  if (typeof ev.cameraId !== "string" || ev.cameraId === "") return false;
  if (typeof ev.kind !== "string") return false;
  if (typeof ev.bestConfidence !== "number" || !Number.isFinite(ev.bestConfidence)) return false;
  if (Number.isNaN(Date.parse(ev.firstUtc)) || Number.isNaN(Date.parse(ev.lastUtc))) return false;
  const b = ev.bestBox;
  if (b === null || typeof b !== "object") return false;
  for (const v of [b.x, b.y, b.w, b.h]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return b.w > 0 && b.h > 0;
}

/**
 * Group events into fixtures.
 *
 * 1. Every event must be readable, else throw — a grouper that silently skips
 *    malformed events reports a smaller world with no clue why.
 * 2. Cluster within the same cameraId AND kind only. An event joins a cluster
 *    when it overlaps that cluster's current median box by at least
 *    FIXTURE_IOU; otherwise it starts a new cluster.
 * 3. A cluster becomes a fixture only when ALL THREE hold:
 *    - at least FIXTURE_MIN_SIGHTINGS members (rule 15's sample floor);
 *    - a span of at least FIXTURE_MIN_SPAN_MS between its first and last
 *      sighting (so a busy ten minutes is never furniture);
 *    - a size spread no greater than FIXTURE_MAX_SIZE_SPREAD — the doorway
 *      guard described at the top of this file.
 *    A cluster that fails any of them is REPORTED in `rejected` with the
 *    reason, never silently dropped, and its events go to `ungrouped`.
 * 4. The fixture's box is the median of its members, per axis.
 * 5. species is the one every member agreed on, or null; speciesSeen lists all
 *    of them, sorted.
 */
export function groupFixtures(events: unknown): Grouping {
  if (!Array.isArray(events)) throw new TypeError("groupFixtures needs an array of events");
  for (const e of events) {
    if (!usable(e)) throw new TypeError("groupFixtures was given an event it could not read");
  }
  const list = events as FixtureEvent[];

  type Cluster = { cameraId: string; kind: EventKind; members: FixtureEvent[]; box: Box };
  const clusters: Cluster[] = [];
  for (const e of list) {
    let hit: Cluster | undefined;
    for (const c of clusters) {
      if (c.cameraId !== e.cameraId || c.kind !== e.kind) continue;
      if (iou(c.box, e.bestBox) < FIXTURE_IOU) continue;
      hit = c;
      break;
    }
    if (hit === undefined) {
      clusters.push({ cameraId: e.cameraId, kind: e.kind, members: [e], box: { ...e.bestBox } });
      continue;
    }
    hit.members.push(e);
    hit.box = {
      x: median(hit.members.map((m) => m.bestBox.x)),
      y: median(hit.members.map((m) => m.bestBox.y)),
      w: median(hit.members.map((m) => m.bestBox.w)),
      h: median(hit.members.map((m) => m.bestBox.h)),
    };
  }

  const fixtures: Fixture[] = [];
  const rejected: Rejected[] = [];
  const ungrouped: string[] = [];

  for (const c of clusters) {
    const ids = c.members.map((m) => m.id);
    const starts = c.members.map((m) => Date.parse(m.firstUtc));
    const ends = c.members.map((m) => Date.parse(m.lastUtc));
    const spanMs = Math.max(...ends) - Math.min(...starts);
    const diags = c.members.map((m) => Math.hypot(m.bestBox.w, m.bestBox.h));
    const mid = median(diags);
    const sizeSpread = mid <= 0 ? Infinity : (Math.max(...diags) - Math.min(...diags)) / mid;

    let reason: Rejected["reason"] | null = null;
    if (c.members.length < FIXTURE_MIN_SIGHTINGS) reason = "too_few";
    else if (spanMs < FIXTURE_MIN_SPAN_MS) reason = "too_brief";
    else if (sizeSpread > FIXTURE_MAX_SIZE_SPREAD) reason = "size_spread";

    if (reason !== null) {
      rejected.push({ cameraId: c.cameraId, kind: c.kind, eventIds: ids, reason });
      ungrouped.push(...ids);
      continue;
    }

    const seen = [...new Set(c.members.map((m) => m.species).filter((s): s is string => typeof s === "string"))].sort();
    fixtures.push({
      cameraId: c.cameraId,
      kind: c.kind,
      box: c.box,
      eventIds: ids,
      firstUtc: new Date(Math.min(...starts)).toISOString(),
      lastUtc: new Date(Math.max(...ends)).toISOString(),
      spanMs,
      confidenceMax: Math.max(...c.members.map((m) => m.bestConfidence)),
      species: seen.length === 1 ? (seen[0] as string) : null,
      speciesSeen: seen,
    });
  }

  return { fixtures, ungrouped, rejected };
}
