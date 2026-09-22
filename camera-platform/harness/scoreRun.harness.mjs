/**
 * Scoring the detector against the answer key (contracts/scoreRun.ts), run
 * through the real fold (contracts/detection.ts) and the real scorer
 * (contracts/clipLibrary.ts), so what is checked is what the runner reports.
 *
 * THE FEARED FAILURES — each one makes the detector look better than live:
 * - scoring boxes under the live floor: live drops everything under
 *   detect.json's minConfidence (0.5) before folding, replay.py does not;
 * - timing boxes from the clip's start instead of their file's: clip footage
 *   is whole segments, wider than the clip, so every box would shift early;
 * - main-stream footage scored without saying so: live reads the substream;
 * - a short answer key reported as a pass;
 * - something that could not be read, dropped without a word.
 */
import { checkMotionGate, clipFiles, detectionsFromReplay, scoreReport } from "../dist/scoreRun.js";
import { foldDetections } from "../dist/detection.js";
import { scoreLibrary, exitGate, MIN_GATE_PERSONS } from "../dist/clipLibrary.js";
import { check, eq, report } from "./_assert.mjs";

console.log("scoreRun");

const CAM = "cam1-main";
// A linked segment that starts 20 s BEFORE the clip: whole files are linked.
const FILE_START = Date.parse("2026-09-21T15:31:00.000Z");
const CLIP_START = "2026-09-21T15:31:20.000Z";
const CLIP_END = "2026-09-21T15:32:20.000Z";
const box = { x: 0.4, y: 0.5, w: 0.08, h: 0.3 };
const person = (confidence, b = box) => ({ kind: "person", species: "person", confidence, box: b });
const frame = (tSec, ...detections) => JSON.stringify({ frame: Math.round(tSec * 5), tSec, detections });
const read = (lines, minConfidence = 0.5, fileStartMs = FILE_START) =>
  detectionsFromReplay({ cameraId: CAM, fileStartMs, lines, minConfidence });
const clip = (o = {}) => ({
  id: "cam1-main-walk", cameraId: CAM, startUtc: CLIP_START, endUtc: CLIP_END,
  scenes: ["person"], expected: [{ kind: "person", fromUtc: CLIP_START, toUtc: CLIP_END, count: 1 }], ...o,
});
const meta = (o = {}) => ({
  clips: 1, clipsScored: 1, clipsRefused: [], fps: [{ cameraId: CAM, fps: 5, source: "live" }],
  minConfidence: 0.5, model: "yolox_s.onnx", streams: [{ cameraId: CAM, recorded: "sub" }],
  frames: 300, belowFloor: 0, unreadable: 0, replayErrors: [],
  gate: { enabled: false }, gateFrames: 0, gateLooked: 0, ...o,
});

check("THE FLOOR: a box under the live floor is dropped, as live drops it", () => {
  const r = read([frame(30, person(0.3)), frame(30.2, person(0.62))]);
  eq(r.detections.length, 1, "only the 0.62 box survives a 0.5 floor");
  eq(r.belowFloor, 1, "and the 0.3 one is counted as dropped, not lost");
  eq(r.detections[0].confidence, 0.62, "it is the right one");
  // End to end: a clip with only a 0.3 box must score as a miss, not a find.
  const guess = read([frame(30, person(0.3)), frame(30.2, person(0.31))]);
  const score = scoreLibrary({ version: 1, clips: [clip()] }, foldDetections(guess.detections));
  eq(score.person.found, 0, "a 0.3 guess is not a person found");
  eq(score.person.missed.length, 1, "the walk-by is a miss");
});

check("THE CLOCK: a box is timed from its FILE's start, not the clip's", () => {
  // tSec 25 in a file that starts at 15:31:00 is 15:31:25, inside the clip.
  const r = read([frame(25, person(0.9))]);
  eq(r.detections[0].atUtc, "2026-09-21T15:31:25.000Z", "file start plus offset");
  // Timed from the clip start instead, it would be 15:31:45: still inside,
  // so prove it with a box the padding holds: 10 s into the file is 15:31:10,
  // BEFORE the clip, and must not be scored as the clip's person.
  const early = read([frame(10, person(0.9))]);
  const score = scoreLibrary({ version: 1, clips: [clip()] }, foldDetections(early.detections));
  eq(score.person.found, 0, "a person in the padding before the clip is not the clip's person");
});

