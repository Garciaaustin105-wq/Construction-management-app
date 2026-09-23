// harness/detection.harness.mjs — contracts/detection.ts
//
// FEARED: two people at once folded into one event (the second never shown);
// a detector glitch stored as if it were real; ten minutes of one person
// becoming thousands of events.

import { check, eq, report } from "./_assert.mjs";
import {
  EVENT_KINDS, MERGE_GAP_MS, MERGE_MIN_IOU,
  normalisePlate, checkDetection, iou, foldDetections, matchScore,
  SPECIES_OF_KIND, speciesOf, travelFrom,
} from "../dist/detection.js";

console.log("detection");

const T0 = Date.parse("2026-09-16T03:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const box = (x, y, w = 0.1, h = 0.3) => ({ x, y, w, h });
const person = (ms, b, confidence = 0.8, cameraId = "cam1") =>
  ({ cameraId, atUtc: at(ms), kind: "person", confidence, box: b });
const plate = (ms, text, b, confidence = 0.9) =>
  ({ cameraId: "gate", atUtc: at(ms), kind: "plate", confidence, box: b, plate: text });

check("constants", () => {
  eq(MERGE_GAP_MS, 10000);
  eq(MERGE_MIN_IOU, 0.3);
  eq([...EVENT_KINDS], ["person", "vehicle", "plate"]);
});

check("normalisePlate", () => {
  eq(normalisePlate("abc-123"), "ABC123");
  eq(normalisePlate(" 7 xk. 42 "), "7XK42");
  eq(normalisePlate("A"), null);
  eq(normalisePlate("ABCDEFGHIJK"), null);
  eq(normalisePlate("AB#12"), null);
  eq(normalisePlate(""), null);
  eq(normalisePlate(42), null);
  eq(normalisePlate(null), null);
});

check("iou", () => {
  eq(iou(box(0, 0, 0.2, 0.2), box(0, 0, 0.2, 0.2)), 1);
  eq(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.1, 0.1)), 0);
  // touching edges share no area
  eq(iou(box(0, 0, 0.1, 0.1), box(0.1, 0, 0.1, 0.1)), 0);
  const half = iou(box(0, 0, 0.2, 0.2), box(0.1, 0, 0.2, 0.2));
  if (Math.abs(half - 1 / 3) > 1e-9) throw new Error(`half overlap iou ${half}`);
});

check("a good detection is copied, not returned by reference", () => {
  const raw = person(0, box(0.1, 0.1));
  const r = checkDetection(raw);
  eq(r.ok, true);
  eq(r.detection, raw);
  if (r.detection === raw || r.detection.box === raw.box) throw new Error("returned the caller's object");
  eq(Object.keys(r.detection).sort(), ["atUtc", "box", "cameraId", "confidence", "kind"]);
});

check("a plate detection is normalised", () => {
  const r = checkDetection(plate(0, "abc 123", box(0.4, 0.6, 0.1, 0.05)));
  eq(r.ok, true);
  eq(r.detection.plate, "ABC123");
});

check("glitches are refused with a reason", () => {
  const good = person(0, box(0.1, 0.1));
  const refuse = (raw, reason) => eq(checkDetection(raw), { ok: false, reason });
  refuse(null, "not_an_object");
  refuse([good], "not_an_object");
  refuse("person", "not_an_object");
  refuse({ ...good, cameraId: "" }, "bad_camera");
  refuse({ ...good, atUtc: "yesterday-ish" }, "bad_time");
  refuse({ ...good, kind: "intruder" }, "bad_kind");
  refuse({ ...good, confidence: 7 }, "bad_confidence");
  refuse({ ...good, confidence: -0.1 }, "bad_confidence");
  refuse({ ...good, confidence: NaN }, "bad_confidence");
  refuse({ ...good, confidence: "0.9" }, "bad_confidence");
  refuse({ ...good, box: box(0.95, 0.1, 0.1, 0.1) }, "bad_box");
  refuse({ ...good, box: box(-0.01, 0.1) }, "bad_box");
  refuse({ ...good, box: box(0.1, 0.1, 0, 0.1) }, "bad_box");
  refuse({ ...good, box: { x: 0.1, y: 0.1, w: 0.1 } }, "bad_box");
  refuse({ ...good, box: null }, "bad_box");
  refuse({ ...good, plate: "ABC123" }, "plate_on_non_plate");
  refuse(plate(0, "!", box(0.1, 0.1)), "bad_plate");
  refuse({ ...plate(0, "X", box(0.1, 0.1)), plate: undefined }, "bad_plate");
  // a box that ends exactly at the edge is fine (float noise allowed)
  eq(checkDetection({ ...good, box: box(0.7, 0.7, 0.3, 0.3) }).ok, true);
});

