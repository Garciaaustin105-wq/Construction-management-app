/**
 * proposeTeachMoments and parseDay (contracts/teachCandidates.ts), against the
 * failures TEACH-LIST-SPEC.md names directly: a miss hides only in movement,
 * so motion with no event is proposed and ranks first; a minute with no gate
 * data is never called quiet; a hidden event still counts as stored, but is
 * itself proposed and flagged; nothing overlaps the library; nothing without
 * whole footage; the cap and its omitted counts; the merge.
 */
import { proposeTeachMoments, parseDay, MAX_MOMENTS } from "../dist/teachCandidates.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("teach candidates");

const CAM = "cam-1";
const OTHER_CAM = "cam-2";
const T0 = Date.parse("2026-09-20T00:00:00.000Z");
const minuteIso = (i) => new Date(T0 + i * 60_000).toISOString();

function gateWindow(minuteIndex, { motion = 0, frames = 20, looked, cameraId = CAM } = {}) {
  const reasons = {};
  if (motion > 0) reasons.motion = motion;
  return { cameraId, atUtc: minuteIso(minuteIndex), windowS: 60, frames, looked: looked ?? motion, reasons };
}

function personEvent(id, minuteIndex, { suppressedBy = null, count = 3, bestConfidence = 0.8 } = {}) {
  return {
    id,
    cameraId: CAM,
    kind: "person",
    firstUtc: minuteIso(minuteIndex),
    lastUtc: minuteIso(minuteIndex),
    count,
    bestConfidence,
    bestUtc: minuteIso(minuteIndex),
    suppressedBy,
  };
}

function footageThrough(endMinute) {
  return [{ startUtc: minuteIso(0), endUtc: minuteIso(endMinute) }];
}

function input(over) {
  return {
    cameraId: CAM,
    dayStartUtc: minuteIso(0),
    dayEndUtc: minuteIso(60),
    nowUtc: minuteIso(60),
    gateWindows: [],
    events: [],
    library: { version: 1, clips: [] },
    footage: footageThrough(60),
    ...over,
  };
}

/* ---------------- moved_nothing_stored: the moment a miss hides in ---------------- */

check("a miss hides only in movement: motion with no event is proposed, adjacent minutes merge, a run over 5 minutes splits", () => {
  const gateWindows = [];
  for (let m = 0; m <= 6; m += 1) gateWindows.push(gateWindow(m, { motion: 10, frames: 20 }));
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(10), nowUtc: minuteIso(10), footage: footageThrough(10), gateWindows }));
  eq(result.moments.length, 2, "two runs: 5 minutes then the 2-minute remainder");
  same(result.moments[0], {
    kind: "moved_nothing_stored", cameraId: CAM,
    startUtc: minuteIso(0), endUtc: minuteIso(5),
    stillAtUtc: minuteIso(2.5),
    evidence: { frames: 100, motionLooks: 50 },
  }, "first run: minutes 0-4, capped at 5");
  same(result.moments[1], {
    kind: "moved_nothing_stored", cameraId: CAM,
    startUtc: minuteIso(5), endUtc: minuteIso(7),
    stillAtUtc: minuteIso(6),
    evidence: { frames: 40, motionLooks: 20 },
  }, "the remainder: minutes 5-6, its own moment rather than dropped");
  eq(result.notes.some((n) => n.includes("3 of 10 minute(s) had no gate data")), true, "minutes 7,8,9 were never reported by the gate");
});

