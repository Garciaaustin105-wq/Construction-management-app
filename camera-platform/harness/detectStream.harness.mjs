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

// ---------------- travel: did the thing walk in? ----------------
// Known-object suppression never learns or hides anything that travelled, so
// the service must store the same travel the batch fold (and so the scorer
// and the gate check) computes - to the bit, not to a tolerance - and it must
// never shrink while the event is still open.

// Seeded traffic built to make travel matter: walkers crossing the frame at
// different speeds, still things jittering in place, people who walk in and
// stop, and people who walk out and come back - on two cameras.
function travelTraffic(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const frames = [];
  for (let ms = 0; ms < 180_000; ms += 200) {
    const ds = [];
    // Each 30 s a new cast: 16 s of traffic, then a quiet spell longer than
    // MERGE_GAP_MS, so every cast's events finish and new ones open.
    const t = ms % 30_000;
    if (t < 16_000) {
      const step = t / 200;
      for (const cameraId of ["cam-1", "cam-2"]) {
        if (rnd() < 0.1) continue;      // a missed frame now and then
        // A walker crossing left to right at a speed that differs per cast.
        const speed = 0.005 + ((Math.floor(ms / 30_000) * 7) % 5) * 0.002;
        const wx = Math.min(0.85, 0.02 + step * speed);
        ds.push({ cameraId, atUtc: at(ms), kind: "person", confidence: 0.4 + rnd() * 0.6, box: box(wx, 0.05 + rnd() * 0.005) });
        // A still thing, jittering by the detector's noise, far below the walker.
        ds.push({ cameraId, atUtc: at(ms), kind: "person", confidence: 0.5 + rnd() * 0.15,
          box: { x: 0.69 + rnd() * 0.01, y: 0.56 + rnd() * 0.01, w: 0.08 + rnd() * 0.01, h: 0.41 + rnd() * 0.01 } });
        // Out and back: walks right for 8 s, then returns.
        const ob = step < 40 ? step : 80 - step;
        if (ob >= 0) ds.push({ cameraId, atUtc: at(ms), kind: "vehicle", confidence: 0.3 + rnd() * 0.7, box: box(0.05 + ob * 0.01, 0.45, 0.12, 0.08) });
      }
    }
    // Shuffled within the frame: same-moment sightings arrive in any order.
    for (let i = ds.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ds[i], ds[j]] = [ds[j], ds[i]];
    }
    frames.push({ ms, ds });
  }
  return { frames, rnd };
}

check("every streamed event carries exactly its keys, travel among them, and the open state carries the first box", () => {
  const step = advanceFold(emptyFold(), [person(0, 0.1)], at(0));
  eq(Object.keys(step.updated[0].event).sort(), ["bestBox", "bestConfidence", "bestUtc", "cameraId", "count", "firstUtc", "kind", "lastUtc", "travel"], "an update");
  eq(Object.keys(step.state.open[0]).sort(), ["event", "firstBox", "id", "lastBox", "lastMs"], "an open event");
  eq(step.state.open[0].firstBox, box(0.1, 0.2), "the first box is the opening sighting's");
  const done = advanceFold(step.state, [], at(MERGE_GAP_MS + 1));
  eq(Object.keys(done.finished[0].event).sort(), ["bestBox", "bestConfidence", "bestUtc", "cameraId", "count", "firstUtc", "kind", "lastUtc", "travel"], "a finished event");
  eq(Object.is(done.finished[0].event.travel, 0), true, "one sighting: travel exactly 0");
});

check("THE FEARED ONE: the streaming and batch folds agree to the bit on travel, walkers and still things mixed", () => {
  const { frames, rnd } = travelTraffic(2026_09_22);
  const all = frames.flatMap((f) => f.ds);
  const batch = foldDetections(all);
  // Fed as the gate check feeds it: sometimes one frame per call, sometimes
  // several, the clock at the last frame's moment - so the first box has to
  // survive being copied from state to state.
  let state = emptyFold();
  const byId = new Map();
  for (let i = 0; i < frames.length;) {
    const n = 1 + Math.floor(rnd() * 3);
    const group = frames.slice(i, i + n);
    const step = advanceFold(state, group.flatMap((f) => f.ds), at(group[group.length - 1].ms));
    state = step.state;
    for (const u of [...step.updated, ...step.finished]) byId.set(u.id, u.event);
    i += n;
  }
  for (const u of advanceFold(state, [], at(10 ** 9)).finished) byId.set(u.id, u.event);
  const streamed = [...byId.values()].sort((a, b) => Date.parse(a.firstUtc) - Date.parse(b.firstUtc));
  eq(streamed.length, batch.length, `same number of events (${batch.length})`);
  for (let i = 0; i < batch.length; i++) {
    if (!Object.is(streamed[i].travel, batch[i].travel)) {
      throw new Error(`event ${i}: streamed travel ${streamed[i].travel} vs batch ${batch[i].travel}`);
    }
  }
  eq(JSON.stringify(streamed), JSON.stringify(batch), "identical events, field for field");
  // Not vacuous: the traffic really held walkers and still things.
  const walked = batch.filter((e) => e.travel > 1).length;
  const still = batch.filter((e) => e.count >= 20 && e.travel < 0.5).length;
  if (walked < 10) throw new Error(`only ${walked} events travelled more than a diagonal: the check proves little`);
  if (still < 10) throw new Error(`only ${still} long still events: the check proves little`);
});

