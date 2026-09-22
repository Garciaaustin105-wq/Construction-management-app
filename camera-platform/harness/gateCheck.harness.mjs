/**
 * The gate check's pure core (contracts/gateCheck.ts), run through the real
 * reader (detectionsFromReplay) and the real fold (advanceFold), so what is
 * checked here is what `camctl gate-check` reports.
 *
 * THE FEARED FAILURES - each one makes the gate look cheaper than it is:
 * - a person the gate never looked at counted as found;
 * - two people in view at once, the gate catching one, both counted as found
 *   because something was found at that time (time overlap, not attribution);
 * - a frame line that does not say whether the gate looked, guessed into one
 *   set or the other;
 * - no people, or no frames, reported as 100%;
 * - a slow drifter the gate saw as two events counted as two people found,
 *   or not listed at all;
 * - a gated sighting with no reference twin dropped without a word;
 * - a report that judges, or that is silent about what it could not use.
 */
import {
  readShadowReplay, sumShadowReads, foldWithMembership, sightingKey, compareShadow, sumGateTotals, gateCheckReport,
} from "../dist/gateCheck.js";
import { foldDetections, MERGE_GAP_MS } from "../dist/detection.js";
import { check, eq, report } from "./_assert.mjs";

console.log("gate check");

const CAM = "cam2-sub";
const FILE_START = Date.parse("2026-09-21T03:00:00.000Z");
const at = (ms) => new Date(FILE_START + ms).toISOString();
const box = (x, y = 0.3, w = 0.08, h = 0.3) => ({ x, y, w, h });
const person = (confidence, b = box(0.4)) => ({ kind: "person", species: "person", confidence, box: b });
const vehicle = (confidence, b = box(0.5, 0.5, 0.3, 0.2)) => ({ kind: "vehicle", species: "car", confidence, box: b });
const frameLine = (tSec, looked, ...detections) =>
  JSON.stringify({ frame: Math.round(tSec * 5), tSec, detections, gateLooked: looked });
const read = (lines, minConfidence = 0.5, fileStartMs = FILE_START) =>
  readShadowReplay({ cameraId: CAM, fileStartMs, lines, minConfidence });
const FILES = [{ path: "/srv/camplat/cam2-sub/1790000000000.mp4", startMs: FILE_START }];

// Five frames a second, tSec rounded as replay.py rounds it.
const tick = (i) => Math.round(i * 200) / 1000;
function scene(seconds, peopleAt, lookedAt) {
  const lines = [];
  for (let i = 0; i <= seconds * 5; i++) {
    const t = tick(i);
    lines.push(frameLine(t, lookedAt(t), ...peopleAt(t)));
  }
  return lines;
}
const shadow = (lines, live = [], files = FILES) => {
  const r = read(lines);
  return { r, c: compareShadow({ files, reference: r.reference, gated: r.gated, live }) };
};
// A detection as the reader produces it, for building sets directly.
const det = (ms, kind, x, confidence = 0.8, y = 0.3) =>
  ({ cameraId: CAM, atUtc: at(ms), kind, confidence, box: box(x, y), species: kind === "person" ? "person" : "car" });
const liveEvent = (kind, fromMs, toMs, confidence = 0.8) => ({
  id: `cam2:${FILE_START + fromMs}:1`, cameraId: "cam2", kind, firstUtc: at(fromMs), lastUtc: at(toMs), count: 5,
  bestConfidence: confidence, bestBox: box(0.4), bestUtc: at(fromMs), finished: true,
});

// ---------------- reading the shadow replay ----------------

check("every frame is in the reference; only looked frames in the gated set, as byte-identical copies", () => {
  const r = read([
    frameLine(0, true, person(0.9)),
    frameLine(0.2, false, person(0.8)),
    frameLine(0.4, true, person(0.7), vehicle(0.6)),
  ]);
  eq([r.frames, r.looked, r.unreadable], [3, 2, 0], "three frames, two looked at, nothing unreadable");
  eq(r.reference.map((d) => [d.atUtc, d.kind, d.confidence]),
    [[at(0), "person", 0.9], [at(200), "person", 0.8], [at(400), "person", 0.7], [at(400), "vehicle", 0.6]], "the reference is every frame");
  const lookedTimes = new Set([at(0), at(400)]);
  eq(JSON.stringify(r.gated), JSON.stringify(r.reference.filter((d) => lookedTimes.has(d.atUtc))),
    "the gated set is the reference's own detections from the looked frames, field for field");
  eq(r.gated.map(sightingKey), r.reference.filter((d) => lookedTimes.has(d.atUtc)).map(sightingKey), "so their keys are the same strings");
});

