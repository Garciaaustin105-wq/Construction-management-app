/**
 * Occupancy: an incremental three-state tracker per (area, kind), fed
 * evidence frame by frame from agent/detect-service.mjs's frame handler.
 * MANAGER-RULES-SPEC.md section 2. Pure: no I/O, no clock of its own — every
 * instant is handed in by the caller, exactly like cameraAiSettings.ts's
 * `scheduleOpen`.
 *
 * THE FEARED FAILURES:
 * - a passer-by (a few seconds of presence evidence) read as "present" —
 *   hysteresis exists so a walk-through never counts (build rule: test the
 *   failure you fear, not the happy path);
 * - a missed frame or a lean away from the desk read as "absent" — the same
 *   hysteresis, the other direction;
 * - "no frame arrived" read as "absent evidence" — build rule 5's cousin: a
 *   still scene reporting nothing is not the same measurement as a scene
 *   that reported nobody there. Only an explicit absence-evidence call ever
 *   moves toward `absent`; a silent camera moves toward `not_watching`,
 *   never `absent` (`not_watching is never absent` — build rules, "Data").
 * - `not_watching` treated as a dead end that only a whole new tracker can
 *   leave: the spec says it "ends at the first frame, into whatever the
 *   evidence then says, after the same hysteresis" — so this file does not
 *   special-case leaving `not_watching`; the ordinary state machine already
 *   does that (see `advanceOccupancy`).
 *
 * WHAT ALREADY HAS A UNIT (build rule 22 — this file does not get to invent
 * a second "how long before it counts" answer): the absent-to-present
 * hysteresis reuses detection.ts's own `MERGE_GAP_MS` (10 s) — the spec
 * names it by that constant explicitly ("needs presence evidence spanning
 * >= 10 s (MERGE_GAP_MS)"), the same number a walking passer-by is folded or
 * split on there.
 */

import { MERGE_GAP_MS } from "./detection.js";

export type OccupancyKind = "person" | "vehicle";
export type OccupancyState = "present" | "absent" | "not_watching";

/** Presence evidence needs to span this long before `absent`/`not_watching` flips to `present`. */
export const PRESENT_HYSTERESIS_MS = MERGE_GAP_MS;
/** Absence evidence needs to span this long before `present`/`not_watching` flips to `absent`, by kind. */
export const ABSENT_HYSTERESIS_MS: Readonly<Record<OccupancyKind, number>> = Object.freeze({
  person: 30_000,
  vehicle: 60_000,
});
/**
 * No frame for this camera for longer than this: `not_watching`. "The same
 * threshold as the health 'detecting' sample" (MANAGER-RULES-SPEC.md) —
 * agent/health-history.mjs's own DETECTING_THRESHOLD_MS. Restated here rather
 * than imported: that file is an agent module (I/O, its own clock), and this
 * one is pure; the number is the shared fact, not the file it lives in.
 */
export const NOT_WATCHING_GAP_MS = 120_000;

/**
 * One tracker's state. Not a class: a plain, structurally-comparable value,
 * so a harness (or a real caller persisting between ticks) can inspect,
 * serialise and replay it freely.
 *
 * `not_watching` is the starting state (build rule 5: a camera nobody has
 * heard from yet is unwatched, never quietly "absent").
 */
export interface OccupancyTrackerState {
  current: OccupancyState;
  /** The kind of evidence currently accumulating toward a flip, or null when nothing is pending. */
  pendingKind: "presence" | "absence" | null;
  /** When the CURRENT unbroken run of `pendingKind` evidence began. */
  pendingSinceMs: number | null;
  /** The last frame's timestamp (presence OR absence evidence) — what the 120 s gap is measured from. Not touched by a schedule-closed or gap-tick call. */
  lastFrameAtMs: number | null;
  /** The timestamp of the last evidence handed in, of any kind — guards against evidence arriving out of order. */
  lastAtMs: number | null;
}

export const INITIAL_OCCUPANCY_STATE: Readonly<OccupancyTrackerState> = Object.freeze({
  current: "not_watching",
  pendingKind: null,
  pendingSinceMs: null,
  lastFrameAtMs: null,
  lastAtMs: null,
});

