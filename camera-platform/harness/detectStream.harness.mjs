/**
 * D1: the detector service's pure core (contracts/detectStream.ts).
 *
 * The AI worker (a separate process running the model) prints one JSON line
 * per frame. The service reads those lines, checks every detection with the
 * existing contract (checkDetection), and folds them into events AS THEY
 * ARRIVE, so an alert can fire while the person is still in view.
 *
 * THE FEARED FAILURES: a worker line that is garbage, huge or hostile taking
 * the service down or getting stored; a detection the contract would refuse
 * getting in because it came through the stream; the streaming fold and the
 * batch fold (foldDetections, which the scorer uses) disagreeing, so the
 * detector is graded on different events than it stores; an event that never
 * finishes, or finishes while the person is still there; a worker's error
 * text (it may hold the camera URL) passed along unscrubbed.
 */
import { parseWorkerLine, emptyFold, advanceFold, MAX_WORKER_LINE_BYTES, GATE_REASONS } from "../dist/detectStream.js";
import { foldDetections, MERGE_GAP_MS } from "../dist/detection.js";
import { check, eq, report } from "./_assert.mjs";

console.log("detect stream");

const T0 = Date.parse("2026-09-19T22:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const box = (x, y, w = 0.1, h = 0.3) => ({ x, y, w, h });
const frameLine = (ms, detections) => JSON.stringify({ type: "frame", atUtc: at(ms), detections });

// ---------------- reading the worker ----------------

check("a frame line becomes checked detections, stamped with this camera and the frame's time", () => {
  const r = parseWorkerLine(frameLine(0, [
    { kind: "person", confidence: 0.82, box: box(0.1, 0.2) },
    { kind: "vehicle", confidence: 0.6, box: box(0.5, 0.5, 0.3, 0.2) },
  ]), "cam-1");
  eq(r.kind, "frame", "a frame");
  eq(r.atUtc, at(0), "its time");
  eq(r.detections.map((d) => [d.cameraId, d.atUtc, d.kind, d.confidence]), [["cam-1", at(0), "person", 0.82], ["cam-1", at(0), "vehicle", 0.6]], "both detections");
  eq(r.refused, [], "nothing refused");
});

check("an empty frame is still a frame: the service knows the worker is alive", () => {
  const r = parseWorkerLine(frameLine(0, []), "cam-1");
  eq([r.kind, r.detections.length], ["frame", 0], "alive, nothing seen");
});

check("a worker line carrying a species parses and keeps it", () => {
  const r = parseWorkerLine(frameLine(0, [
    { kind: "vehicle", confidence: 0.8, box: box(0.2, 0.3), species: "truck" },
  ]), "cam-1");
  eq(r.refused, [], "nothing refused");
  eq(r.detections.map((d) => [d.kind, d.species]), [["vehicle", "truck"]], "the species rides along");
});

check("a line with no species still parses, because that is every worker running today", () => {
  const r = parseWorkerLine(frameLine(0, [{ kind: "person", confidence: 0.8, box: box(0.2, 0.3) }]), "cam-1");
  eq(r.refused, [], "nothing refused");
  eq(r.detections[0].species, undefined, "absent, not defaulted to anything");
});

check("THE FEARED ONE: a species that does not belong to its kind is refused by name, not silently stripped - a truck filed as a person would make a search for trucks return people", () => {
  const r = parseWorkerLine(frameLine(0, [
    { kind: "person", confidence: 0.8, box: box(0.2, 0.3), species: "truck" },   // a truck's species, wrong kind
    { kind: "vehicle", confidence: 0.8, box: box(0.2, 0.3), species: "dog" },    // not in any kind's vocabulary
  ]), "cam-1");
  eq(r.detections.length, 0, "neither detection kept");
  eq(r.refused, ["bad_species", "bad_species"], "both refused and named, so a widening worker is caught here rather than in the database");
});

check("THE FEARED ONE: a detection the contract refuses is refused here too, and named", () => {
  const r = parseWorkerLine(frameLine(0, [
    { kind: "person", confidence: 1.7, box: box(0.1, 0.2) },       // confidence past 1
    { kind: "dog", confidence: 0.9, box: box(0.1, 0.2) },          // not a kind we store
    { kind: "person", confidence: 0.9, box: { x: 0.9, y: 0.1, w: 0.5, h: 0.2 } }, // off the frame
    { kind: "person", confidence: 0.9, box: box(0.1, 0.2), cameraId: "cam-evil", atUtc: at(99_000) }, // tries to set its own camera and time
  ]), "cam-1");
  eq(r.refused.length, 3, "three refused");
  eq(r.detections.length, 1, "the fourth kept");
  eq([r.detections[0].cameraId, r.detections[0].atUtc], ["cam-1", at(0)], "but with this camera and the frame's time, never its own");
});

check("THE FEARED ONE: garbage, huge or hostile lines are invalid, never thrown, never stored", () => {
  for (const [line, what] of [
    ["", "empty"], ["not json", "text"], ["[]", "an array"], ["null", "null"], ["{}", "no type"],
    [JSON.stringify({ type: "frame", atUtc: "yesterday", detections: [] }), "bad time"],
    [JSON.stringify({ type: "frame", atUtc: at(0), detections: "lots" }), "detections not a list"],
    [JSON.stringify({ type: "frame", atUtc: at(0), detections: Array(301).fill({ kind: "person", confidence: 0.9, box: box(0, 0) }) }), "301 detections in one frame"],
    ["x".repeat(MAX_WORKER_LINE_BYTES + 1), "longer than the limit"],
    [JSON.stringify({ type: "shutdown_everything" }), "an unknown type"],
  ]) {
    let r;
    try { r = parseWorkerLine(line, "cam-1"); } catch (err) { throw new Error(`${what}: threw ${err.message}`); }
    eq(r.kind, "invalid", what);
    if (typeof r.reason !== "string" || r.reason === "") throw new Error(`${what}: no reason`);
  }
});

check("ready and error lines are read; an error's text is capped and never trusted as anything but text", () => {
  const ready = parseWorkerLine(JSON.stringify({ type: "ready", model: "yolox_s", inputSize: 640 }), "cam-1");
  eq([ready.kind, ready.model], ["ready", "yolox_s"], "ready");
  const err = parseWorkerLine(JSON.stringify({ type: "error", message: "e".repeat(5000) }), "cam-1");
  eq(err.kind, "error", "error");
  eq(err.message.length <= 500, true, "capped");
  const notText = parseWorkerLine(JSON.stringify({ type: "error", message: { url: "rtsp://a:b@c/d" } }), "cam-1");
  eq(notText.kind, "invalid", "an error whose message is not text is invalid");
});

// ---------------- the motion gate's once-a-minute summary ----------------

const gateLine = (extra) => JSON.stringify({ type: "gate", windowS: 60, frames: 300, looked: 7,
  reasons: { first: 1, motion: 4, keepalive: 2 }, ...extra });

check("a valid gate line is accepted, reasons and all", () => {
  const r = parseWorkerLine(gateLine(), "cam-1");
  eq(r.kind, "gate", "a gate line");
  eq([r.windowS, r.frames, r.looked], [60, 300, 7], "window, frames, looked");
  eq(r.reasons, { first: 1, motion: 4, keepalive: 2 }, "reasons carried through");
});

check("a gate line naming every reason, including zeros, is still accepted", () => {
  const r = parseWorkerLine(gateLine({ looked: 6, reasons: { first: 1, unsure: 0, clock: 0, motion: 4, hold: 0, keepalive: 1 } }), "cam-1");
  eq(r.kind, "gate", "a gate line");
  eq(r.reasons, { first: 1, unsure: 0, clock: 0, motion: 4, hold: 0, keepalive: 1 }, "zeros are not the same as absent, but both are fine here");
});

check("a gate line naming NO reasons because nothing was looked at is still accepted", () => {
  const r = parseWorkerLine(gateLine({ looked: 0, reasons: {} }), "cam-1");
  eq([r.kind, r.looked, r.reasons], ["gate", 0, {}], "zero looks, zero reasons, still a gate line");
});

check("THE FEARED ONE: every way a gate line can be wrong is refused as bad_gate, never partly accepted", () => {
  for (const [extra, why] of [
    [{ looked: 301 }, "looked > frames"],
    [{ reasons: { first: 1, motion: 4, keepalive: 1 } }, "reasons sum (6) short of looked (7)"],
    [{ reasons: { first: 1, motion: 4, keepalive: 3 } }, "reasons sum (8) over looked (7)"],
    [{ reasons: { first: 1, motion: 4, keepalive: 2, dozing: 0 } }, "an unknown reason key"],
    [{ frames: -1, looked: 0, reasons: {} }, "a negative frame count"],
    [{ frames: 300.5 }, "a fractional frame count"],
    [{ looked: 7.5, reasons: { first: 7.5 } }, "a fractional looked count"],
    [{ reasons: { first: 1, motion: 4, keepalive: 1.5 } }, "a fractional reason count"],
    [{ reasons: { first: -1, motion: 4, keepalive: 4 } }, "a negative reason count"],
    [{ windowS: undefined }, "missing windowS"],
    [{ windowS: 0 }, "windowS not positive"],
    [{ windowS: -60 }, "windowS negative"],
    [{ windowS: "60" }, "windowS not a number"],
    [{ frames: "300" }, "frames not a number"],
    [{ reasons: [] }, "reasons is an array, not an object"],
    [{ reasons: null }, "reasons is null"],
    [{ reasons: "none" }, "reasons is not an object at all"],
  ]) {
    const obj = { type: "gate", windowS: 60, frames: 300, looked: 7, reasons: { first: 1, motion: 4, keepalive: 2 }, ...extra };
    const r = parseWorkerLine(JSON.stringify(obj), "cam-1");
    eq(r.kind, "invalid", why);
    eq(r.reason, "bad_gate", `${why}: named bad_gate`);
  }
});

check("GATE_REASONS is exactly the six names motion_gate.py's decide() can return", () => {
  eq([...GATE_REASONS].sort(), ["clock", "first", "hold", "keepalive", "motion", "unsure"].sort(), "the six look reasons");
});

// ---------------- folding as they arrive ----------------

check("THE FEARED ONE: one person across many frames is ONE event, updated as it goes, finished only after the gap", () => {
  let state = emptyFold();
  const seen = [];
  for (let ms = 0; ms <= 4000; ms += 200) {
    const r = parseWorkerLine(frameLine(ms, [{ kind: "person", confidence: 0.5 + ms / 10_000, box: box(0.1 + ms / 100_000, 0.2) }]), "cam-1");
    const step = advanceFold(state, r.detections, at(ms));
    state = step.state;
    seen.push(...step.updated.map((u) => u.id));
    eq(step.finished.length, 0, `nothing finished while the person is still in view (${ms} ms)`);
  }
  eq(new Set(seen).size, 1, "every update is to the same event id");
  const quiet = advanceFold(state, [], at(4000 + MERGE_GAP_MS - 1));
  eq(quiet.finished.length, 0, "not finished just before the gap");
  const done = advanceFold(quiet.state, [], at(4000 + MERGE_GAP_MS + 1));
  eq(done.finished.length, 1, "finished once the gap has passed");
  const ev = done.finished[0].event;
  eq([ev.count, ev.firstUtc, ev.lastUtc, ev.bestUtc], [21, at(0), at(4000), at(4000)], "count, span and best frame");
  eq(done.state.open.length, 0, "nothing left open");
});

check("THE FEARED ONE: the streaming fold and the batch fold give the same events, so the scorer grades what is stored", () => {
  // Seeded pseudo-random traffic: two cameras, people and vehicles, walking,
  // pausing, overlapping, leaving and coming back. Species rides along on
  // most sightings and is missing on the rest, like an older worker mixed in.
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const VEHICLE_SPECIES = ["bus", "car", "motorcycle", "truck"];
  const frames = [];
  for (let ms = 0; ms < 120_000; ms += 200) {
    const ds = [];
    for (const cameraId of ["cam-1", "cam-2"]) {
      const n = Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const kind = rnd() < 0.7 ? "person" : "vehicle";
        const d = { cameraId, atUtc: at(ms), kind, confidence: 0.3 + rnd() * 0.7,
          box: box(Math.floor(rnd() * 3) * 0.3 + rnd() * 0.02, 0.2 + rnd() * 0.02) };
        if (rnd() < 0.6) {
          d.species = kind === "person" ? "person" : VEHICLE_SPECIES[Math.floor(rnd() * VEHICLE_SPECIES.length)];
        }
        ds.push(d);
      }
    }
    if (rnd() < 0.15) { ms += 12_000; } // sometimes a long quiet spell
    frames.push({ ms, ds });
  }
  const all = frames.flatMap((f) => f.ds);
  const batch = foldDetections(all);
  let state = emptyFold();
  const byId = new Map();
  for (const f of frames) {
    const step = advanceFold(state, f.ds, at(f.ms));
    state = step.state;
    for (const u of [...step.updated, ...step.finished]) byId.set(u.id, u.event);
  }
  const end = advanceFold(state, [], at(10 ** 9));
  for (const u of end.finished) byId.set(u.id, u.event);
  const streamed = [...byId.values()].sort((a, b) => Date.parse(a.firstUtc) - Date.parse(b.firstUtc));
  eq(streamed.length, batch.length, `same number of events (${batch.length})`);
  eq(JSON.stringify(streamed), JSON.stringify(batch), "identical events, field for field");
});