check("FEARED: two people in different parts of the frame at once are two events", () => {
  const ds = [];
  for (let i = 0; i < 50; i++) {
    ds.push(person(i * 200, box(0.1, 0.2)));
    ds.push(person(i * 200, box(0.7, 0.2)));
  }
  const ev = foldDetections(ds);
  eq(ev.length, 2);
  eq(ev.map((e) => e.count), [50, 50]);
});

check("FEARED: one person standing for ten minutes is one event", () => {
  const ds = [];
  for (let ms = 0; ms <= 600_000; ms += 200) {
    // a little drift, as a real detector gives
    ds.push(person(ms, box(0.3 + (ms % 1000) / 100000, 0.2)));
  }
  const ev = foldDetections(ds);
  eq(ev.length, 1);
  eq(ev[0].count, ds.length);
  eq(ev[0].firstUtc, at(0));
  eq(ev[0].lastUtc, at(600_000));
});

check("a person walking across the frame stays one event", () => {
  const ds = [];
  for (let i = 0; i <= 40; i++) ds.push(person(i * 200, box(0.05 + i * 0.02, 0.2)));
  eq(foldDetections(ds).length, 1);
});

// Bench 2026-09-19: Austin walked toward the camera; the box grew from
// 0.29 x 0.72 to 0.43 x 0.99 of the frame between sightings, the overlap fell
// under 0.3, and one walk became two events (and would be two alerts).
check("FEARED: a person walking toward the camera, box growing fast, stays one event", () => {
  const a = { x: 0.29484, y: 0.26609, w: 0.29165, h: 0.72458 };
  const b = { x: 0.50225, y: 0.00273, w: 0.43066, h: 0.98584 };
  if (iou(a, b) >= MERGE_MIN_IOU) throw new Error("this pair should be below the overlap rule, or the check proves nothing");
  eq(foldDetections([person(0, a), person(200, b)]).length, 1, "one event: the centre barely moved");
  const s = matchScore(a, b);
  if (s === null || s <= 0 || s >= MERGE_MIN_IOU) throw new Error(`a centre match scores below any overlap match: ${s}`);
});

check("FEARED: a second person appearing across the frame in the next sighting is NOT the first one", () => {
  const a = box(0.1, 0.2);
  const far = box(0.7, 0.2);
  eq(matchScore(a, far), null, "no match by overlap or by centre");
  eq(foldDetections([person(0, a), person(200, far)]).length, 2, "two events");
});

check("matchScore: overlap first, centre as the fallback, nothing beyond reach", () => {
  const a = box(0.3, 0.2);
  eq(matchScore(a, box(0.31, 0.2)), iou(a, box(0.31, 0.2)), "a good overlap scores its iou");
  // centres within reach (half the larger diagonal), boxes not overlapping enough
  const near = { x: 0.42, y: 0.2, w: 0.1, h: 0.3 };
  if (iou(a, near) >= MERGE_MIN_IOU) throw new Error("fixture overlaps too much");
  const s = matchScore(a, near);
  if (s === null || s >= MERGE_MIN_IOU) throw new Error(`centre fallback expected, got ${s}`);
  eq(matchScore(a, { x: 0.6, y: 0.2, w: 0.1, h: 0.3 }), null, "past reach: no match");
});

check("leaving for more than the gap and returning is two events; exactly the gap is one", () => {
  const b = box(0.3, 0.2);
  eq(foldDetections([person(0, b), person(MERGE_GAP_MS + 1, b)]).length, 2);
  eq(foldDetections([person(0, b), person(MERGE_GAP_MS, b)]).length, 1);
});

