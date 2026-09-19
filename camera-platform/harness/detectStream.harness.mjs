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
import { parseWorkerLine, emptyFold, advanceFold, MAX_WORKER_LINE_BYTES } from "../dist/detectStream.js";
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
  // pausing, overlapping, leaving and coming back.
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const frames = [];
  for (let ms = 0; ms < 120_000; ms += 200) {
    const ds = [];
    for (const cameraId of ["cam-1", "cam-2"]) {
      const n = Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        ds.push({ cameraId, atUtc: at(ms), kind: rnd() < 0.7 ? "person" : "vehicle", confidence: 0.3 + rnd() * 0.7,
          box: box(Math.floor(rnd() * 3) * 0.3 + rnd() * 0.02, 0.2 + rnd() * 0.02) });
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

report("detect stream");