check("advanceFold never mutates the state it was given", () => {
  const s0 = emptyFold();
  const r1 = advanceFold(s0, [{ cameraId: "cam-1", atUtc: at(0), kind: "person", confidence: 0.9, box: box(0.1, 0.1) }], at(0));
  eq(s0.open.length, 0, "the empty state stays empty");
  const snapshot = JSON.stringify(r1.state);
  advanceFold(r1.state, [{ cameraId: "cam-1", atUtc: at(200), kind: "person", confidence: 0.95, box: box(0.1, 0.1) }], at(200));
  eq(JSON.stringify(r1.state), snapshot, "a later step leaves the earlier state as it was");
});

// ---------------- which event each sighting joined ----------------
// The gate check compares two folds sighting by sighting, so it has to know
// the event each detection went into exactly, not by time overlap.

const person = (ms, x, confidence = 0.8) => ({ cameraId: "cam-1", atUtc: at(ms), kind: "person", confidence, box: box(x, 0.2) });

check("assigned: one event id per detection, in INPUT order, agreeing with updated - even when the batch arrives out of time order", () => {
  const first = advanceFold(emptyFold(), [person(0, 0.1)], at(0));
  const a = first.assigned[0];
  eq(first.assigned, [first.updated[0].id], "the opening sighting names the event it opened");
  // A second person far to the right at 400 ms, listed BEFORE the first
  // person's 200 ms sighting: the fold walks them sorted, the ids come back
  // in the order they were given.
  const step = advanceFold(first.state, [person(400, 0.8), person(200, 0.11)], at(400));
  eq(step.assigned.length, 2, "one id per detection");
  eq(step.assigned[1], a, "the 200 ms sighting joined the first person's event");
  eq(step.assigned[0] !== a, true, "the 400 ms sighting is someone else");
  eq(step.updated.map((u) => u.id), [step.assigned[1], step.assigned[0]], "updated is in time order; assigned in input order; same ids");
});