export type OccupancyEvidence =
  /** A frame with a matching detection inside the area (or, whole-camera, in frame at all). */
  | { type: "presence"; atMs: number }
  /** A frame with none inside. */
  | { type: "absence"; atMs: number }
  /** "Check now whether the camera has gone quiet" — sent on a timer even when no frame arrives, because a still scene sends no frame line at all. */
  | { type: "gapTick"; atMs: number }
  /** The camera's AI schedule closed: not_watching at once, no hysteresis. */
  | { type: "scheduleClosed"; atMs: number };

export interface OccupancyTransition {
  state: OccupancyState;
  atMs: number;
}

export interface OccupancyStep {
  state: OccupancyTrackerState;
  /** Non-null exactly when `state.current` differs from the state passed in — what detect-service writes to occupancy.db. */
  transition: OccupancyTransition | null;
}

function targetOf(evidenceType: "presence" | "absence"): OccupancyState {
  return evidenceType === "presence" ? "present" : "absent";
}

function requiredMsFor(target: OccupancyState, kind: OccupancyKind): number {
  return target === "present" ? PRESENT_HYSTERESIS_MS : ABSENT_HYSTERESIS_MS[kind];
}

/**
 * Advance one (area, kind) tracker by one piece of evidence. Evidence must
 * arrive in non-decreasing `atMs` order (the same frame-by-frame order
 * detect-service sees it) — out-of-order evidence throws rather than
 * silently reordering itself into a plausible-looking history.
 *
 * 1. scheduleClosed: if not already not_watching, flip immediately (no
 *    hysteresis — "at once"), clearing any pending run.
 * 2. gapTick: if not already not_watching AND a frame has been seen AND
 *    atMs - lastFrameAtMs >= NOT_WATCHING_GAP_MS, flip to not_watching,
 *    clearing any pending run. Otherwise no-op — a tick that has not yet
 *    reached the threshold changes nothing (it is not evidence of absence).
 * 3. presence / absence: lastFrameAtMs is updated regardless. Let
 *    target = "present" for presence, "absent" for absence.
 *    - If current === target: any pending run of the OTHER kind is
 *      cancelled (the state already matches; a brief wobble toward leaving
 *      it did not last).
 *    - Else: if pendingKind !== this evidence's kind, a fresh run starts now
 *      (pendingSinceMs = atMs). Otherwise the run continues, and once
 *      atMs - pendingSinceMs >= requiredMsFor(target, kind), current flips
 *      to target and the pending run clears. This is the SAME accumulation
 *      whether the tracker is leaving `present`, `absent`, or `not_watching`
 *      — "not_watching ends at the first frame, into whatever the evidence
 *      then says, after the same hysteresis" needs no special case here.
 */
export function advanceOccupancy(
  state: OccupancyTrackerState,
  evidence: OccupancyEvidence,
  kind: OccupancyKind,
): OccupancyStep {
  if (state.lastAtMs !== null && evidence.atMs < state.lastAtMs) {
    throw new RangeError(
      `advanceOccupancy: evidence out of order (${evidence.atMs} before ${state.lastAtMs})`,
    );
  }
  const before = state.current;
  let next: OccupancyTrackerState = { ...state, lastAtMs: evidence.atMs };

  if (evidence.type === "scheduleClosed") {
    next = { ...next, current: "not_watching", pendingKind: null, pendingSinceMs: null };
  } else if (evidence.type === "gapTick") {
    if (
      state.current !== "not_watching" &&
      state.lastFrameAtMs !== null &&
      evidence.atMs - state.lastFrameAtMs >= NOT_WATCHING_GAP_MS
    ) {
      next = { ...next, current: "not_watching", pendingKind: null, pendingSinceMs: null };
    }
  } else {
    // presence or absence: a real frame.
    next = { ...next, lastFrameAtMs: evidence.atMs };
    const target = targetOf(evidence.type);
    if (state.current === target) {
      next = { ...next, pendingKind: null, pendingSinceMs: null };
    } else if (state.pendingKind !== evidence.type) {
      next = { ...next, pendingKind: evidence.type, pendingSinceMs: evidence.atMs };
    } else {
      const since = state.pendingSinceMs as number;
      if (evidence.atMs - since >= requiredMsFor(target, kind)) {
        next = { ...next, current: target, pendingKind: null, pendingSinceMs: null };
      }
      // else: same run, not long enough yet — pendingSinceMs is unchanged
      // (the run's START, not its most recent sighting).
    }
  }

  const transition: OccupancyTransition | null =
    next.current === before ? null : { state: next.current, atMs: evidence.atMs };
  return { state: next, transition };
}