check("a stored event -- even hidden -- counts as stored, so its minute is not moved_nothing_stored, and it is proposed as person_stored, flagged", () => {
  const gateWindows = [
    gateWindow(0, { motion: 15, frames: 30 }),
    gateWindow(2, { motion: 12, frames: 24 }),
  ];
  const events = [personEvent("ev-1", 2, { suppressedBy: "obj-1", count: 4, bestConfidence: 0.61 })];
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(5), nowUtc: minuteIso(5), footage: footageThrough(5), gateWindows, events }));
  const moved = result.moments.filter((m) => m.kind === "moved_nothing_stored");
  const person = result.moments.filter((m) => m.kind === "person_stored");
  eq(moved.length, 1, "only minute 0 -- minute 2 is covered by the hidden event");
  same(moved[0], {
    kind: "moved_nothing_stored", cameraId: CAM,
    startUtc: minuteIso(0), endUtc: minuteIso(1), stillAtUtc: minuteIso(0.5),
    evidence: { frames: 30, motionLooks: 15 },
  }, "minute 0 alone");
  eq(person.length, 1, "the hidden event is still proposed -- exactly the false people worth a nobody answer");
  same(person[0], {
    kind: "person_stored", cameraId: CAM,
    startUtc: new Date(Date.parse(minuteIso(2)) - 10_000).toISOString(),
    endUtc: new Date(Date.parse(minuteIso(2)) + 10_000).toISOString(),
    stillAtUtc: minuteIso(2),
    evidence: { bestConfidence: 0.61, sightings: 4, hidden: true },
  }, "padded +/-10s, flagged hidden, its own best moment for the still");
});

check("FEARED (boundary): an event starting exactly when a minute ENDS does not strike out that minute -- overlap is half-open", () => {
  // Minute 0 is [minuteIso(0), minuteIso(1)). An event starting exactly AT
  // minuteIso(1) belongs to minute 1, not minute 0: the closed `<=` this
  // guards against would have called minute 0 "covered" too, on an instant
  // that is not actually inside it.
  const gateWindows = [gateWindow(0, { motion: 10, frames: 20 })];
  const events = [personEvent("ev-boundary", 1, { suppressedBy: null, count: 2, bestConfidence: 0.5 })];
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(2), nowUtc: minuteIso(2), footage: footageThrough(2), gateWindows, events }));
  const moved = result.moments.filter((m) => m.kind === "moved_nothing_stored");
  eq(moved.length, 1, "minute 0's motion is still proposed -- the event at its far boundary does not reach back into it");
  same(moved[0], {
    kind: "moved_nothing_stored", cameraId: CAM,
    startUtc: minuteIso(0), endUtc: minuteIso(1), stillAtUtc: minuteIso(0.5),
    evidence: { frames: 20, motionLooks: 10 },
  }, "minute 0 alone, unmerged with minute 1 (minute 1 has no gate window here)");
});

check("the SAME instant that spares minute 0 still strikes out minute 1 -- the start edge stays closed, only the end opened", () => {
  // The mirror case: startMs is compared with `e.lastMs >= startMs`, which
  // this fix does not touch, so an event AT a minute's own start still
  // counts as touching it. ev-start-edge sits at minuteIso(1) -- the exact
  // instant the check above proved does NOT belong to minute 0 -- and this
  // proves it DOES belong to minute 1, whose window starts there.
  const gateWindows = [gateWindow(1, { motion: 10, frames: 20 })];
  const events = [personEvent("ev-start-edge", 1, { suppressedBy: null, count: 1, bestConfidence: 0.5 })];
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(2), nowUtc: minuteIso(2), footage: footageThrough(2), gateWindows, events }));
  const moved = result.moments.filter((m) => m.kind === "moved_nothing_stored");
  eq(moved.length, 0, "minute 1 is struck out: the event touches its start instant");
});

check("a not-hidden person event is proposed unflagged", () => {
  const events = [personEvent("ev-2", 20, { suppressedBy: null, count: 1, bestConfidence: 0.9 })];
  const result = proposeTeachMoments(input({ events }));
  const person = result.moments.filter((m) => m.kind === "person_stored");
  eq(person.length, 1, "one person event");
  eq(person[0].evidence.hidden, false, "not suppressed, not flagged");
});

/* ---------------- quiet: never from a minute the gate never reported ---------------- */

check("FEARED: a 5-minute block with one minute missing is never called quiet", () => {
  const gateWindows = [gateWindow(0), gateWindow(1), gateWindow(3), gateWindow(4)]; // minute 2 absent
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(5), nowUtc: minuteIso(5), footage: footageThrough(5), gateWindows }));
  eq(result.moments.filter((m) => m.kind === "quiet").length, 0, "one missing minute breaks the whole block");
  eq(result.notes.some((n) => n.includes("1 of 5 minute(s) had no gate data")), true);
});