check("different cameras and kinds never merge", () => {
  const b = box(0.3, 0.2);
  const ev = foldDetections([
    person(0, b, 0.8, "cam1"),
    person(0, b, 0.8, "cam2"),
    { ...person(0, b), kind: "vehicle" },
  ]);
  eq(ev.length, 3);
});

check("plates merge on text as the car moves, and different plates stay apart", () => {
  const ev = foldDetections([
    plate(0, "ABC123", box(0.1, 0.6, 0.1, 0.05)),
    plate(400, "XYZ789", box(0.12, 0.6, 0.1, 0.05)),
    plate(800, "ABC123", box(0.6, 0.6, 0.1, 0.05)),
  ]);
  eq(ev.length, 2);
  eq(ev.map((e) => [e.plate, e.count]), [["ABC123", 2], ["XYZ789", 1]]);
});

check("best confidence tracks the strictly highest detection", () => {
  const ev = foldDetections([
    person(0, box(0.30, 0.2), 0.6),
    person(200, box(0.31, 0.2), 0.9),
    person(400, box(0.32, 0.2), 0.9),
    person(600, box(0.33, 0.2), 0.7),
  ]);
  eq(ev.length, 1);
  // travel: the last sighting is 0.03 across from the first, over the first
  // box's diagonal. Checked to a tolerance here (float centres), then pinned
  // into the exact-object comparison so the keys and their order are exact.
  const travel = ev[0].travel;
  if (Math.abs(travel - 0.03 / Math.hypot(0.1, 0.3)) > 1e-12) throw new Error(`travel ${travel}`);
  eq(ev[0], {
    cameraId: "cam1", kind: "person", firstUtc: at(0), lastUtc: at(600), count: 4,
    bestConfidence: 0.9, bestBox: box(0.31, 0.2), bestUtc: at(200), travel,
  });
  eq(Object.keys(ev[0]).includes("plate"), false);
});

check("input out of order is sorted, and the input is not mutated", () => {
  const ds = [person(400, box(0.3, 0.2)), person(0, box(0.3, 0.2)), person(200, box(0.7, 0.2))];
  const before = JSON.stringify(ds);
  const ev = foldDetections(ds);
  eq(JSON.stringify(ds), before);
  eq(ev.map((e) => e.firstUtc), [at(0), at(200)]);
  eq(ev[0].lastUtc, at(400));
  eq(foldDetections([]), []);
});

/* ── species: the precise thing, under the coarse kind ─────────────────────
 *
 * The detector already tells a truck from a car (COCO 2 car, 3 motorcycle,
 * 5 bus, 7 truck) and we were flattening all four to "vehicle" in one line —
 * throwing away exactly the word Austin needs to search for. `kind` stays
 * coarse so the forty-one places that read it keep working; `species` carries
 * the precise class alongside it.
 *
 * THE FEARED FAILURES: a species that contradicts its kind, so searching for
 * a truck returns a person; the fold dropping it, so every event is "vehicle"
 * and no search can ever find a truck; and an event whose species disagrees
 * with the very crop shown next to it.
 */

check("the vocabulary: every species belongs to exactly one kind", () => {
  eq(SPECIES_OF_KIND.person, ["person"], "a person is a person");
  eq(SPECIES_OF_KIND.vehicle, ["bus", "car", "motorcycle", "truck"], "what the model can actually tell apart");
  eq(SPECIES_OF_KIND.plate, [], "a plate is not a thing with a species");
  const all = Object.values(SPECIES_OF_KIND).flat();
  eq(all.length, new Set(all).size, "no species belongs to two kinds");
  eq(Object.keys(SPECIES_OF_KIND).sort(), [...EVENT_KINDS].sort(), "one entry per kind, and no more");
});

check("speciesOf answers which kind a species belongs to, or refuses", () => {
  eq(speciesOf("truck"), "vehicle", "truck");
  eq(speciesOf("person"), "person", "person");
  eq(speciesOf("dog"), null, "a species this detector does not report");
  eq(speciesOf(""), null, "blank");
  eq(speciesOf(null), null, "not a string");
  eq(speciesOf("TRUCK"), null, "case matters: the stored vocabulary is lower case");
});

