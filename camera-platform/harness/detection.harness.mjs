// harness/detection.harness.mjs — contracts/detection.ts
//
// FEARED: two people at once folded into one event (the second never shown);
// a detector glitch stored as if it were real; ten minutes of one person
// becoming thousands of events.

import { check, eq, report } from "./_assert.mjs";
import {
  EVENT_KINDS, MERGE_GAP_MS, MERGE_MIN_IOU,
  normalisePlate, checkDetection, iou, foldDetections, matchScore,
  SPECIES_OF_KIND, speciesOf,
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
  eq(ev[0], {
    cameraId: "cam1", kind: "person", firstUtc: at(0), lastUtc: at(600), count: 4,
    bestConfidence: 0.9, bestBox: box(0.31, 0.2), bestUtc: at(200),
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

report("detection");