check("sub-second offsets keep their milliseconds", () => {
  eq(read([frame(1.2, person(0.9))]).detections[0].atUtc, "2026-09-21T15:31:01.200Z", "1.2 s is 1200 ms");
});

check("a walk-by across two linked files folds into ONE event, as live folds it", () => {
  // The person crosses the segment boundary at 15:32:00. Live never sees a
  // boundary; the runner must not split them either.
  const a = read([frame(58.8, person(0.9)), frame(59.8, person(0.9))], 0.5, FILE_START);
  const b = read([frame(0.2, person(0.9)), frame(1.2, person(0.9))], 0.5, FILE_START + 60_000);
  const events = foldDetections([...a.detections, ...b.detections]);
  eq(events.length, 1, "one event, not two");
  const score = scoreLibrary({ version: 1, clips: [clip()] }, events);
  eq(score.person.duplicates, 0, "no split track");
});

check("SAY WHAT YOU COULD NOT USE: junk lines and boxes are counted", () => {
  const r = read([
    "not json", "{}", JSON.stringify({ frame: 1, tSec: -1, detections: [] }),
    frame(3, { kind: "dragon", confidence: 0.9, box }), frame(4, person(0.9)),
    JSON.stringify({ type: "error", message: "could not read the file's picture size" }), "",
  ]);
  eq(r.detections.length, 1, "the one good box");
  eq(r.unreadable, 4, "three bad lines and one bad box, counted");
  eq(r.errors, ["could not read the file's picture size"], "replay's own error is kept in its words");
  eq(r.frames, 2, "two frames were real frames");
});

check("detectionsFromReplay never throws", () => {
  for (const [i, bad] of [null, undefined, {}, { cameraId: CAM }, { cameraId: CAM, fileStartMs: NaN, lines: [], minConfidence: 0.5 },
    { cameraId: CAM, fileStartMs: FILE_START, lines: "x", minConfidence: 0.5 },
    { cameraId: CAM, fileStartMs: FILE_START, lines: [null, 5, {}], minConfidence: 0.5 },
    { cameraId: CAM, fileStartMs: FILE_START, lines: [], minConfidence: 2 }].entries()) {
    let threw = false;
    try { detectionsFromReplay(bad); } catch { threw = true; }
    eq(threw, false, `survived #${i}`);
  }
});

check("clip files are read from their names and ordered by time, not by text", () => {
  const { files, ignored } = clipFiles(["1790000060000.mp4", "999999999999.mp4", "notes.txt", "1790000000000.mp4", "x.mp4"]);
  eq(files.map((f) => f.startMs), [999999999999, 1790000000000, 1790000060000], "numeric order");
  eq(ignored, ["notes.txt", "x.mp4"], "anything else is listed, not guessed at");
});

check("THE FLATTERING STREAM: main-stream footage always says so", () => {
  const score = scoreLibrary({ version: 1, clips: [clip()] }, []);
  const text = scoreReport(score, exitGate(score), meta({ streams: [{ cameraId: CAM, recorded: "main" }] })).join("\n");
  eq(/MAIN stream/.test(text), true, "named");
  eq(/may read better than live/.test(text), true, "and what it means");
  const sub = scoreReport(score, exitGate(score), meta()).join("\n");
  eq(/MAIN stream/.test(sub), false, "and not said when it is not true");
  const unknown = scoreReport(score, exitGate(score), meta({ streams: [{ cameraId: CAM, recorded: "unknown" }] })).join("\n");
  eq(/not known/.test(unknown), true, "an unknown stream is said to be unknown");
});

