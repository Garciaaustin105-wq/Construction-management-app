/**
 * How much a detection's box moves across the frames it was seen in
 * (contracts/boxJitter.ts).
 *
 * Why this exists: a spray bottle on a shelf was reported as a person 77 times
 * in 13 hours. Austin's observation is the discriminator — a person cannot
 * hold still the way an object does. Breathing and postural sway move a human
 * box; a bottle's box only moves by the detector's own noise. So MEASURE the
 * movement, in units that do not depend on how far away the thing is.
 *
 * This module reports numbers and nothing else. No isStatic, no isPerson, no
 * threshold — build rule 11. The number that separates furniture from a person
 * has to come from measuring both on real footage, and until it does, nothing
 * here may pretend to know it.
 *
 * THE FEARED FAILURES: a wobble measured in frame-fractions, so a person at
 * the far end of a room looks stiller than the same person up close (the
 * reading would be about distance, not about movement); one wild mis-detection
 * dragging the answer (build rule 14 — medians, never means); and a number
 * computed from two sightings being quoted as if it meant something.
 */
import { jitterOf, MIN_SIGHTINGS_FOR_JITTER } from "../dist/boxJitter.js";
import { check, eq, report } from "./_assert.mjs";

console.log("box jitter");

const isRefusal = (r) => r !== null && typeof r === "object" && r.ok === false;
/** A box at centre (cx, cy) of size w x h, as the detector reports them. */
const at = (cx, cy, w = 0.2, h = 0.6) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
const still = (n, box = at(0.5, 0.5)) => Array.from({ length: n }, () => ({ ...box }));

check("a box that never moves has no jitter at all", () => {
  const r = jitterOf(still(20));
  eq(isRefusal(r), false, "answered");
  eq(r.sightings, 20, "counted every one");
  eq(r.stepMedian, 0, "typical step between frames");
  eq(r.stepMax, 0, "and the worst step");
  eq(r.spread, 0, "and the total wander");
});

check("THE FEARED ONE: the same wobble reads the same close up and far away", () => {
  // The same movement as a fraction of the thing's own size must give the same
  // number, or the reading is about distance rather than about movement.
  const near = [at(0.50, 0.50, 0.20, 0.60), at(0.52, 0.50, 0.20, 0.60), at(0.50, 0.52, 0.20, 0.60),
    at(0.52, 0.52, 0.20, 0.60), at(0.50, 0.50, 0.20, 0.60), at(0.52, 0.50, 0.20, 0.60)];
  // Half the size, half the movement: the same person twice as far away.
  const far = [at(0.50, 0.50, 0.10, 0.30), at(0.51, 0.50, 0.10, 0.30), at(0.50, 0.51, 0.10, 0.30),
    at(0.51, 0.51, 0.10, 0.30), at(0.50, 0.50, 0.10, 0.30), at(0.51, 0.50, 0.10, 0.30)];
  const a = jitterOf(near);
  const b = jitterOf(far);
  const close = (x, y) => Math.abs(x - y) < 1e-9;
  eq(close(a.stepMedian, b.stepMedian), true, `near ${a.stepMedian} vs far ${b.stepMedian}`);
  eq(close(a.spread, b.spread), true, `spread near ${a.spread} vs far ${b.spread}`);
  eq(a.stepMedian > 0, true, "and it is not zero: something did move");
});

check("THE FEARED ONE: one wild mis-detection does not drag the reading", () => {
  const boxes = still(20);
  boxes[9] = at(0.9, 0.1);                       // the detector jumped across the frame once
  const r = jitterOf(boxes);
  eq(r.stepMedian, 0, "the typical frame is still the typical frame (median, not mean)");
  // Centre (0.5, 0.5) to (0.9, 0.1) is 0.566 of the frame; the box's own
  // diagonal is 0.632; so the step is 0.89 of the thing's own size. Worked by
  // hand rather than guessed — the first version of this check asserted > 1
  // and failed against correct arithmetic.
  eq(Math.abs(r.stepMax - 0.8944) < 0.001, true, `the worst step is reported, not hidden: ${r.stepMax}`);
  eq(Math.abs(r.spread - 0.8944) < 0.001, true, `and so is the total wander: ${r.spread}`);
});

check("a slow drift shows up in the wander even when every single step is tiny", () => {
  // A trolley rolling, or a shadow creeping: each frame barely moves, but it
  // ends up somewhere else. A step-only reading would call this motionless.
  const boxes = Array.from({ length: 21 }, (_, i) => at(0.30 + i * 0.01, 0.5));
  const r = jitterOf(boxes);
  eq(r.stepMedian < 0.06, true, `each step is small: ${r.stepMedian}`);
  eq(r.spread > 0.3, true, `but it travelled: ${r.spread}`);
});

check("size and shape changes are reported separately from position", () => {
  const grow = Array.from({ length: 10 }, (_, i) => at(0.5, 0.5, 0.20 + i * 0.01, 0.60));
  const r = jitterOf(grow);
  eq(r.sizeSpread > 0, true, `the box changed size: ${r.sizeSpread}`);
  eq(r.aspectSpread > 0, true, "and shape");
  const fixed = jitterOf(still(10));
  eq(fixed.sizeSpread, 0, "a box that does not change reports zero");
  eq(fixed.aspectSpread, 0, "on both");
});

check("THE FEARED ONE: too few sightings is refused, never answered with a number", () => {
  eq(MIN_SIGHTINGS_FOR_JITTER, 5, "the floor itself");
  for (const n of [0, 1, 2, 3, 4]) {
    const r = jitterOf(still(n));
    eq(isRefusal(r), true, `${n} sightings`);
    eq(r.reason, "too_few_sightings", "says why");
    eq(r.sightings, n, "and how many there were");
  }
  eq(isRefusal(jitterOf(still(5))), false, "five is enough");
});

check("a box the page cannot read is refused rather than counted as not moving", () => {
  for (const bad of [
    [...still(6), { x: 0.1, y: 0.1, w: 0.1 }],
    [...still(6), { x: NaN, y: 0.1, w: 0.1, h: 0.1 }],
    [...still(6), null],
    [...still(6), "nope"],
    [...still(6), { x: 0.1, y: 0.1, w: 0, h: 0.1 }],
  ]) {
    const r = jitterOf(bad);
    eq(isRefusal(r), true, `unreadable box: ${JSON.stringify(bad.at(-1))}`);
    eq(r.reason, "unreadable_box", "says why");
  }
  eq(isRefusal(jitterOf("not an array")), true, "not a list at all");
});

check("it reports measurements and states no verdict", () => {
  const r = jitterOf(still(10));
  const keys = Object.keys(r).sort();
  eq(keys, ["aspectSpread", "ok", "sightings", "sizeSpread", "spread", "stepMax", "stepMedian"], "the whole answer");
  for (const k of keys) {
    eq(/static|person|furniture|suppress|real|fake/i.test(k), false, `${k} is a measurement, not a judgement`);
  }
});

report("box jitter");
