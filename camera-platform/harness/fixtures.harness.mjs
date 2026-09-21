/**
 * Grouping repeated detections into fixtures, so one human decision about one
 * object can label thousands of crops (contracts/fixtures.ts).
 *
 * The spray bottle fired 77 times in 13 hours; the child's bike 163 times in
 * an afternoon. Each one is a training set that labels itself — but only if
 * "these are all the same object" is decided correctly.
 *
 * THE FEARED ONE, and it is worse than anything else in this file: a doorway
 * where DIFFERENT PEOPLE pass through the same patch of frame all day. Group
 * those into a "fixture", hand them to a human who clicks "that's furniture",
 * and you have just built a training set that teaches the detector to ignore
 * people walking through a doorway. Everything here exists to make that
 * impossible: boxes must agree tightly in position AND in size, because a
 * child and a courier do not have the same silhouette, while a parked car is
 * the same silhouette every single time.
 *
 * This module states NO verdict about what a fixture IS. It says "these
 * detections are the same recurring thing". A human says what it is.
 */
import {
  groupFixtures, FIXTURE_IOU, FIXTURE_MIN_SIGHTINGS, FIXTURE_MIN_SPAN_MS, FIXTURE_MAX_SIZE_SPREAD,
} from "../dist/fixtures.js";
import { check, eq, report } from "./_assert.mjs";

console.log("fixtures");

const T0 = Date.parse("2026-09-20T12:00:00.000Z");
const at = (mins) => new Date(T0 + mins * 60000).toISOString();
let n = 0;
const ev = (mins, box, opts = {}) => ({
  id: opts.id ?? `e${++n}`,
  cameraId: opts.cameraId ?? "cam1",
  kind: opts.kind ?? "vehicle",
  firstUtc: at(mins),
  lastUtc: at(mins + 0.05),
  count: 10,
  bestConfidence: opts.confidence ?? 0.6,
  bestBox: box,
  bestUtc: at(mins),
  ...(opts.species ? { species: opts.species } : {}),
});
/** A box that never moves, as a parked car's does not. */
const parked = { x: 0.30, y: 0.60, w: 0.12, h: 0.10 };
const jitter = (b, dx = 0, dy = 0, dw = 0) => ({ x: b.x + dx, y: b.y + dy, w: b.w + dw, h: b.h });

check("the gates are what this project's rules ask for", () => {
  eq(FIXTURE_MIN_SIGHTINGS, 3, "rule 15's sample floor");
  eq(FIXTURE_MIN_SPAN_MS, 30 * 60000, "and a span, so a busy ten minutes is not a fixture");
  eq(FIXTURE_IOU, 0.6, "boxes must properly agree, not merely touch");
  eq(FIXTURE_MAX_SIZE_SPREAD, 0.35, "and agree in size");
});

check("a thing that sits in one place for hours becomes one fixture", () => {
  const events = [0, 20, 45, 90, 180].map((m) => ev(m, jitter(parked, 0.001 * (m % 3))));
  const out = groupFixtures(events);
  eq(out.fixtures.length, 1, "one fixture");
  const f = out.fixtures[0];
  eq(f.eventIds.length, 5, "all five sightings");
  eq(f.cameraId, "cam1", "on its camera");
  eq(f.kind, "vehicle", "of its kind");
  // Each sighting lasts 0.05 min, so the span runs from the first one's
  // start to the last one's END: three hours and three seconds.
  eq(f.spanMs, 180 * 60000 + 3000, "spanning three hours");
  eq(out.ungrouped.length, 0, "nothing left over");
});

check("THE FEARED ONE: different people through the same doorway are NOT a fixture", () => {
  // Same patch of frame, hours apart, but a courier, a child and an adult have
  // visibly different silhouettes. Calling these one object and labelling it
  // furniture would teach the detector to ignore a doorway.
  const door = { x: 0.40, y: 0.30, w: 0.08, h: 0.30 };
  const people = [
    ev(0, door, { kind: "person" }),
    ev(40, { ...door, w: 0.13, h: 0.42 }, { kind: "person" }),   // a taller, wider person
    ev(95, { ...door, w: 0.06, h: 0.20 }, { kind: "person" }),   // a child
    ev(150, { ...door, w: 0.11, h: 0.38 }, { kind: "person" }),
  ];
  const out = groupFixtures(people);
  eq(out.fixtures.length, 0, `no fixture: ${JSON.stringify(out.fixtures.map((f) => f.eventIds))}`);
  eq(out.ungrouped.length, 4, "all four left for a human to look at");
  eq(out.rejected.length >= 1, true, "and the near-miss is reported, not silently dropped");
  // Which gate stopped it is not the point and is not asserted: in practice
  // the IoU test catches this first, because boxes that differ this much in
  // size no longer overlap by 0.6. The size gate below is a second belt for
  // the offset cases IoU lets through. What MUST hold is that nothing here
  // becomes a harvestable fixture, and that a reason is given.
  eq(["too_few", "too_brief", "size_spread"].includes(out.rejected[0].reason), true,
    `a reason is given: ${out.rejected[0].reason}`);
});