check("THE SHORT KEY: too few people is never reported as a pass", () => {
  // Three people found out of three is 100%, and means nothing yet.
  const clips = [0, 1, 2].map((i) => clip({
    id: `c${i}`, startUtc: `2026-09-21T1${i}:00:00.000Z`, endUtc: `2026-09-21T1${i}:01:00.000Z`,
    expected: [{ kind: "person", fromUtc: `2026-09-21T1${i}:00:00.000Z`, toUtc: `2026-09-21T1${i}:01:00.000Z`, count: 1 }],
  }));
  const events = clips.map((c) => ({ cameraId: CAM, kind: "person", firstUtc: c.startUtc.replace(":00.000Z", ":10.000Z"),
    lastUtc: c.startUtc.replace(":00.000Z", ":14.000Z"), count: 5, bestConfidence: 0.9, bestBox: box, bestUtc: c.startUtc }));
  const score = scoreLibrary({ version: 1, clips }, events);
  eq(score.person.recall, 1, "100% found");
  const text = scoreReport(score, exitGate(score), meta({ clips: 3, clipsScored: 3 })).join("\n");
  eq(/Not enough to judge/.test(text), true, "says it cannot judge");
  eq(new RegExp(`need at least ${MIN_GATE_PERSONS} expected people, have 3`).test(text), true, "and what is missing, in the gate's words");
  eq(/\bmeets\b/.test(text), false, "and never the word 'meets'");
  eq(/100%/.test(text), true, "while the measurement itself is still shown");
});

check("BLANK IS NOT ZERO: an unmeasured rate reads 'not measured', never 0", () => {
  const empty = scoreLibrary({ version: 1, clips: [clip({ scenes: ["empty"], expected: [] })] }, []);
  const text = scoreReport(empty, exitGate(empty), meta()).join("\n");
  eq(/People: 0 expected, 0 found \(not measured\)/.test(text), true, `recall with nobody expected: ${text.split("\n")[2]}`);
  eq(/\b0%/.test(text), false, "no 0% anywhere");
});

check("the empty answer key says how to fill it", () => {
  const score = scoreLibrary({ version: 1, clips: [] }, []);
  const text = scoreReport(score, exitGate(score), meta({ clips: 0, clipsScored: 0 })).join("\n");
  eq(/Teach the AI/.test(text), true, "points at the button");
  // Found running it on the box: "The gate needs need at least 20...".
  eq(/need need|needs need/.test(text), false, `reads as English: ${text.split("\n")[1]}`);
  eq(/\bmeets\b/.test(text), false, "and judges nothing");
});

check("the settings a score was made with are always stated", () => {
  const score = scoreLibrary({ version: 1, clips: [clip()] }, []);
  const text = scoreReport(score, exitGate(score), meta({
    fps: [{ cameraId: CAM, fps: 2, source: "by_hand" }],
    clipsRefused: [{ clipId: "gone", reason: "its footage is missing" }], unreadable: 3, replayErrors: ["boom"],
  })).join("\n");
  eq(/at 2 fps \(set by hand, not the live rate\)/.test(text), true, "a hand-set rate is labelled");
  eq(/floor 0\.50/.test(text), true, "the floor");
  eq(/yolox_s\.onnx/.test(text), true, "the model");
  eq(/gone: its footage is missing/.test(text), true, "a refused clip, named");
  eq(/3 detector lines or boxes could not be read/.test(text), true, "the unreadable count");
  eq(/replay: boom/.test(text), true, "replay's errors");
});

/** A score built by hand, for numbers real footage would take hours to make. */
const handScore = ({ expected, found, emptyHours, hours = emptyHours + 1, emptyFalse = 0 }) => ({
  hoursScored: hours, emptyHours,
  person: { expected, found, duplicates: 0, falseEvents: emptyFalse, emptyFalseEvents: emptyFalse, missed: [],
    recall: expected ? found / expected : null, falsePerHour: emptyFalse / hours,
    falsePerEmptyHour: emptyHours ? emptyFalse / emptyHours : null },
  vehicle: { expected: 0, found: 0, duplicates: 0, falseEvents: 0, emptyFalseEvents: 0, missed: [],
    recall: null, falsePerHour: 0, falsePerEmptyHour: emptyHours ? 0 : null },
});

check("THE ROUNDED ONE: 94.6% never prints as 95% beside the 95% bar", () => {
  // Found in review: whole-number percentages printed "95%: BELOW the 95% bar".
  const score = handScore({ expected: 37, found: 35, emptyHours: 1.5 }); // 94.59%
  const text = scoreReport(score, exitGate(score), meta({ clips: 40, clipsScored: 40 })).join("\n");
  eq(/people found 94\.6%: BELOW the 95\.0% bar/.test(text), true, `the gate line carries the decimal: ${text.split("\n").find((l) => /people found/.test(l))}`);
  eq(/95%: BELOW/.test(text), false, "and never contradicts itself");
});