check("a whole 5-minute block with gate data, no motion and no events is proposed quiet", () => {
  const gateWindows = [0, 1, 2, 3, 4].map((m) => gateWindow(m));
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(5), nowUtc: minuteIso(5), footage: footageThrough(5), gateWindows }));
  const quiet = result.moments.filter((m) => m.kind === "quiet");
  eq(quiet.length, 1, "the whole library is empty, so a full hour is still needed");
  same(quiet[0], {
    kind: "quiet", cameraId: CAM,
    startUtc: minuteIso(0), endUtc: minuteIso(5), stillAtUtc: minuteIso(2.5),
    evidence: { minutes: 5 },
  });
});

check("quiet proposes only as many as the library's empty-scene total still needs, spread across the day", () => {
  // 24 valid quiet blocks (2 hours); the library already holds 55 empty
  // minutes, so 5 more (one block) closes the 60-minute (MIN_GATE_EMPTY_HOURS) gap.
  const gateWindows = [];
  for (let m = 0; m < 120; m += 1) gateWindows.push(gateWindow(m));
  const library = {
    version: 1,
    clips: [{
      id: "c1", cameraId: OTHER_CAM,
      startUtc: "2026-01-01T00:00:00.000Z", endUtc: "2026-01-01T00:55:00.000Z",
      scenes: ["empty"], expected: [],
    }],
  };
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(120), nowUtc: minuteIso(120), footage: footageThrough(120), gateWindows, library }));
  const quiet = result.moments.filter((m) => m.kind === "quiet");
  eq(quiet.length, 1, "only one more 5-minute block was needed to reach the hour");
  // spread, not the first one found
  const startsAtBlockZero = quiet[0].startUtc === minuteIso(0);
  eq(startsAtBlockZero, false, "spread across the day, not clustered at the start");
  eq(result.notes.some((n) => n.includes("23 more quiet 5-minute span(s) were available but not needed")), true);
});

/* ---------------- nothing overlapping the library, nothing without footage ---------------- */

check("FEARED: nothing overlapping an existing library clip is proposed", () => {
  const gateWindows = [gateWindow(0, { motion: 5, frames: 10 })];
  const library = {
    version: 1,
    clips: [{ id: "c1", cameraId: CAM, startUtc: minuteIso(0), endUtc: minuteIso(1), scenes: ["person"], expected: [{ kind: "person", fromUtc: minuteIso(0), toUtc: minuteIso(1), count: 1 }] }],
  };
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(2), nowUtc: minuteIso(2), footage: footageThrough(2), gateWindows, library }));
  eq(result.moments.length, 0, "already answered for");
  eq(result.notes.some((n) => n.includes('already covered by an existing "Teach the AI" clip')), true);
});

check("a library clip on a DIFFERENT camera does not exclude this camera's moment", () => {
  const gateWindows = [gateWindow(0, { motion: 5, frames: 10 })];
  const library = {
    version: 1,
    clips: [{ id: "c1", cameraId: OTHER_CAM, startUtc: minuteIso(0), endUtc: minuteIso(1), scenes: ["person"], expected: [{ kind: "person", fromUtc: minuteIso(0), toUtc: minuteIso(1), count: 1 }] }],
  };
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(2), nowUtc: minuteIso(2), footage: footageThrough(2), gateWindows, library }));
  eq(result.moments.length, 1, "a clip elsewhere says nothing about this camera's footage");
});

check("FEARED: a moment whose footage is only partly recorded is never proposed", () => {
  const gateWindows = [gateWindow(0, { motion: 5, frames: 10 })];
  // The minute is [0,1); footage stops half way through it.
  const footage = [{ startUtc: minuteIso(0), endUtc: new Date(T0 + 30_000).toISOString() }];
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(2), nowUtc: minuteIso(2), footage, gateWindows }));
  eq(result.moments.length, 0, "partly gone is gone");
  eq(result.notes.some((n) => n.includes("footage is gone or only partly recorded")), true);
});