check("THE FEARED ONE: a frame line that does not say whether the gate looked is unreadable, named, and in NEITHER set", () => {
  const noFlag = JSON.stringify({ frame: 1, tSec: 0.2, detections: [person(0.9)] });
  const asText = JSON.stringify({ frame: 2, tSec: 0.4, detections: [person(0.9)], gateLooked: "true" });
  const asNumber = JSON.stringify({ frame: 3, tSec: 0.6, detections: [person(0.9)], gateLooked: 1 });
  const asNull = JSON.stringify({ frame: 4, tSec: 0.8, detections: [person(0.9)], gateLooked: null });
  const r = read([frameLine(0, true, person(0.9)), noFlag, asText, asNumber, asNull, frameLine(1, false, person(0.9))]);
  eq(r.unreadable, 4, "all four counted as unreadable");
  eq([r.frames, r.looked], [2, 1], "and not counted as frames at all");
  eq(r.reference.map((d) => d.atUtc), [at(0), at(1000)], "not in the reference");
  eq(r.gated.map((d) => d.atUtc), [at(0)], "not in the gated set");
  eq(r.errors.length, 1, "one error line names them");
  eq(r.errors[0].includes("lines 2, 3, 4, 5"), true, `by line number: ${r.errors[0]}`);
});

check("a whole file without gateLooked (a replay that was not in shadow mode) reads as nothing, and says so - never as zero people", () => {
  const plain = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2].map((t) => JSON.stringify({ frame: Math.round(t * 5), tSec: t, detections: [person(0.9)] }));
  const r = read(plain);
  eq([r.reference.length, r.gated.length, r.frames, r.unreadable], [0, 0, 0, 7], "nothing placed, everything counted");
  eq(r.errors[0].startsWith("7 frame lines did not say whether the gate looked"), true, r.errors[0]);
  eq(r.errors[0].includes("and 2 more"), true, "five named by number, the rest counted");
});

check("sightings under the live floor make no reference event, and are counted as dropped", () => {
  const { r, c } = shadow(scene(4, () => [person(0.3)], () => true));
  eq(r.reference.length, 0, "a 0.3 box is not a person found looking at every frame");
  eq(r.gated.length, 0, "nor with the gate");
  eq(r.belowFloor, 21, "all 21 counted as under the floor");
  eq([c.person.reference, c.person.found, c.person.lost.length, c.person.foundShare], [0, 0, 0, null], "no people: no share, not 100%");
});

check("the gate totals line and replay errors are read as the scoring runner reads them", () => {
  const gateTotals = JSON.stringify({ type: "gate", frames: 3, looked: 2, reasons: { first: 1, motion: 1 } });
  const r = read([frameLine(0, true), frameLine(0.2, false), frameLine(0.4, true),
    JSON.stringify({ type: "error", message: "the decoder hiccupped" }), gateTotals]);
  eq(r.gate, { frames: 3, looked: 2, reasons: { first: 1, motion: 1 } }, "the file's gate totals");
  eq(r.errors, ["the decoder hiccupped"], "replay's own error, carried");
  eq(r.unreadable, 0, "neither line is unreadable");
  const bad = read([frameLine(0, true), JSON.stringify({ type: "gate", frames: 1, looked: 2, reasons: { first: 2 } })]);
  eq([bad.gate, bad.unreadable], [null, 1], "a malformed gate line is unreadable, not a total");
});