check("THE SHORT HOUR: durations under an hour are minutes, and never round up to the gate", () => {
  // Found on the box: a 75-second clip printed "0.0 h of footage". And 0.96 h
  // of empty scene must not read "1.0 h" beside "need at least 1 hour".
  const clipScore = handScore({ expected: 4, found: 4, emptyHours: 0, hours: 75 / 3600 });
  eq(/1\.3 min of footage/.test(scoreReport(clipScore, exitGate(clipScore), meta()).join("\n")), true, "75 s is 1.3 min");
  const almost = handScore({ expected: 30, found: 30, emptyHours: 0.996, hours: 3 });
  const text = scoreReport(almost, exitGate(almost), meta({ clips: 30, clipsScored: 30 })).join("\n");
  eq(/59\.8 min of it empty scene/.test(text), true, "0.996 h is 59.8 min, not 1.0 h");
  eq(/have 0\.99\b/.test(text), true, `the gate's own figure rounds down: ${text.split("\n").find((l) => /Not enough/.test(l))}`);
});

check("THE DILUTED ONE: the false rate printed is per hour of EMPTY scene, as the bar is", () => {
  const score = handScore({ expected: 40, found: 40, emptyHours: 1, hours: 6, emptyFalse: 2 });
  const text = scoreReport(score, exitGate(score), meta({ clips: 41, clipsScored: 41 })).join("\n");
  eq(/false people 2\.00 per hour of empty scene: ABOVE the limit of 1/.test(text), true, "2 per empty hour, over the limit");
  eq(/0\.33/.test(text), false, "the diluted all-hours figure is not what is judged");
  const none = handScore({ expected: 4, found: 4, emptyHours: 0 });
  eq(/not measured: no empty-scene footage/.test(scoreReport(none, exitGate(none), meta()).join("\n")), true,
    "no empty scene says so, rather than showing a rate");
});

// --- Motion-gated inference (protocol items 1, 3 minus windowS, and 4) ---

check("THE MOTION GATE, ABSENT: no key at all means off, unchanged", () => {
  const r = checkMotionGate(undefined);
  eq(r, { ok: true, gate: { enabled: false, threshold: null, keepaliveMs: null } }, "off, nothing given");
});

check("THE MOTION GATE, ENABLED: reads threshold and keepaliveMs when given, null when not", () => {
  eq(checkMotionGate({ enabled: true }), { ok: true, gate: { enabled: true, threshold: null, keepaliveMs: null } },
    "enabled alone: the worker's own defaults");
  eq(checkMotionGate({ enabled: true, threshold: 0.005, keepaliveMs: 10_000 }),
    { ok: true, gate: { enabled: true, threshold: 0.005, keepaliveMs: 10_000 } }, "both given");
  eq(checkMotionGate({ enabled: false, threshold: 0.005 }), { ok: true, gate: { enabled: false, threshold: null, keepaliveMs: null } },
    "enabled:false is off, even carrying a threshold: never partly on");
});

check("THE MOTION GATE, MALFORMED: refused, naming the field — never guessed at", () => {
  for (const [what, raw] of [
    ["not an object", "on"],
    ["an array", [1]],
    ["an unknown key", { enabled: true, mode: "fast" }],
    ["enabled missing", {}],
    ["enabled not a boolean", { enabled: "true" }],
    ["threshold zero", { enabled: true, threshold: 0 }],
    ["threshold one", { enabled: true, threshold: 1 }],
    ["threshold negative", { enabled: true, threshold: -0.1 }],
    ["threshold not a number", { enabled: true, threshold: "0.01" }],
    ["threshold NaN", { enabled: true, threshold: NaN }],
    ["keepaliveMs under 1000", { enabled: true, keepaliveMs: 999 }],
    ["keepaliveMs over 600000", { enabled: true, keepaliveMs: 600_001 }],
    ["keepaliveMs not an integer", { enabled: true, keepaliveMs: 2500.5 }],
  ]) {
    const r = checkMotionGate(raw);
    eq(r.ok, false, `${what}: refused`);
    eq(typeof r.reason === "string" && r.reason.length > 0, true, `${what}: says why`);
    eq(/motionGate/.test(r.reason), true, `${what}: names the field: ${r.reason}`);
  }
  // The boundaries themselves are valid, not malformed.
  eq(checkMotionGate({ enabled: true, threshold: 0.001 }).ok, true, "just above 0");
  eq(checkMotionGate({ enabled: true, threshold: 0.999 }).ok, true, "just below 1");
  eq(checkMotionGate({ enabled: true, keepaliveMs: 1000 }).ok, true, "1000 itself");
  eq(checkMotionGate({ enabled: true, keepaliveMs: 600_000 }).ok, true, "600000 itself");
});