check("a detection may carry its species, and it is copied out clean", () => {
  const d = checkDetection({ cameraId: "cam1", atUtc: at(0), kind: "vehicle", confidence: 0.8,
    box: box(0.1, 0.1), species: "truck" });
  eq(d.ok, true, "accepted");
  eq(d.detection.species, "truck", "carried through");
  eq(d.detection.kind, "vehicle", "with its coarse kind intact");
});

check("a detection without a species is still perfectly valid", () => {
  // Every event recorded before today has none, and the plate reader has no
  // species to give. Absence is normal, not an error.
  const d = checkDetection({ cameraId: "cam1", atUtc: at(0), kind: "vehicle", confidence: 0.8, box: box(0.1, 0.1) });
  eq(d.ok, true, "accepted");
  eq("species" in d.detection, false, "and the field is simply absent, not null");
});

check("THE FEARED ONE: a species that contradicts its kind is refused", () => {
  for (const [kind, species] of [["person", "truck"], ["vehicle", "person"], ["plate", "car"], ["person", "car"]]) {
    const d = checkDetection({ cameraId: "cam1", atUtc: at(0), kind, confidence: 0.8, box: box(0.1, 0.1),
      species, ...(kind === "plate" ? { plate: "ABC123" } : {}) });
    eq(d.ok, false, `${kind} + ${species} refused`);
    eq(d.reason, "bad_species", "says why");
  }
});

check("a species outside the vocabulary is refused, never stored as typed", () => {
  // This string reaches a search index and a database. It is not free text.
  for (const bad of ["lorry", "Truck", "truck ", "", "  ", 7, null, {}, ["truck"], "dog"]) {
    const d = checkDetection({ cameraId: "cam1", atUtc: at(0), kind: "vehicle", confidence: 0.8,
      box: box(0.1, 0.1), species: bad });
    eq(d.ok, false, `refused ${JSON.stringify(bad)}`);
    eq(d.reason, "bad_species", `reason for ${JSON.stringify(bad)}`);
  }
});

check("THE FEARED ONE: the fold keeps the species of the sighting it shows", () => {
  // The event's crop is cut at bestUtc. If the word and the picture come from
  // different frames, an operator is told "truck" beside a picture of a car.
  const v = (ms, confidence, species) =>
    ({ cameraId: "cam1", atUtc: at(ms), kind: "vehicle", confidence, box: box(0.4, 0.4), species });
  const [ev] = foldDetections([
    v(0, 0.55, "car"),
    v(400, 0.91, "truck"),
    v(800, 0.60, "car"),
  ]);
  eq(ev.count, 3, "one event");
  eq(ev.bestConfidence, 0.91, "the best sighting");
  eq(ev.bestUtc, at(400), "at that moment");
  eq(ev.species, "truck", "and the species from that same sighting, not the first or the commonest");
});

check("an event folded from sightings with no species has none", () => {
  const [ev] = foldDetections([person(0, box(0.4, 0.4)), person(400, box(0.4, 0.4))]);
  eq("species" in ev, false, "absent, not guessed");
});

check("the species follows the best sighting even when it arrives first", () => {
  const v = (ms, confidence, species) =>
    ({ cameraId: "cam1", atUtc: at(ms), kind: "vehicle", confidence, box: box(0.4, 0.4), species });
  const [ev] = foldDetections([v(0, 0.95, "bus"), v(400, 0.5, "truck"), v(800, 0.5, "car")]);
  eq(ev.species, "bus", "the first sighting was the best one");
  eq(ev.bestUtc, at(0), "and the crop comes from there too");
});

/* ── travel: did the thing walk in, or was it always there? ────────────────
 *
 * 2026-09-22: a furled patio umbrella by the fence was stored as a person 17
 * times in 30 minutes, the same box every time. Known-object suppression
 * refuses to learn or hide anything that TRAVELLED, so this number is the
 * belt between "hide the umbrella" and "hide a person who walked in and
 * stood still". It is the farthest any sighting's centre got from the FIRST
 * sighting's centre, in units of the first box's diagonal.
 *
 * THE FEARED FAILURES: a person who walked across the frame (or walked in and
 * then stood still) measured as if they never moved; a static object's
 * detector noise measured as if it walked; the number going DOWN as an event
 * grows, so a person who walked in and back reads as still; and an unreadable
 * box silently counted as "did not move".
 */