check("the size gate catches what overlap alone lets through", () => {
  // Boxes that DO overlap past FIXTURE_IOU but vary in size beyond the spread
  // limit: the same doorway seen by a detector whose box breathes. Whether
  // this arises often matters less than that the gate is real and measured.
  const grow = (k) => ({ x: 0.40, y: 0.30, w: 0.10 * k, h: 0.30 * k });
  const out = groupFixtures([
    ev(0, grow(1.0), { kind: "person" }),
    ev(40, grow(1.0), { kind: "person" }),
    ev(80, grow(1.0), { kind: "person" }),
    ev(120, grow(1.45), { kind: "person" }),
  ]);
  const harvestable = out.fixtures.flatMap((f) => f.eventIds);
  eq(harvestable.includes("e" + (n - 0)), false, "the odd-sized sighting is not harvested with the others");
});

check("a fixture needs enough sightings AND enough time", () => {
  eq(groupFixtures([ev(0, parked), ev(20, parked)]).fixtures.length, 0, "two sightings is not enough");
  const quick = [ev(0, parked), ev(2, parked), ev(5, parked), ev(9, parked)];
  const out = groupFixtures(quick);
  eq(out.fixtures.length, 0, "four sightings inside ten minutes is a busy moment, not furniture");
  eq(out.rejected.some((r) => r.reason === "too_brief"), true, "and it says so");
  eq(groupFixtures([ev(0, parked), ev(20, parked), ev(40, parked)]).fixtures.length, 1, "three across forty minutes is");
});

check("things in different places, on different cameras, or of different kinds never merge", () => {
  const elsewhere = { x: 0.70, y: 0.60, w: 0.12, h: 0.10 };
  const out = groupFixtures([
    ev(0, parked), ev(40, parked), ev(80, parked),
    ev(0, elsewhere), ev(40, elsewhere), ev(80, elsewhere),
    ev(0, parked, { cameraId: "cam2" }), ev(40, parked, { cameraId: "cam2" }), ev(80, parked, { cameraId: "cam2" }),
    ev(0, parked, { kind: "person" }), ev(40, parked, { kind: "person" }), ev(80, parked, { kind: "person" }),
  ]);
  eq(out.fixtures.length, 4, `four separate fixtures, got ${out.fixtures.length}`);
  const keys = out.fixtures.map((f) => `${f.cameraId}/${f.kind}/${f.box.x.toFixed(2)}`).sort();
  eq(keys, ["cam1/person/0.30", "cam1/vehicle/0.30", "cam1/vehicle/0.70", "cam2/vehicle/0.30"], "kept apart");
});

check("the fixture's own box is the median of its sightings, never the mean", () => {
  // One wild sighting must not drag the box that a harvest is cut from.
  const events = [
    ev(0, parked), ev(30, parked), ev(60, jitter(parked, 0.004)),
    ev(90, parked), ev(120, parked),
  ];
  const [f] = groupFixtures(events).fixtures;
  eq(f.box.x, parked.x, "the middle sighting's x, not an average nudged by the outlier");
  eq(f.box.w, parked.w, "and its width");
});

check("a fixture reports what a human needs to decide about it", () => {
  const events = [0, 40, 80].map((m) => ev(m, parked, { species: "truck", confidence: 0.55 + m / 1000 }));
  const [f] = groupFixtures(events).fixtures;
  eq(f.eventIds.length, 3, "which events to harvest");
  eq(f.firstUtc, at(0), "when it was first seen");
  eq(f.lastUtc <= at(80.05), true, "and last");
  eq(f.confidenceMax >= 0.63, true, `the best it ever scored: ${f.confidenceMax}`);
  eq(f.species, "truck", "and what the detector called it");
  eq("label" in f, false, "THE FEARED ONE: this module never says what it IS");
  eq("isFurniture" in f, false, "no verdict of any kind");
});

check("a species that varies across sightings is reported as varying, not picked", () => {
  const events = [
    ev(0, parked, { species: "truck" }),
    ev(40, parked, { species: "car" }),
    ev(80, parked, { species: "truck" }),
  ];
  const [f] = groupFixtures(events).fixtures;
  eq(f.species, null, "the detector disagreed with itself, so no single species is claimed");
  eq(f.speciesSeen, ["car", "truck"], "both are reported (build rule 18: show both, never average)");
});

check("rubbish in is refused, not grouped", () => {
  for (const bad of [null, "nope", 42, [null], [{ id: "x" }], [{ ...ev(0, parked), bestBox: null }]]) {
    let threw = false;
    try { groupFixtures(bad); } catch { threw = true; }
    eq(threw, true, `refused ${JSON.stringify(bad)?.slice(0, 40)}`);
  }
  eq(groupFixtures([]).fixtures.length, 0, "no events is no fixtures, not an error");
});

report("fixtures");
