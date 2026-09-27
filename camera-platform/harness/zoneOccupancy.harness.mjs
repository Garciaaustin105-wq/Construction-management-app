// harness/zoneOccupancy.harness.mjs — contracts/zoneOccupancy.ts
//
// FEARED: a passer-by under 10 s becomes present; a 20 s dropout of a seated
// person becomes absent; a still scene with no frames becomes absent instead
// of not_watching; not_watching treated as a dead end a normal frame cannot
// leave; a settings-hidden detection fed in as if it were real evidence.

import { check, eq, same, throws, report } from "./_assert.mjs";
import {
  PRESENT_HYSTERESIS_MS, ABSENT_HYSTERESIS_MS, NOT_WATCHING_GAP_MS,
  INITIAL_OCCUPANCY_STATE, advanceOccupancy,
} from "../dist/zoneOccupancy.js";
import { judgeDetection } from "../dist/cameraAiSettings.js";

console.log("zone occupancy");

eq(PRESENT_HYSTERESIS_MS, 10_000);
eq(ABSENT_HYSTERESIS_MS, { person: 30_000, vehicle: 60_000 });
eq(NOT_WATCHING_GAP_MS, 120_000);

const T0 = 1_800_000_000_000; // an arbitrary fixed instant

function presence(atMs) { return { type: "presence", atMs }; }
function absence(atMs) { return { type: "absence", atMs }; }
function gapTick(atMs) { return { type: "gapTick", atMs }; }
function scheduleClosed(atMs) { return { type: "scheduleClosed", atMs }; }

/** Feed a sequence of evidence through one tracker, kind fixed, returning every transition in order. */
function run(kind, evidenceList, startState = INITIAL_OCCUPANCY_STATE) {
  let state = startState;
  const transitions = [];
  for (const e of evidenceList) {
    const step = advanceOccupancy(state, e, kind);
    state = step.state;
    if (step.transition !== null) transitions.push(step.transition);
  }
  return { state, transitions };
}

check("starts not_watching, never present or absent, before any evidence", () => {
  eq(INITIAL_OCCUPANCY_STATE.current, "not_watching");
});

check("FEARED: a passer-by under 10 s never becomes present", () => {
  const { state, transitions } = run("person", [
    presence(T0), presence(T0 + 3_000), presence(T0 + 8_000), // 8 s of presence: under 10 s
    absence(T0 + 9_000),
  ], { current: "absent", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0 - 1_000, lastAtMs: T0 - 1_000 });
  eq(state.current, "absent");
  eq(transitions, []);
});

check("presence spanning exactly 10 s flips absent to present, at the 10 s mark", () => {
  const { state, transitions } = run("person", [
    presence(T0), presence(T0 + 5_000), presence(T0 + 10_000),
  ], { current: "absent", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: null, lastAtMs: null });
  eq(state.current, "present");
  eq(transitions, [{ state: "present", atMs: T0 + 10_000 }]);
});

check("FEARED: a 20 s dropout of a seated person never becomes absent", () => {
  const seated = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  const { state, transitions } = run("person", [
    absence(T0 + 5_000), absence(T0 + 15_000), absence(T0 + 20_000), // 20 s < 30 s threshold
    presence(T0 + 21_000), // the person is seen again before the threshold
  ], seated);
  eq(state.current, "present");
  eq(transitions, []);
});

check("absence spanning the full person threshold (30 s) flips present to absent", () => {
  const seated = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  const { state, transitions } = run("person", [
    absence(T0 + 5_000), absence(T0 + 30_000), absence(T0 + 35_000),
  ], seated);
  eq(state.current, "absent");
  eq(transitions, [{ state: "absent", atMs: T0 + 35_000 }]);
});

check("a vehicle needs 60 s of absence, not 30 s", () => {
  const parked = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  const under = run("vehicle", [absence(T0), absence(T0 + 40_000)], parked);
  eq(under.state.current, "present");
  const over = run("vehicle", [absence(T0), absence(T0 + 60_000)], parked);
  eq(over.state.current, "absent");
});

check("FEARED: a still scene with no frames for 120 s becomes not_watching, never absent", () => {
  const present = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  const { state, transitions } = run("person", [
    gapTick(T0 + 60_000), gapTick(T0 + 119_000), // not yet
  ], present);
  eq(state.current, "present");
  eq(transitions, []);
  const gone = run("person", [gapTick(T0 + 60_000), gapTick(T0 + 120_000)], present);
  eq(gone.state.current, "not_watching");
  eq(gone.transitions, [{ state: "not_watching", atMs: T0 + 120_000 }]);
  // never absent at any point along the way
  eq(gone.transitions.some((t) => t.state === "absent"), false);
});