check("sumShadowReads adds the files and says which file each error came from", () => {
  const a = read([frameLine(0, true, person(0.9)), JSON.stringify({ type: "error", message: "late frame" })]);
  const b = read([frameLine(0, false, person(0.2)), "not json"]);
  const t = sumShadowReads([{ path: "/rec/a.mp4", read: a }, { path: "/rec/b.mp4", read: b }]);
  eq([t.files, t.frames, t.looked, t.belowFloor, t.unreadable], [2, 2, 1, 1, 1], "summed");
  eq(t.errors, ["/rec/a.mp4: late frame"], "prefixed with its file");
});

// ---------------- folding with membership ----------------

function sameAsBatch(detections, what) {
  const m = foldWithMembership(detections);
  eq(JSON.stringify(m.events.map((e) => e.event)), JSON.stringify(foldDetections(detections)), `${what}: identical to foldDetections`);
  const perId = new Map();
  for (const d of detections) {
    const id = m.memberOf.get(sightingKey(d));
    perId.set(id, (perId.get(id) ?? 0) + 1);
  }
  for (const { id, event } of m.events) eq(perId.get(id), event.count, `${what}: every sighting of ${id} maps to it`);
  eq(m.ambiguous.size, 0, `${what}: nothing ambiguous`);
  return m;
}

check("THE FEARED ONE: folding with membership gives exactly foldDetections' events, scenario by scenario", () => {
  const walk = [];
  for (let i = 0; i <= 25; i++) walk.push(det(i * 200, "person", 0.1 + i * 0.01, 0.6 + i * 0.01));
  eq(sameAsBatch(walk, "a walk-by").events.length, 1, "a walk-by is one event");

  const two = [];
  for (let i = 0; i <= 20; i++) two.push(det(i * 200, "person", 0.1), det(i * 200, "person", 0.8, 0.7));
  eq(sameAsBatch(two, "two people in one frame, apart").events.length, 2, "two people are two events");

  const gap = [];
  for (let i = 0; i <= 10; i++) gap.push(det(i * 200, "person", 0.4));
  for (let i = 0; i <= 10; i++) gap.push(det(2000 + MERGE_GAP_MS + 1 + i * 200, "person", 0.4));
  eq(sameAsBatch(gap, "a gap over MERGE_GAP_MS").events.length, 2, "a gap over the merge gap is two events");

  const beside = [];
  for (let i = 0; i <= 20; i++) beside.push(det(i * 200, "person", 0.4), det(i * 200, "vehicle", 0.42));
  eq(sameAsBatch(beside, "a vehicle beside a person").events.map((e) => e.event.kind), ["person", "vehicle"], "kinds never fold together");
});