check("THE FEARED ONE: two people in one frame get two different ids", () => {
  const step = advanceFold(emptyFold(), [person(0, 0.1), person(0, 0.8)], at(0));
  eq(step.assigned.length, 2, "one id each");
  eq(step.assigned[0] !== step.assigned[1], true, "never the same event");
  eq([...step.assigned].sort(), step.updated.map((u) => u.id).sort(), "and both are the ids updated names");
});

check("two sightings of one person in one batch each name that one event, not one id for the pair", () => {
  const first = advanceFold(emptyFold(), [person(0, 0.1)], at(0));
  const a = first.assigned[0];
  const step = advanceFold(first.state, [person(400, 0.12), person(200, 0.11)], at(400));
  eq(step.assigned, [a, a], "both joined the same event");
  eq(step.updated.map((u) => u.id), [a, a], "updated touched it twice");
});

check("an empty batch assigns nothing", () => {
  eq(advanceFold(emptyFold(), [], at(0)).assigned, [], "no detections, no ids");
});

check("THE FEARED ONE: across mixed traffic, every event's count is exactly the number of sightings assigned to it", () => {
  let s = 777;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let state = emptyFold();
  const perId = new Map();
  const finalById = new Map();
  let fed = 0;
  let assignedTotal = 0;
  for (let ms = 0; ms < 60_000; ms += 200) {
    const ds = [];
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      ds.push({ cameraId: "cam-1", atUtc: at(ms - Math.floor(rnd() * 2) * 100), kind: rnd() < 0.7 ? "person" : "vehicle",
        confidence: 0.5 + rnd() * 0.5, box: box(Math.floor(rnd() * 3) * 0.3 + rnd() * 0.02, 0.2) });
    }
    if (rnd() < 0.1) ms += 11_000;
    fed += ds.length;
    const step = advanceFold(state, ds, at(ms));
    state = step.state;
    eq(step.assigned.length, ds.length, `one id per detection at ${ms} ms`);
    for (const id of step.assigned) { perId.set(id, (perId.get(id) ?? 0) + 1); assignedTotal++; }
    for (const u of [...step.updated, ...step.finished]) finalById.set(u.id, u.event);
  }
  for (const u of advanceFold(state, [], at(10 ** 9)).finished) finalById.set(u.id, u.event);
  eq(assignedTotal, fed, "every detection fed was assigned");
  eq([...perId.keys()].sort(), [...finalById.keys()].sort(), "the ids assigned are exactly the events produced");
  for (const [id, n] of perId) eq(finalById.get(id).count, n, `event ${id}: count matches its sightings`);
});

report("detect stream");