check("not_watching ends at the first frame, into whatever the evidence says, after the SAME hysteresis", () => {
  const notWatching = { current: "not_watching", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: null, lastAtMs: T0 - 1 };
  // a single frame does not immediately end it...
  const one = run("person", [presence(T0)], notWatching);
  eq(one.state.current, "not_watching");
  eq(one.transitions, []);
  // ...but 10 s of unbroken presence does, same as absent-to-present
  const ten = run("person", [presence(T0), presence(T0 + 10_000)], notWatching);
  eq(ten.state.current, "present");
  eq(ten.transitions, [{ state: "present", atMs: T0 + 10_000 }]);
  // and absence evidence takes it to absent instead, after ITS OWN hysteresis
  const toAbsent = run("person", [absence(T0), absence(T0 + 30_000)], notWatching);
  eq(toAbsent.state.current, "absent");
});

check("FEARED: the schedule closing forces not_watching AT ONCE, no hysteresis, from any state", () => {
  const present = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  const step = advanceOccupancy(present, scheduleClosed(T0 + 1), "person");
  eq(step.state.current, "not_watching");
  eq(step.transition, { state: "not_watching", atMs: T0 + 1 });
  // idempotent: closing again while already not_watching emits no second transition
  const again = advanceOccupancy(step.state, scheduleClosed(T0 + 2), "person");
  eq(again.transition, null);
});

check("a not_watching gap restarts the 10 s presence clock for absent_longer_than's sibling to see", () => {
  // present -> (gap to not_watching) -> presence resumes, but for only 8 s: never flips back to present
  const present = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  const closed = advanceOccupancy(present, scheduleClosed(T0 + 1_000), "person").state;
  const { state, transitions } = run("person", [presence(T0 + 2_000), presence(T0 + 9_000)], closed);
  eq(state.current, "not_watching");
  eq(transitions, []);
});

check("FEARED: a car that is a known object still shows present in its spot (continuous evidence, no built-in timeout)", () => {
  let state = { current: "absent", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0 - 1, lastAtMs: T0 - 1 };
  const seenTransitions = [];
  // presence re-confirmed every 5s for 40 minutes straight, exactly what a
  // known-object car re-detected every cycle looks like from this file's
  // point of view -- it does not know or care that the object is "known".
  let t = T0;
  const end = T0 + 40 * 60_000;
  while (t <= end) {
    const step = advanceOccupancy(state, presence(t), "vehicle");
    state = step.state;
    if (step.transition !== null) seenTransitions.push(step.transition);
    t += 5_000;
  }
  eq(state.current, "present");
  // exactly one transition (absent -> present at the 10s mark), never flips away again
  eq(seenTransitions.length, 1);
  eq(seenTransitions[0].state, "present");
});

check("out-of-order evidence throws rather than silently reordering", () => {
  const s = run("person", [presence(T0 + 10_000)]).state;
  throws(() => advanceOccupancy(s, presence(T0), "person"), "evidence before the last seen instant");
});

check("evidence returning to the current state cancels a pending run toward the other one", () => {
  const present = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  let state = advanceOccupancy(present, absence(T0 + 5_000), "person").state;
  eq(state.pendingKind, "absence");
  state = advanceOccupancy(state, presence(T0 + 6_000), "person").state;
  eq(state.pendingKind, null);
  eq(state.current, "present");
});

// ---------------------------------------------------------------- integration with cameraAiSettings.ts

check("FEARED: a settings-hidden detection is not evidence -- the caller must skip it, per judgeDetection's hiddenBy", () => {
  // A camera whose kinds turn "person" off: judgeDetection still says
  // { store: true, hiddenBy: "settings:kind" } (the detector saw it, and the
  // event store still records it, hidden) -- but MANAGER-RULES-SPEC.md says
  // this is NOT occupancy evidence, "the same 'counts' decision the camera's
  // settings make". The correct integration checks hiddenBy and, when it is
  // non-null, calls advanceOccupancy with neither presence nor absence for
  // this detection at all.
  const settings = { zones: [], schedule: null, minConfidence: null, kinds: { person: false, vehicle: true } };
  const judged = judgeDetection(
    settings,
    { kind: "person", bestConfidence: 0.9, bestBox: { x: 0.4, y: 0.4, w: 0.1, h: 0.2 } },
    0.5,
    T0,
  );
  eq(judged, { store: true, hiddenBy: "settings:kind" });

  const present = { current: "present", pendingKind: null, pendingSinceMs: null, lastFrameAtMs: T0, lastAtMs: T0 };
  // The correct caller: hiddenBy !== null means "not evidence" -- no call at all.
  const stillPresent = judged.hiddenBy !== null ? present : advanceOccupancy(present, absence(T0 + 40_000), "person").state;
  eq(stillPresent.current, "present");
  // Contrast: a VISIBLE absence at the same camera really does count, and
  // (given 40s, over the 30s person threshold) flips it.
  const visible = judgeDetection(
    { ...settings, kinds: { person: true, vehicle: true } },
    { kind: "person", bestConfidence: 0.9, bestBox: { x: 0.4, y: 0.4, w: 0.1, h: 0.2 } },
    0.5,
    T0,
  );
  eq(visible.hiddenBy, null);
});

report("zone occupancy");