// The umbrella's real best boxes from the 17 events the bench camera stored
// on 2026-09-22, 21:55Z to 22:20Z (5:55 to 6:20 PM local): about 42% of the
// frame's height, the same spot, moved only by the detector's own noise.
const UMBRELLA_BOXES = [
  [0.69768, 0.36345, 0.09393, 0.42538], [0.69773, 0.36596, 0.08889, 0.41594], [0.69909, 0.36571, 0.08833, 0.43438],
  [0.69785, 0.36701, 0.09931, 0.42035], [0.69783, 0.36372, 0.08986, 0.40962], [0.69961, 0.36481, 0.07954, 0.41503],
  [0.69979, 0.36473, 0.08178, 0.41967], [0.7002, 0.36623, 0.08032, 0.41702], [0.69975, 0.36437, 0.09332, 0.41222],
  [0.70121, 0.36325, 0.07917, 0.43076], [0.69939, 0.36584, 0.08819, 0.41676], [0.70037, 0.36335, 0.08832, 0.41729],
  [0.69792, 0.3626, 0.09173, 0.42515], [0.6976, 0.36341, 0.09171, 0.43008], [0.69782, 0.36306, 0.0853, 0.42685],
  [0.69589, 0.36153, 0.08744, 0.44704], [0.69874, 0.36382, 0.08386, 0.42189],
].map(([x, y, w, h]) => ({ x, y, w, h }));

const near = (actual, expected, what) => {
  if (Math.abs(actual - expected) > 1e-12) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};

check("every event carries exactly its keys, travel among them", () => {
  const [p] = foldDetections([person(0, box(0.3, 0.2))]);
  eq(Object.keys(p).sort(), ["bestBox", "bestConfidence", "bestUtc", "cameraId", "count", "firstUtc", "kind", "lastUtc", "travel"], "a person");
  const [pl] = foldDetections([plate(0, "ABC123", box(0.1, 0.6, 0.1, 0.05))]);
  eq(Object.keys(pl).sort(), ["bestBox", "bestConfidence", "bestUtc", "cameraId", "count", "firstUtc", "kind", "lastUtc", "plate", "travel"], "a plate");
  const [v] = foldDetections([{ ...person(0, box(0.3, 0.2)), kind: "vehicle", species: "truck" }]);
  eq(Object.keys(v).sort(), ["bestBox", "bestConfidence", "bestUtc", "cameraId", "count", "firstUtc", "kind", "lastUtc", "species", "travel"], "a vehicle with a species");
  eq(typeof p.travel, "number", "a number, never absent on an event the fold made");
});

check("travelFrom: centre distance over the FIRST box's diagonal", () => {
  const a = box(0.3, 0.2);                       // diagonal hypot(0.1, 0.3)
  eq(Object.is(travelFrom(a, a), 0), true, "a box has not travelled from itself: exactly +0");
  near(travelFrom(a, box(0.3 + Math.hypot(0.1, 0.3), 0.2)), 1, "moved one diagonal sideways");
  near(travelFrom(a, box(0.3, 0.2 + 0.3)), 0.3 / Math.hypot(0.1, 0.3), "moved down its own height");
  // Same centre, very different size: the box grew or shrank but did not go anywhere.
  near(travelFrom(box(0.4, 0.4, 0.2, 0.2), box(0.3, 0.3, 0.4, 0.4)), 0, "grew about its centre: no travel");
  // The FIRST box is the ruler, not the second: a small far-away start measures
  // a step in its own (small) size.
  const small = box(0.45, 0.45, 0.05, 0.1);
  const big = box(0.5, 0.3, 0.2, 0.4);
  const d = Math.hypot((0.5 + 0.1) - (0.45 + 0.025), (0.3 + 0.2) - (0.45 + 0.05));
  near(travelFrom(small, big), d / Math.hypot(0.05, 0.1), "measured in the small first box");
  near(travelFrom(big, small), d / Math.hypot(0.2, 0.4), "measured in the big first box");
});

