/**
 * Following the same thing from frame to frame (contracts/trackBoxes.ts).
 *
 * This exists because of a measurement I got wrong. Analysing a street, I
 * chained each detection to the last box it overlapped. With one bottle in an
 * empty room that is fine. With seven parked cars it is not: a "track" walked
 * across the frame and reported a wander of 5.78 — not an object moving, but
 * two different cars stitched together. Numbers computed that way are the
 * method's noise, not the scene's, and a threshold tuned on them would be
 * tuned on a bug.
 *
 * THE FEARED FAILURES:
 * - two things passing each other and swapping identities, so both appear to
 *   have leapt across the frame;
 * - a track whose own detection is missing for one frame grabbing whatever
 *   else is nearby;
 * - first-come-first-served matching taking a poor pair when a better pairing
 *   of the same boxes exists;
 * - one flicker in the detector splitting a single object into several short
 *   tracks, which makes everything look briefer and jumpier than it is.
 */
import { trackBoxes, MIN_MATCH_IOU, MAX_STEP_DIAGONALS, MAX_MISSES } from "../dist/trackBoxes.js";
import { check, eq, report } from "./_assert.mjs";

console.log("track boxes");

const det = (kind, x, y, w = 0.1, h = 0.2, confidence = 0.9) => ({ kind, confidence, box: { x, y, w, h } });
/** Frames from a list of per-frame detection arrays. */
const frames = (...perFrame) => perFrame.map((detections, frame) => ({ frame, detections }));

check("one thing standing still is one track, not many", () => {
  const out = trackBoxes(frames(...Array.from({ length: 10 }, () => [det("person", 0.4, 0.4)])));
  eq(out.length, 1, "one track");
  eq(out[0].boxes.length, 10, "with every sighting");
  eq(out[0].kind, "person", "and its kind");
  eq(out[0].firstFrame, 0, "from the first frame");
  eq(out[0].lastFrame, 9, "to the last");
});

check("THE FEARED ONE: two things passing each other do not swap identities", () => {
  // A walks left to right; B walks right to left; they cross in the middle.
  // A tracker that matches on overlap alone will hand each one the other's
  // history at the crossing, and both will appear to have jumped.
  const f = [];
  for (let i = 0; i < 11; i++) {
    const a = 0.1 + i * 0.06;
    const b = 0.7 - i * 0.06;
    f.push([det("person", a, 0.5), det("person", b, 0.5)]);
  }
  const out = trackBoxes(frames(...f));
  eq(out.length, 2, `two tracks, got ${out.length}`);
  for (const t of out) {
    // Each track must move steadily in ONE direction. A swap shows up as the
    // x sequence reversing.
    const xs = t.boxes.map((b) => b.x);
    const rising = xs.every((v, i) => i === 0 || v >= xs[i - 1] - 1e-9);
    const falling = xs.every((v, i) => i === 0 || v <= xs[i - 1] + 1e-9);
    eq(rising || falling, true, `a track reversed direction: ${xs.map((v) => v.toFixed(2)).join(" ")}`);
  }
});

check("THE FEARED ONE: a track never teleports to something far away", () => {
  eq(MAX_STEP_DIAGONALS, 1, "the limit, in diagonals of the thing's own box");
  // One object vanishes; a different one appears across the frame. They are
  // not the same thing, however lonely the tracker feels.
  const out = trackBoxes(frames(
    [det("person", 0.1, 0.5)],
    [det("person", 0.1, 0.5)],
    [det("person", 0.8, 0.5)],
    [det("person", 0.8, 0.5)],
  ));
  eq(out.length, 2, `two separate tracks, got ${out.length}`);
  eq(out[0].boxes.length, 2, "the first ends");
  eq(out[1].boxes.length, 2, "the second begins");
});

check("THE FEARED ONE: the best pairing wins, not the first one tried", () => {
  // Two tracks, two detections. Taking them in order pairs each with the
  // WRONG one at a mediocre overlap; the better pairing is obvious.
  const near = det("person", 0.30, 0.50);
  const far = det("person", 0.42, 0.50);
  const out = trackBoxes(frames(
    [near, far],
    [near, far],
    // Now they move slightly, and the list order is reversed to try to fool
    // an order-dependent matcher.
    [det("person", 0.425, 0.50), det("person", 0.305, 0.50)],
  ));
  eq(out.length, 2, "still two");
  for (const t of out) {
    const xs = t.boxes.map((b) => b.x);
    const moved = Math.abs(xs[xs.length - 1] - xs[0]);
    eq(moved < 0.02, true, `a track was handed the other one's box: moved ${moved.toFixed(3)}`);
  }
});

check("a flicker does not split one thing into several", () => {
  eq(MAX_MISSES >= 2, true, `a track survives a short gap: ${MAX_MISSES}`);
  const here = [det("person", 0.4, 0.4)];
  const out = trackBoxes(frames(here, here, [], here, here));
  eq(out.length, 1, "one track across the dropped frame");
  eq(out[0].boxes.length, 4, "four sightings");
  eq(out[0].misses, 1, "and it says it lost the thing once");
});

check("a long absence ends the track rather than resuming it later", () => {
  const here = [det("person", 0.4, 0.4)];
  const gap = Array.from({ length: MAX_MISSES + 1 }, () => []);
  const out = trackBoxes(frames(here, here, ...gap, here, here));
  eq(out.length, 2, `the thing that came back is a new track, got ${out.length}`);
});

check("kinds never mix", () => {
  const out = trackBoxes(frames(
    [det("person", 0.4, 0.4), det("vehicle", 0.41, 0.41)],
    [det("person", 0.4, 0.4), det("vehicle", 0.41, 0.41)],
    [det("person", 0.4, 0.4), det("vehicle", 0.41, 0.41)],
  ));
  eq(out.length, 2, "two tracks");
  eq(out.map((t) => t.kind).sort(), ["person", "vehicle"], "one of each");
  for (const t of out) eq(t.boxes.length, 3, `${t.kind} kept all three`);
});

check("things that barely overlap are not the same thing", () => {
  eq(MIN_MATCH_IOU > 0, true, "there is a floor");
  const out = trackBoxes(frames(
    [det("person", 0.40, 0.40, 0.10, 0.20)],
    // Shifted by most of its own width: overlap below the floor.
    [det("person", 0.49, 0.40, 0.10, 0.20)],
  ));
  eq(out.length, 2, "two tracks rather than one big jump");
});

check("the answer does not depend on the order the detector listed them", () => {
  const a = det("person", 0.20, 0.30);
  const b = det("person", 0.60, 0.70);
  const one = trackBoxes(frames([a, b], [a, b], [a, b]));
  const other = trackBoxes(frames([b, a], [b, a], [b, a]));
  const shape = (out) => out.map((t) => [t.kind, t.boxes.length, t.boxes[0].x]).sort();
  eq(shape(one), shape(other), "same tracks either way round");
});

check("rubbish in is refused, not tracked", () => {
  for (const bad of [null, "nope", 42, [{ frame: 0, detections: "no" }], [{ detections: [] }]]) {
    let threw = false;
    try { trackBoxes(bad); } catch { threw = true; }
    eq(threw, true, `refused ${JSON.stringify(bad)}`);
  }
  eq(trackBoxes([]).length, 0, "no frames is no tracks, not an error");
});

report("track boxes");