check("footage entirely missing for the span is never proposed", () => {
  const gateWindows = [gateWindow(0, { motion: 5, frames: 10 })];
  const result = proposeTeachMoments(input({ dayEndUtc: minuteIso(2), nowUtc: minuteIso(2), footage: [], gateWindows }));
  eq(result.moments.length, 0);
});

/* ---------------- the cap, in priority order, with omitted counts ---------------- */

check("FEARED: the 40-moment cap keeps the highest-value kind first and reports what it left out, per kind", () => {
  const gateWindows = [];
  // 45 single-minute motion candidates, never adjacent (a quiet gap minute
  // between each would itself need gate data to merge/interfere; leaving it
  // absent keeps it out of both motion and quiet without extra bookkeeping).
  for (let i = 0; i < 45; i += 1) gateWindows.push(gateWindow(2 * i, { motion: 3, frames: 6 }));
  const events = [personEvent("ev-far", 150, { suppressedBy: null })];
  const result = proposeTeachMoments(input({
    dayEndUtc: minuteIso(200), nowUtc: minuteIso(200), footage: footageThrough(200), gateWindows, events,
  }));
  eq(result.moments.length, MAX_MOMENTS, "capped at 40");
  eq(result.moments.every((m) => m.kind === "moved_nothing_stored"), true, "the higher-value kind fills the cap first");
  eq(result.moments[39].startUtc, minuteIso(2 * 39), "chronological order, the 40th of the 45");
  same(result.omitted, { moved_nothing_stored: 5, person_stored: 1, quiet: 0 }, "left out per kind: 45-40 moved, the one person candidate entirely, no quiet candidates existed at all");
  eq(result.notes.some((n) => n.includes("the 40-moment cap left out 5 moved_nothing_stored, 1 person_stored, 0 quiet")), true);
});

/* ---------------- now clips the day: nothing from a minute that has not happened ---------------- */

check("nowUtc partway through the day clips evaluation there -- no note about minutes that simply have not happened yet", () => {
  const gateWindows = [];
  for (let m = 0; m < 60; m += 1) gateWindows.push(gateWindow(m, { motion: 2, frames: 4 })); // whole hour supplied
  const result = proposeTeachMoments(input({
    dayStartUtc: minuteIso(0), dayEndUtc: minuteIso(60), nowUtc: minuteIso(30),
    footage: footageThrough(60), gateWindows,
  }));
  eq(result.notes.some((n) => n.includes("had no gate data")), false, "every evaluated minute (0..29) had data");
  const moved = result.moments.filter((m) => m.kind === "moved_nothing_stored");
  eq(moved.length, 6, "30 minutes of motion, merged 5 at a time");
  eq(moved[5].endUtc, minuteIso(30), "nothing proposed at or after now");
});

/* ---------------- parseDay ---------------- */

check("parseDay: a real UTC day, midnight to midnight", () => {
  same(parseDay("2026-09-20"), { ok: true, dayStartUtc: "2026-09-20T00:00:00.000Z", dayEndUtc: "2026-09-21T00:00:00.000Z" });
  same(parseDay("2028-02-29"), { ok: true, dayStartUtc: "2028-02-29T00:00:00.000Z", dayEndUtc: "2028-03-01T00:00:00.000Z" }, "a real leap day");
});

check("parseDay: refuses blank, malformed and non-existent dates as values, never a throw", () => {
  for (const bad of [null, undefined, ""]) {
    const r = parseDay(bad);
    eq(r.ok, false, `blank ${JSON.stringify(bad)}`);
    eq(r.code, "bad_day");
  }
  for (const bad of ["2026-9-1", "20260920", "2026/09/20", "not-a-day", "2026-09-20T00:00:00Z"]) {
    eq(parseDay(bad).ok, false, `malformed: ${bad}`);
  }
  eq(parseDay("2026-02-30").ok, false, "February has no 30th");
  eq(parseDay("2026-13-01").ok, false, "no month 13");
});

report("teach candidates");