check("THE FEARED ONE: a box with no diagonal, or one that cannot be read, is refused - never divided by, never read as 'did not move'", () => {
  // The message says which refusal fired: the first box is checked BEFORE
  // anything is divided by its diagonal, not caught afterwards as a bad result.
  const throws = (fn, word, what) => {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    if (!(err instanceof RangeError)) throw new Error(`${what}: expected a RangeError, got ${err}`);
    if (!err.message.includes(word)) throw new Error(`${what}: expected the "${word}" refusal, got "${err.message}"`);
  };
  throws(() => travelFrom({ x: 0.1, y: 0.1, w: 0, h: 0 }, box(0.1, 0.1)), "no diagonal", "zero-size first box");
  throws(() => travelFrom({ x: 0.1, y: 0.1, w: 0, h: 0 }, { x: 0.1, y: 0.1, w: 0, h: 0 }), "no diagonal", "zero-size box against itself (0 / 0)");
  throws(() => travelFrom({ x: 0.1, y: 0.1, w: NaN, h: 0.3 }, box(0.1, 0.1)), "no diagonal", "unreadable first box");
  throws(() => travelFrom(box(0.1, 0.1), { x: NaN, y: 0.1, w: 0.1, h: 0.3 }), "could not be read", "unreadable later box");
  throws(() => travelFrom(box(0.1, 0.1), { x: Infinity, y: 0.1, w: 0.1, h: 0.3 }), "could not be read", "a later box off to infinity");
  // And through the fold, which is where an unchecked detection would come in.
  const bad = [person(0, { x: 0.1, y: 0.1, w: 0, h: 0 })];
  const before = JSON.stringify(bad);
  throws(() => foldDetections(bad), "no diagonal", "the fold refuses even a one-sighting event whose box has no diagonal");
  eq(JSON.stringify(bad), before, "and leaves its input as it was");
  throws(() => foldDetections([person(0, box(0.3, 0.2)), person(200, { x: 0.3, y: NaN, w: 0.1, h: 0.3 })]), "could not be read", "the fold refuses an unreadable later box");
  // A person's unreadable box never matches (matchScore gives NaN) so it
  // opens its own event; a plate joins on its text whatever its box, so this
  // is the one way an unreadable box reaches an open event's travel.
  throws(() => foldDetections([plate(0, "ABC123", box(0.1, 0.6, 0.1, 0.05)), plate(400, "ABC123", { x: NaN, y: 0.6, w: 0.1, h: 0.05 })]),
    "could not be read", "the fold refuses an unreadable box joining an open event");
});

check("a one-sighting event has travel exactly 0", () => {
  const [ev] = foldDetections([person(0, box(0.3, 0.2))]);
  eq(Object.is(ev.travel, 0), true, "exactly +0");
});

check("THE FEARED ONE: a walker crossing the frame gets travel far above 1", () => {
  // The same walk as "a person walking across the frame stays one event":
  // 0.05 to 0.85 of the frame in 8 s, a box 0.1 x 0.3.
  const ds = [];
  for (let i = 0; i <= 40; i++) ds.push(person(i * 200, box(0.05 + i * 0.02, 0.2)));
  const ev = foldDetections(ds);
  eq(ev.length, 1, "one event");
  near(ev[0].travel, 0.8 / Math.hypot(0.1, 0.3), "0.8 of the frame over a 0.316 diagonal: about 2.5 diagonals");
  if (!(ev[0].travel > 2)) throw new Error(`a walker must read far above 1, got ${ev[0].travel}`);
});

check("THE FEARED ONE: a person who walks in and then stands still for ten minutes keeps the walk", () => {
  // The case known-object suppression must never hide: a still person at a
  // spot, whose event nonetheless began with them walking there.
  const ds = [];
  for (let i = 0; i <= 25; i++) ds.push(person(i * 200, box(i * 0.02, 0.2)));          // walk in: 0 to 0.5
  for (let ms = 5200; ms <= 605_000; ms += 200) ds.push(person(ms, box(0.5 + (ms % 1000) / 200000, 0.2)));
  const [ev, ...rest] = foldDetections(ds);
  eq(rest.length, 0, "one event");
  if (!(ev.travel > 1.5)) throw new Error(`the walk in must still show, got ${ev.travel}`);
});