const gateLine = (frames, looked, reasons) => JSON.stringify({ type: "gate", frames, looked, reasons });

check("THE FINAL GATE LINE: parsed into detectionsFromReplay's result, not counted unreadable", () => {
  const r = read([frame(1, person(0.9)), gateLine(600, 14, { first: 1, motion: 10, keepalive: 3 })]);
  eq(r.gate, { frames: 600, looked: 14, reasons: { first: 1, motion: 10, keepalive: 3 } }, "the totals, as printed");
  eq(r.unreadable, 0, "a valid gate line is not an unreadable one");
  eq(r.frames, 1, "and it is not counted as a detection frame either");
});

check("no gate line at all means gate: null — not zero, there was simply no gate", () => {
  eq(read([frame(1, person(0.9))]).gate, null, "the gate was off; nothing claims a total");
});

check("A BAD GATE LINE IS UNREADABLE: never partly accepted, never a guessed total", () => {
  for (const [what, bad] of [
    ["looked over frames", gateLine(10, 11, { motion: 11 })],
    ["reasons short of looked", gateLine(10, 5, { motion: 3 })],
    ["reasons over looked", gateLine(10, 5, { motion: 6 })],
    ["an unknown reason", gateLine(10, 5, { motion: 5, extra: 0 })],
    ["a negative count", gateLine(10, 5, { motion: -5 })],
    ["a fractional count", gateLine(10, 5, { motion: 2.5 })],
    ["frames not an integer", JSON.stringify({ type: "gate", frames: 10.5, looked: 0, reasons: {} })],
    ["reasons not an object", JSON.stringify({ type: "gate", frames: 10, looked: 0, reasons: [] })],
    ["frames missing", JSON.stringify({ type: "gate", looked: 0, reasons: {} })],
  ]) {
    const r = read([bad]);
    eq(r.gate, null, `${what}: no total kept`);
    eq(r.unreadable, 1, `${what}: counted as unreadable instead`);
  }
});

check("THE GATE, STATED: the report always says whether it ran, and how", () => {
  const score = scoreLibrary({ version: 1, clips: [clip()] }, []);
  const off = scoreReport(score, exitGate(score), meta()).join("\n");
  eq(/Motion gate: off, as live runs it\./.test(off), true, "off, plainly");

  const on = scoreReport(score, exitGate(score), meta({
    gate: { enabled: true, threshold: 0.005, keepaliveMs: 10_000 }, gateFrames: 6000, gateLooked: 312,
  })).join("\n");
  eq(/Motion gate: on \(threshold 0\.005, keepalive 10 s\), as live runs it; the model looked at 312 of 6000 frames \(5\.2%\)\./.test(on),
    true, `states threshold, keepalive and the share: ${on.split("\n").find((l) => /Motion gate/.test(l))}`);

  const defaults = scoreReport(score, exitGate(score), meta({
    gate: { enabled: true, threshold: null, keepaliveMs: null }, gateFrames: 100, gateLooked: 100,
  })).join("\n");
  eq(/threshold the worker's default, keepalive the worker's default/.test(defaults), true,
    "a setting left out reads as the worker's default, never as 0 or blank");

  const untouchedLines = scoreReport(score, exitGate(score), meta({
    gate: { enabled: true, threshold: 0.005, keepaliveMs: 10_000 }, gateFrames: 0, gateLooked: 0,
  }));
  const untouchedGateLine = untouchedLines.find((l) => /Motion gate/.test(l));
  eq(/looked at 0 of 0 frames\./.test(untouchedGateLine), true, `zero frames replayed is said plainly: ${untouchedGateLine}`);
  eq(/%\)/.test(untouchedGateLine), false, "and never turned into a percentage of nothing");
});

report("scoreRun");