check("THE FEARED ONE: an event's travel never decreases from one update to the next", () => {
  const { frames } = travelTraffic(777);
  let state = emptyFold();
  const lastTravel = new Map();
  let updates = 0;
  let grew = 0;
  for (const f of frames) {
    const step = advanceFold(state, f.ds, at(f.ms));
    state = step.state;
    for (const u of [...step.updated, ...step.finished]) {
      const prev = lastTravel.get(u.id);
      if (prev !== undefined && u.event.travel < prev) {
        throw new Error(`event ${u.id}: travel fell from ${prev} to ${u.event.travel} at ${f.ms} ms`);
      }
      if (prev !== undefined && u.event.travel > prev) grew++;
      lastTravel.set(u.id, u.event.travel);
      updates++;
    }
  }
  if (grew < 100) throw new Error(`travel grew only ${grew} times in ${updates} updates: the check proves little`);
});

check("THE FEARED ONE: through the real worker path, a walker reads far above 1 and a still thing well under 0.5", () => {
  let state = emptyFold();
  const seen = new Map();
  for (let i = 0; i <= 40; i++) {
    const r = parseWorkerLine(frameLine(i * 200, [
      { kind: "person", confidence: 0.8, box: box(0.05 + i * 0.02, 0.05) },                         // crossing the frame
      { kind: "person", confidence: 0.6, box: { x: 0.697 + (i % 3) * 0.001, y: 0.563, w: 0.088, h: 0.42 - (i % 2) * 0.005 } }, // the umbrella's spot
    ]), "cam-1");
    const step = advanceFold(state, r.detections, at(i * 200));
    state = step.state;
    for (const u of step.updated) seen.set(u.id, u.event);
  }
  const events = [...seen.values()];
  eq(events.length, 2, "two events");
  const walker = events.find((e) => e.bestBox.y < 0.1);
  const still = events.find((e) => e.bestBox.y > 0.5);
  if (!(walker.travel > 2)) throw new Error(`walker travel ${walker.travel}`);
  if (!(still.travel < 0.1)) throw new Error(`still travel ${still.travel}`);
});

check("THE FEARED ONE: the streaming fold refuses a box with no diagonal just as the batch fold does, and keeps the caller's state", () => {
  // Checked detections cannot carry one; an unchecked caller must be stopped
  // rather than store Infinity or NaN as a travel that reads "did not move".
  const zero = { cameraId: "cam-1", atUtc: at(0), kind: "person", confidence: 0.9, box: { x: 0.1, y: 0.1, w: 0, h: 0 } };
  const refused = (fn, word, what) => {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    if (!(err instanceof RangeError) || !err.message.includes(word)) throw new Error(`${what}: expected the "${word}" RangeError, got ${err}`);
  };
  refused(() => advanceFold(emptyFold(), [zero], at(0)), "no diagonal", "a one-sighting event");
  const r1 = advanceFold(emptyFold(), [person(0, 0.1)], at(0));
  const snapshot = JSON.stringify(r1.state);
  refused(() => advanceFold(r1.state, [{ ...person(200, 0.1), box: { x: 0.1, y: NaN, w: 0.1, h: 0.3 } }], at(200)), "could not be read", "an unreadable later box");
  eq(JSON.stringify(r1.state), snapshot, "the state handed in is untouched by the refusal");
  // A plate joins on its text whatever its box: the path by which an
  // unreadable box would reach an OPEN event's travel.
  const plateAt = (ms, b) => ({ cameraId: "gate", atUtc: at(ms), kind: "plate", confidence: 0.9, box: b, plate: "ABC123" });
  const p1 = advanceFold(emptyFold(), [plateAt(0, box(0.1, 0.6, 0.1, 0.05))], at(0));
  const pSnap = JSON.stringify(p1.state);
  refused(() => advanceFold(p1.state, [plateAt(400, { x: NaN, y: 0.6, w: 0.1, h: 0.05 })], at(400)), "could not be read", "an unreadable box joining an open plate");
  eq(JSON.stringify(p1.state), pSnap, "and that state is untouched too");
});

check("advanceFold never mutates the first box or the travel of the state it was given", () => {
  const r1 = advanceFold(emptyFold(), [person(0, 0.1)], at(0));
  const snapshot = JSON.stringify(r1.state);
  const r2 = advanceFold(r1.state, [person(200, 0.12), person(400, 0.14)], at(400));
  eq(JSON.stringify(r1.state), snapshot, "the earlier state is as it was");
  eq(r1.state.open[0].event.travel, 0, "its travel still 0");
  if (!(r2.state.open[0].event.travel > 0)) throw new Error("the new state did move");
  if (r2.state.open[0].firstBox === r1.state.open[0].firstBox) throw new Error("the first box is shared between states, not copied");
  eq(r2.state.open[0].firstBox, box(0.1, 0.2), "and it is still the opening sighting's box");
});

report("detect stream");