check("THE FEARED ONE: a jittering static box stays well under 0.5 - the umbrella's real boxes", () => {
  // Folded one second apart into one event, the 17 real boxes are the
  // detector's own noise on a thing that never moved.
  const ds = UMBRELLA_BOXES.map((b, i) => person(i * 1000, b, 0.6, "bench"));
  const ev = foldDetections(ds);
  eq(ev.length, 1, "one event");
  eq(ev[0].count, 17, "all 17 sightings");
  if (!(ev[0].travel < 0.1)) throw new Error(`static noise must read far below 0.5, got ${ev[0].travel}`);
  // Whichever box happened to open the event, the worst pair is still small.
  let worst = 0;
  for (const f of UMBRELLA_BOXES) for (const g of UMBRELLA_BOXES) worst = Math.max(worst, travelFrom(f, g));
  if (!(worst < 0.1)) throw new Error(`worst pair ${worst}`);
});

check("THE FEARED ONE: ten minutes of synthetic jitter around one spot stays under 0.5", () => {
  let s = 4242;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ds = [];
  for (let ms = 0; ms <= 600_000; ms += 200) {
    // +-1% of the frame on every edge, around the umbrella's size and place.
    ds.push(person(ms, { x: 0.69 + rnd() * 0.02, y: 0.36 + rnd() * 0.02, w: 0.08 + rnd() * 0.02, h: 0.41 + rnd() * 0.02 }));
  }
  const ev = foldDetections(ds);
  eq(ev.length, 1, "one event");
  if (!(ev[0].travel < 0.1)) throw new Error(`jitter must read far below 0.5, got ${ev[0].travel}`);
});

check("THE FEARED ONE: travel never decreases as an event grows, and is the farthest, not where it ended", () => {
  // Out 0.4 of the frame and back to where it started.
  const ds = [];
  for (let i = 0; i <= 20; i++) ds.push(person(i * 200, box(0.1 + i * 0.02, 0.2)));
  for (let i = 19; i >= 0; i--) ds.push(person((40 - i) * 200, box(0.1 + i * 0.02, 0.2)));
  let prev = -1;
  for (let k = 1; k <= ds.length; k++) {
    const evs = foldDetections(ds.slice(0, k));
    eq(evs.length, 1, `one event after ${k} sightings`);
    if (evs[0].travel < prev) throw new Error(`travel fell from ${prev} to ${evs[0].travel} at sighting ${k}`);
    prev = evs[0].travel;
  }
  near(prev, 0.4 / Math.hypot(0.1, 0.3), "the farthest point (0.4 across), though it ended where it began");
});

check("travel is measured from the FIRST sighting, not the best one or the previous one", () => {
  // Best sighting in the middle; steps of 0.1. From the first: 0.2. From the
  // best, or step by step: 0.1.
  const [ev] = foldDetections([
    person(0, box(0.1, 0.2), 0.5),
    person(200, box(0.2, 0.2), 0.9),
    person(400, box(0.3, 0.2), 0.5),
  ]);
  eq(ev.count, 3, "one event");
  near(ev.travel, 0.2 / Math.hypot(0.1, 0.3), "0.2 across from where it was first seen");
});

check("plates carry travel too (harmless: one rule for every kind)", () => {
  const [ev] = foldDetections([plate(0, "ABC123", box(0.1, 0.6, 0.1, 0.05)), plate(400, "ABC123", box(0.6, 0.6, 0.1, 0.05))]);
  near(ev.travel, 0.5 / Math.hypot(0.1, 0.05), "the car drove 0.5 of the frame");
});

// Recorded, not judged: the nearest thing to a real person's sighting
// sequence we have. Bench 2026-09-19, Austin walking straight at the camera,
// two sightings 200 ms apart. Walking head-on moves a box's centre least of
// all, and this is what 200 ms of it measures. Whoever sets the "moved"
// line (knownObjects.ts) should know this number exists.
check("the bench walk toward the camera (2026-09-19): two sightings travel 0.39 of the first box's diagonal", () => {
  const a = { x: 0.29484, y: 0.26609, w: 0.29165, h: 0.72458 };
  const b = { x: 0.50225, y: 0.00273, w: 0.43066, h: 0.98584 };
  const [ev] = foldDetections([person(0, a), person(200, b)]);
  if (Math.abs(ev.travel - 0.3932) > 0.0005) throw new Error(`travel ${ev.travel}`);
});

report("detection");