check("THE FEARED ONE: mixed traffic handed over in no particular order still folds exactly as foldDetections does", () => {
  let s = 4242;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ds = [];
  for (let ms = 0; ms < 90_000; ms += 200) {
    const n = Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      ds.push(det(ms, rnd() < 0.7 ? "person" : "vehicle", Math.floor(rnd() * 3) * 0.3 + rnd() * 0.02, 0.5 + rnd() * 0.5));
    }
    if (rnd() < 0.1) ms += 11_000;
  }
  // Shuffle: the fold must sort, not trust the order it is given.
  const shuffled = ds.map((d) => ({ d, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.d);
  const m = sameAsBatch(shuffled, "shuffled traffic");
  eq(m.events.length > 10, true, `enough events to mean something (${m.events.length})`);
});

check("folding nothing gives nothing", () => {
  const m = foldWithMembership([]);
  eq([m.events.length, m.memberOf.size], [0, 0], "no events, no members");
});

// ---------------- comparing ----------------

check("THE FEARED ONE: a person the gate never looked at is LOST, not found", () => {
  const { c } = shadow(scene(20, (t) => (t <= 4 ? [person(0.8, box(0.1 + t * 0.02))] : []), (t) => t >= 10));
  eq([c.person.reference, c.person.found, c.person.lost.length], [1, 0, 1], "one person, none found, one lost");
  eq(c.person.foundShare, 0, "0 of 1 found, a measurement, not null");
  const e = c.person.lost[0];
  eq([e.firstUtc, e.lastUtc, e.sightings, e.gatedSightings, e.gatedEvents], [at(0), at(4000), 21, 0, 0], "listed with its span and sightings");
});

check("THE FEARED ONE: the slow drifter - one person the gate sees as two events - is found ONCE and listed as split", () => {
  // The gate looks at 0 s and 5 s only (keepalive-like), and in those five
  // seconds the person drifted further than the fold's reach.
  const { c } = shadow(scene(16, (t) => [person(0.8, box(0.05 + Math.round(t * 5) * 0.01))], (t) => t === 0 || t === 5));
  eq(c.person.reference, 1, "looking at every frame it is one person");
  eq(c.person.gated, 2, "with the gate, two events");
  eq([c.person.found, c.person.lost.length], [1, 0], "found once, not twice, and not lost");
  eq(c.person.split.length, 1, "listed as split");
  eq([c.person.split[0].gatedEvents, c.person.split[0].gatedSightings, c.person.split[0].sightings], [2, 2, 81], "into two events, from two looked sightings of 81");
});

check("THE FEARED ONE: two people in view at once, the gate catching only one - exactly one found, one lost", () => {
  // A (left) is in view 0-6 s, B (right) 3-20 s; the gate looks only at 0-2 s.
  // By time overlap B would be "found": A's gated event sits within the merge
  // gap of B's start. By attribution B has no gated sighting at all.
  const { c } = shadow(scene(20, (t) => [
    ...(t <= 6 ? [person(0.8, box(0.1))] : []),
    ...(t >= 3 ? [person(0.8, box(0.8))] : []),
  ], (t) => t <= 2));
  eq([c.person.reference, c.person.found, c.person.lost.length], [2, 1, 1], "two people, one found, one lost");
  eq(c.person.lost[0].firstUtc, at(3000), "the lost one is B");
  eq(c.person.foundShare, 0.5, "half");

  // The same, handed over directly: both in every frame, only A's sightings gated.
  const reference = [];
  for (let i = 0; i <= 25; i++) reference.push(det(i * 200, "person", 0.1), det(i * 200, "person", 0.8));
  const gated = reference.filter((d) => d.box.x === 0.1).map((d) => ({ ...d, box: { ...d.box } }));
  const direct = compareShadow({ files: FILES, reference, gated, live: [] });
  eq([direct.person.found, direct.person.lost.length], [1, 1], "exact attribution: one found, one lost");
  eq(direct.person.lost[0].bestBox.x, 0.8, "and the lost one is the one on the right");
});

check("a gated event holding two reference people is counted as merged", () => {
  // A walks left to right 0-4 s; B stands where A started, 5-7 s. Every frame
  // sees A leave, so B is someone new; the gate saw A only at 0 s, so to the
  // gated fold B is A come back.
  const { c } = shadow(scene(8, (t) => [
    ...(t <= 4 ? [person(0.8, box(0.1 + Math.round(t * 5) * 0.04))] : []),
    ...(t >= 5 && t <= 7 ? [person(0.8, box(0.1))] : []),
  ], (t) => t === 0 || t >= 5));
  eq([c.person.reference, c.person.found, c.person.lost.length, c.person.gated], [2, 2, 0, 1], "two people, both found, in one gated event");
  eq(c.person.merged.length, 1, "counted as merged");
  eq(c.person.merged[0].referenceEvents, 2, "from two reference events");
});

check("THE FEARED ONE: a gated sighting with no reference twin is counted as unattributed, never dropped", () => {
  const reference = [det(0, "person", 0.4, 0.8), det(200, "person", 0.4, 0.8)];
  const gated = [det(0, "person", 0.4, 0.8), det(200, "person", 0.4, 0.81)];   // one a hair off
  const c = compareShadow({ files: FILES, reference, gated, live: [] });
  eq([c.person.unattributed, c.unattributed], [1, 1], "counted, per kind and overall");
  eq([c.person.found, c.person.gatedSightings], [1, 2], "the good twin still counts; both gated sightings are counted as seen");
});

check("footage offsets: the file whose start is the last at or before the best moment, seconds into it; none before the first file", () => {
  const files = [{ path: "/rec/b.mp4", startMs: FILE_START + 60_000 }, { path: "/rec/a.mp4", startMs: FILE_START }];
  const reference = [det(-5000, "person", 0.1), det(60_000 + 20_000, "person", 0.5), det(75_400 + 30_000, "person", 0.1)];
  const c = compareShadow({ files, reference, gated: [], live: [] });
  eq(c.person.lost.map((e) => e.footage), [null, { path: "/rec/b.mp4", offsetSec: 20 }, { path: "/rec/b.mp4", offsetSec: 45.4 }], "offsets");
  const edge = compareShadow({ files, reference: [det(60_000, "person", 0.1), det(59_999 - 20_000, "person", 0.5)], gated: [], live: [] });
  eq(edge.person.lost.map((e) => e.footage), [{ path: "/rec/a.mp4", offsetSec: 39.999 }, { path: "/rec/b.mp4", offsetSec: 0 }],
    "a moment exactly at a file's start is in that file, a millisecond before it is in the one before");
});

check("footage offsets: a moment past a file's end, or in a gap between files, is in no file (found in review)", () => {
  // a: 0-60 s, b: 90-150 s. Gap 60-90 s, and nothing after 150 s.
  const files = [{ path: "/rec/a.mp4", startMs: FILE_START, endMs: FILE_START + 60_000 },
    { path: "/rec/b.mp4", startMs: FILE_START + 90_000, endMs: FILE_START + 150_000 }];
  const reference = [det(59_999, "person", 0.1), det(70_000 + 20_000, "person", 0.5), det(130_000 + 40_000, "person", 0.1)];
  const c = compareShadow({ files, reference: [det(59_999 - 30_000, "person", 0.1)], gated: [], live: [] });
  eq(c.person.lost[0].footage, { path: "/rec/a.mp4", offsetSec: 29.999 }, "inside a file: that file");
  const gap = compareShadow({ files, reference: [det(75_000, "person", 0.1)], gated: [], live: [] });
  eq(gap.person.lost[0].footage, null, "in the gap: no file, not a+75 s");
  const after = compareShadow({ files, reference: [det(160_000, "person", 0.1)], gated: [], live: [] });
  eq(after.person.lost[0].footage, null, "past the last file's end: no file, not b+70 s");
  const atEnd = compareShadow({ files, reference: [det(60_000, "person", 0.1)], gated: [], live: [] });
  eq(atEnd.person.lost[0].footage, null, "a file's end is outside it");
  void reference;
});

check("THE FEARED ONE: live comparison both ways, by time and kind only - a live vehicle never stands in for a person", () => {
  const reference = [];
  for (let ms = 0; ms <= 4000; ms += 200) reference.push(det(ms, "person", 0.1));          // P1, 0-4 s
  for (let ms = 100_000; ms <= 104_000; ms += 200) reference.push(det(ms, "person", 0.5));  // P2, 100-104 s
  for (let ms = 200_000; ms <= 204_000; ms += 200) reference.push(det(ms, "vehicle", 0.5)); // V1, 200-204 s
  const live = [
    liveEvent("person", 4000 + MERGE_GAP_MS, 20_000),       // starts exactly the merge gap after P1: near
    liveEvent("person", 104_000 + MERGE_GAP_MS + 1, 120_000), // a millisecond further after P2: not near
    liveEvent("person", 200_000, 204_000),                    // in time with V1, but a person
    liveEvent("vehicle", 100_000, 104_000),                   // in time with P2, but a vehicle
    liveEvent("plate", 0, 1000),
  ];
  const c = compareShadow({ files: FILES, reference, gated: [], live });
  eq([c.person.reference, c.person.live.events, c.person.live.storedLive], [2, 3, 1], "two people, three live person events, one person stored live");
  eq(c.person.live.notStoredLive.map((e) => e.firstUtc), [at(100_000)], "P2 not stored live");
  eq(c.person.live.liveOnly.map((e) => e.firstUtc), [at(104_000 + MERGE_GAP_MS + 1), at(200_000)], "live people with no person here");
  eq(c.person.live.storedLiveShare, 0.5, "one of two");
  eq([c.vehicle.reference, c.vehicle.live.events, c.vehicle.live.storedLive], [1, 1, 0], "the live vehicle is not matched to the person beside it in time");
  eq(c.vehicle.live.notStoredLive.map((e) => e.firstUtc), [at(200_000)], "V1 not stored live");
  eq(c.vehicle.live.liveOnly.map((e) => e.firstUtc), [at(100_000)], "the live vehicle is live-only");
  eq(c.person.lost.map((e) => e.storedLive), [true, false], "each lost person says whether live stored it");
  eq([c.otherKinds.live, c.liveMatchedBy], [1, "time_and_kind"], "the plate is counted as not compared; the matching rule is named");
});

check("THE FEARED ONE: zero frames gives no share, zero people gives nulls, never 100%", () => {
  eq(sumGateTotals([]).share, null, "no files, no share");
  eq(sumGateTotals([{ frames: 0, looked: 0, reasons: {} }]).share, null, "zero frames, no share");
  const c = compareShadow({ files: FILES, reference: [], gated: [], live: [liveEvent("person", 0, 1000)] });
  eq([c.person.reference, c.person.foundShare, c.person.live.storedLiveShare], [0, null, null], "no people: nulls");
  eq(c.person.live.liveOnly.length, 1, "and the live event with nothing here is still listed");
});

check("THE FEARED ONE: sumGateTotals counts a file with no totals as missing, never as zeros", () => {
  const t = sumGateTotals([
    { frames: 100, looked: 10, reasons: { motion: 9, first: 1 } },
    null,
    { frames: 50, looked: 5, reasons: { motion: 3, keepalive: 2 } },
  ]);
  eq([t.frames, t.looked, t.share, t.missing], [150, 15, 0.1, 1], "summed over the files that had totals; one missing");
  eq(t.reasons, { motion: 12, first: 1, keepalive: 2 }, "reasons summed");
});

// ---------------- the report ----------------

const HOUR = 3_600_000;
const threeHours = [0, 1, 2].map((h) => ({ path: `/srv/camplat/cam2-sub/${FILE_START + h * HOUR}.mp4`, startMs: FILE_START + h * HOUR, endMs: FILE_START + (h + 1) * HOUR }));
const kindCmp = (o = {}) => ({
  reference: 0, found: 0, lost: [], split: [], merged: [], gated: 0, foundShare: null, referenceSightings: 0, gatedSightings: 0,
  unattributed: 0, ambiguous: 0, live: { events: 0, storedLive: 0, storedLiveShare: null, notStoredLive: [], liveOnly: [] }, ...o,
});
const listed = (o = {}) => ({
  firstUtc: at(600_000), lastUtc: at(612_400), bestUtc: at(605_000), bestConfidence: 0.71, bestBox: box(0.4), sightings: 12,
  gatedSightings: 0, gatedEvents: 0, storedLive: false, footage: { path: threeHours[0].path, offsetSec: 605 }, ...o,
});
const result = (o = {}) => ({
  atUtc: "2026-09-21T06:05:00.000Z",
  camera: { detectCameraId: "cam2", footageCameraId: "cam2-sub", footageIsLiveStream: true },
  settings: { fps: 5, fpsSource: "live", minConfidence: 0.5, model: "yolox_s.onnx", gate: { threshold: 0.005, keepaliveMs: 5000, liveEnabled: true } },
  span: { requestedFromUtc: at(0), requestedToUtc: at(3 * HOUR), replayedFromUtc: at(0), replayedToUtc: at(3 * HOUR), files: threeHours, skipped: [], failed: [] },
  frames: { total: 54_000, looked: 4212, share: 4212 / 54_000, reasons: { first: 1, motion: 3900, hold: 250, keepalive: 61 }, missing: 0 },
  read: { files: 3, frames: 54_000, looked: 4212, belowFloor: 310, unreadable: 0, errors: [] },
  live: { truncated: false },
  comparison: {
    person: kindCmp({ reference: 23, found: 22, foundShare: 22 / 23, lost: [listed()], live: { events: 21, storedLive: 21, storedLiveShare: 21 / 23, notStoredLive: [listed({ firstUtc: at(700_000) })], liveOnly: [] } }),
    vehicle: kindCmp(),
    otherKinds: { reference: 0, gated: 0, live: 0 }, unattributed: 0, ambiguous: 0, liveUnreadable: 0, liveMatchedBy: "time_and_kind",
  },
  ...o,
});
const VERDICT = /\b(good|bad|pass|passes|passed|fine|safe|ok|okay|acceptable|healthy|meets)\b/i;

check("the report states the run in plain measurements", () => {
  const lines = gateCheckReport(result());
  eq(lines[0], "Replayed 3 h 0 min of cam2-sub, the stream the live detector reads for cam2, at 5 fps (the live rate): 54,000 frames.", "what was replayed");
  eq(lines.includes("The gate would have looked at 4,212 of them (7.8%): motion 3,900, hold 250, keepalive 61, first 1."), true, lines.join("\n"));
  eq(lines.includes("People the model finds when it looks at every frame: 23. Also found with the gate: 22 (95.7%). Missed with the gate: 1. Split into more than one event: 0."), true, "the people line");
  eq(lines.some((l) => l.startsWith("  missed: 2026-09-21T03:10:00.000Z to 03:10:12.400Z, 12 sightings, best confidence 0.71 at 2026-09-21T03:10:05.000Z; footage /srv/camplat/cam2-sub/")
    && l.includes("at 605.0 s")), true, "the missed person, with its time, confidence and footage");
  eq(lines.includes("Stored live over the same hours: 21 person events (matched by time and kind only)."), true, "the live line");
  eq(lines.some((l) => l.startsWith("  not stored live: 2026-09-21T03:11:40.000Z")), true, "the person live did not store");
  eq(lines.includes("The gate is ON on this NVR (threshold 0.005, keepalive 5 s); this replays it as set."), true, "the gate as set");
  eq(lines.includes("Could not use: nothing; every file, line and live row was read."), true, "says there was nothing it could not use");
  eq(VERDICT.test(lines.join("\n")), false, `no verdict words: ${lines.join(" | ").match(VERDICT)}`);
});

check("THE FEARED ONE: the report names everything it could not use, labels footage that is not the live stream, and never judges", () => {
  const lines = gateCheckReport(result({
    camera: { detectCameraId: "cam2", footageCameraId: "cam2-main", footageIsLiveStream: false },
    settings: { fps: 3, fpsSource: "by_hand", minConfidence: 0.5, model: "yolox_s.onnx", gate: { threshold: 0.005, keepaliveMs: 5000, liveEnabled: false } },
    span: {
      requestedFromUtc: at(0), requestedToUtc: at(3 * HOUR), replayedFromUtc: at(0), replayedToUtc: at(3 * HOUR), files: threeHours,
      skipped: [{ path: "/srv/camplat/cam2-main/partial.mp4", reason: "still recording (not sealed)" }],
      failed: [{ path: threeHours[1].path, error: "ffmpeg exited 1" }],
    },
    frames: { total: 18_000, looked: 1400, share: 1400 / 18_000, reasons: { motion: 1400 }, missing: 1 },
    read: { files: 2, frames: 36_000, looked: 2800, belowFloor: 0, unreadable: 4, errors: ["/x.mp4: 4 frame lines did not say whether the gate looked (lines 1, 2, 3, 4); left out of both sets"] },
    live: { truncated: true },
    comparison: { ...result().comparison, unattributed: 2, otherKinds: { reference: 3, gated: 1, live: 0 } },
  }));
  const text = lines.join("\n");
  eq(lines[0].includes("NOT the stream the live detector reads for cam2"), true, lines[0]);
  eq(lines[0].includes("set by hand, not the live rate"), true, "the frame rate's source");
  eq(lines.includes("The gate is OFF on this NVR; this previews it at threshold 0.005, keepalive 5 s."), true, "the gate is off live");
  for (const l of lines.filter((x) => /^(People|Vehicles|Stored live|The gate would|The frame lines)/.test(x.replace("[not the live stream] ", "")))) {
    eq(l.startsWith("[not the live stream] "), true, `labelled: ${l}`);
  }
  for (const [needle, what] of [
    ["cam2-main is not the stream the live detector reads", "footage not the live stream"],
    ["skipped /srv/camplat/cam2-main/partial.mp4: still recording (not sealed)", "the skipped partial segment"],
    [`replay failed for ${threeHours[1].path} (1 h 0 min of footage, not counted): ffmpeg exited 1`, "the failed replay and its minutes"],
    ["4 detector lines or boxes could not be read", "unreadable lines"],
    ["did not say whether the gate looked", "the frames without gateLooked"],
    ["1 replayed file gave no gate totals", "missing gate totals"],
    ["the live events query hit its limit", "a truncated live query"],
    ["2 gated sightings match no sighting of the every-frame run", "unattributed gated sightings"],
    ["other kinds (plates) are not compared: 3 every-frame, 1 gated and 0 live", "kinds not compared"],
  ]) {
    eq(text.includes(needle), true, `names ${what}`);
  }
  eq(text.includes("the two counts differ, and both are shown"), true, "gate totals and frame lines disagreeing are both shown");
  eq(VERDICT.test(text), false, `no verdict words: ${text.match(VERDICT)}`);
});

check("THE FEARED ONE: no people and no frames read as no share - never 100% - in the report too", () => {
  const lines = gateCheckReport(result({
    frames: { total: 0, looked: 0, share: null, reasons: {}, missing: 0 },
    read: { files: 1, frames: 0, looked: 0, belowFloor: 0, unreadable: 0, errors: [] },
    comparison: { ...result().comparison, person: kindCmp(), vehicle: kindCmp() },
  }));
  const text = lines.join("\n");
  eq(/100(\.0)?%/.test(text), false, "no 100% anywhere");
  eq(lines.includes("The gate's totals cover no frames, so there is no share looked at to state."), true, "no frames, no share");
  eq(lines.includes("People the model finds when it looks at every frame: 0, so there is no share found with the gate to state."), true, "no people, no share");
});

check("a share never rounds to a figure it has not reached", () => {
  const lines = gateCheckReport(result({
    frames: { total: 54_000, looked: 1, share: 1 / 54_000, reasons: { first: 1 }, missing: 0 },
    read: { files: 3, frames: 54_000, looked: 1, belowFloor: 0, unreadable: 0, errors: [] },
    comparison: { ...result().comparison, person: kindCmp({ reference: 2000, found: 1999, foundShare: 1999 / 2000, lost: [listed()] }) },
  }));
  eq(lines.some((l) => l.includes("Also found with the gate: 1,999 (over 99.9%)")), true, "1,999 of 2,000 is not 100.0%");
  eq(lines.some((l) => l.includes("looked at 1 of them (under 0.1%)")), true, "1 of 54,000 is not 0.0%");
});

check("end to end: shadow lines through the reader, the comparison and the report", () => {
  const lines = scene(20, (t) => [
    ...(t <= 6 ? [person(0.8, box(0.1))] : []),
    ...(t >= 3 ? [person(0.8, box(0.8))] : []),
  ], (t) => t <= 2);
  const r = read(lines);
  const totals = sumGateTotals([null]);
  const res = result({
    frames: { total: totals.frames, looked: totals.looked, share: totals.share, reasons: totals.reasons, missing: totals.missing },
    read: sumShadowReads([{ path: FILES[0].path, read: r }]),
    comparison: compareShadow({ files: FILES, reference: r.reference, gated: r.gated, live: [] }),
  });
  const text = gateCheckReport(res).join("\n");
  eq(text.includes("People the model finds when it looks at every frame: 2. Also found with the gate: 1 (50.0%). Missed with the gate: 1."), true, text);
  eq(text.includes(`  missed: ${at(3000)} to 03:00:20.000Z, 86 sightings, best confidence 0.80 at ${at(3000)}; footage ${FILES[0].path} at 3.0 s`), true, "the lost one, with where to look");
  eq(text.includes("1 replayed file gave no gate totals"), true, "and the missing totals named");
  eq(JSON.parse(JSON.stringify(res)).comparison.person.lost.length, 1, "the result survives a round trip through JSON, as it is saved");
});

report("gate check");
