/**
 * The scoring runner end to end (agent/score-clips.mjs), with real files in
 * temp directories and a fake detector process standing in for replay.py.
 *
 * THE FEARED FAILURES, each of which makes the detector look better than it
 * is, or blames it for footage it never saw:
 * - replaying at replay.py's default 5 fps instead of the rate live GRANTED;
 * - trimming a segment to the clip (--start / --frames), which splits a
 *   walk-by that crosses the clip's edge;
 * - scoring against a different floor or model than live runs;
 * - counting a clip whose footage is gone as people missed;
 * - scoring a key that could be wrong;
 * - running the detector at full priority beside the live one.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScore, recordedStream, SCORES_DIR } from "../agent/score-clips.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("scoreClips");

const CAM = "cam1-main";
const T0 = Date.parse("2026-09-21T15:31:00.000Z");
const box = { x: 0.4, y: 0.5, w: 0.08, h: 0.3 };
const iso = (ms) => new Date(ms).toISOString();

/** A fake replay.py: prints `framesFor(file)` and exits with `codeFor(file)`. */
function fakeSpawn({ framesFor = () => [], codeFor = () => 0, hang = false } = {}) {
  const calls = [];
  const spawnFn = (cmd, argv) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const file = argv[argv.indexOf("--file") + 1];
    child.killed = false;
    child.kill = () => { child.killed = true; };
    if (hang) return child;
    setImmediate(() => {
      for (const f of framesFor(file)) child.stdout.emit("data", JSON.stringify(f) + "\n");
      const code = codeFor(file);
      if (code !== 0) child.stderr.emit("data", "Traceback...\nRuntimeError: model file is damaged\n");
      child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}
const walk = (fromSec, toSec, confidence = 0.9) => {
  const out = [];
  for (let t = fromSec; t <= toSec; t += 0.2) {
    out.push({ frame: Math.round(t * 5), tSec: Math.round(t * 1000) / 1000, detections: [{ kind: "person", species: "person", confidence, box }] });
  }
  return out;
};

/** A site on disk: a state dir and two drives, torn down after each check. */
function site({ clips, detect = { minConfidence: 0.5, model: "/opt/camplat-models/yolox_s.onnx" },
  health = { cameras: [{ cameraId: CAM, state: "watching", grantedFps: 3 }] }, library, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), "camplat-score-"));
  const stateDir = join(root, "state");
  const drives = [join(root, "d0"), join(root, "d1")];
  for (const d of [stateDir, ...drives]) mkdirSync(d, { recursive: true });
  if (library !== undefined) writeFileSync(join(stateDir, "clip-library.json"), library);
  else if (clips) writeFileSync(join(stateDir, "clip-library.json"), JSON.stringify({ version: 1, clips }));
  if (detect) writeFileSync(join(stateDir, "detect.json"), JSON.stringify(detect));
  if (health) writeFileSync(join(stateDir, "detect-health.json"), JSON.stringify(health));
  // files: { clipId: [[driveIndex, startMs], ...] }
  for (const [clipId, list] of Object.entries(files)) {
    for (const [drive, startMs] of list) {
      const dir = join(drives[drive], ".camplat-clips", clipId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${startMs}.mp4`), "");
    }
  }
  return { root, stateDir, drives, done: () => rmSync(root, { recursive: true, force: true }) };
}
const clip = (id, startMs, endMs, people, o = {}) => ({
  id, cameraId: CAM, startUtc: iso(startMs), endUtc: iso(endMs),
  scenes: people > 0 ? ["person"] : ["empty"],
  expected: people > 0 ? [{ kind: "person", fromUtc: iso(startMs), toUtc: iso(endMs), count: people }] : [], ...o,
});
const config = (s, cameras = [{ cameraId: CAM, host: "192.168.1.64", vendor: "hikvision" }]) =>
  ({ storeRoots: s.drives, cameras });
const run = (s, spawn, o = {}) => runScore({
  stateDir: s.stateDir, config: config(s), python: "py", replayPath: "/opt/camplat/detector/replay.py",
  spawnFn: spawn.spawnFn, now: () => new Date("2026-09-21T22:00:00Z"), gateStateDir: s.root, ...o,
});

await check("THE LIVE SETTINGS: the granted rate, the live model, whole files, niced", async () => {
  const s = site({ clips: [clip("walk", T0 + 20_000, T0 + 80_000, 1)], files: { walk: [[1, T0 + 60_000], [0, T0]] } });
  try {
    const spawn = fakeSpawn();
    await run(s, spawn);
    eq(spawn.calls.length, 2, "one replay per linked file");
    for (const c of spawn.calls) {
      eq(c.cmd, "nice", "under nice");
      eq(c.argv.slice(0, 3), ["-n", "19", "py"], "at the lowest priority, so live detection keeps the CPU");
      eq(c.argv[c.argv.indexOf("--fps") + 1], "3", "at the 3 fps live GRANTED, not replay.py's default 5");
      eq(c.argv[c.argv.indexOf("--model") + 1], "/opt/camplat-models/yolox_s.onnx", "with the live model");
      eq(c.argv.includes("--start") || c.argv.includes("--frames"), false, "and the WHOLE file: never trimmed to the clip");
    }
    eq(spawn.calls.map((c) => c.argv[c.argv.indexOf("--file") + 1].endsWith(`${T0}.mp4`)), [true, false],
      "oldest file first, found across both drives");
  } finally { s.done(); }
});

await check("a walk-by across two files is found once, and the result is saved", async () => {
  const s = site({ clips: [clip("walk", T0 + 20_000, T0 + 80_000, 1)], files: { walk: [[0, T0], [0, T0 + 60_000]] } });
  try {
    const spawn = fakeSpawn({ framesFor: (f) => (f.endsWith(`${T0}.mp4`) ? walk(55, 59.8) : walk(0, 4)) });
    const r = await run(s, spawn);
    eq(r.score.person.found, 1, "found");
    eq(r.score.person.duplicates, 0, "as one event across the file boundary");
    const saved = readdirSync(join(s.stateDir, SCORES_DIR));
    eq(saved.length, 1, "one result file");
    const body = JSON.parse(readFileSync(join(s.stateDir, SCORES_DIR, saved[0]), "utf8"));
    eq(body.meta.fps, [{ cameraId: CAM, fps: 3, source: "live" }], "which records the rate it ran at");
    eq(body.meta.minConfidence, 0.5, "and the floor");
    eq(saved.some((n) => n.endsWith(".tmp")), false, "written atomically");
  } finally { s.done(); }
});

await check("THE FLOOR: detect.json's floor applies end to end", async () => {
  const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
    detect: { minConfidence: 0.7, model: "/m/x.onnx" } });
  try {
    const r = await run(s, fakeSpawn({ framesFor: () => walk(10, 14, 0.6) }));
    eq(r.score.person.found, 0, "0.6 boxes are under a 0.7 floor: not found");
    eq(r.meta.belowFloor > 0, true, "and counted as dropped");
    eq(r.lines.some((l) => /floor 0\.70; model x\.onnx/.test(l)), true, "the report states the floor and model used");
  } finally { s.done(); }
});

await check("THE MISSING FOOTAGE: a clip with nothing linked is named, not scored as a miss", async () => {
  const s = site({ clips: [clip("here", T0, T0 + 60_000, 1), clip("gone", T0 + 120_000, T0 + 180_000, 2)],
    files: { here: [[0, T0]] } });
  try {
    const r = await run(s, fakeSpawn({ framesFor: () => walk(10, 14) }));
    eq(r.score.person.expected, 1, "only the clip with footage is scored: the missing two are not blamed on the detector");
    eq(r.meta.clipsRefused, [{ clipId: "gone", reason: "its footage is missing" }], "and the missing one is named");
    eq(r.lines.some((l) => /Could not use: gone: its footage is missing/.test(l)), true, "in the report");
  } finally { s.done(); }
});

await check("THE UNTRUSTED KEY: a key that could be wrong is refused whole", async () => {
  for (const [what, library] of [["unparseable", "{not json"],
    ["self-contradicting", JSON.stringify({ version: 1, clips: [clip("bad", T0, T0 + 60_000, 1, { scenes: ["empty"] })] })]]) {
    const s = site({ library, files: { bad: [[0, T0]] } });
    try {
      const spawn = fakeSpawn();
      const r = await run(s, spawn);
      eq(typeof r.refused, "string", `${what}: refused`);
      eq(spawn.calls.length, 0, `${what}: the detector is never run`);
      let saved = [];
      try { saved = readdirSync(join(s.stateDir, SCORES_DIR)); } catch { /* none */ }
      eq(saved.length, 0, `${what}: nothing is saved`);
    } finally { s.done(); }
  }
});

await check("a camera live does not watch is refused, unless a rate is given by hand, and then labelled", async () => {
  const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] }, health: { cameras: [] } });
  try {
    const refused = await run(s, fakeSpawn());
    eq(refused.meta.clipsRefused[0].reason.includes("not watching"), true, "refused, saying why");
    eq(refused.meta.clipsRefused[0].reason.includes("--fps"), true, "and how to score it anyway");
    const byHand = await run(s, fakeSpawn({ framesFor: () => walk(10, 14) }), { fpsByHand: 2 });
    eq(byHand.meta.fps, [{ cameraId: CAM, fps: 2, source: "by_hand" }], "scored at the given rate");
    eq(byHand.lines.some((l) => /set by hand, not the live rate/.test(l)), true, "and labelled in the report");
  } finally { s.done(); }
});

check("THE FLATTERING STREAM: the stream a camera records is worked out as the recorder does", () => {
  eq(recordedStream({ cameraId: "a", host: "h" }), "main", "built from its host with no stream: the recorder asks for main");
  eq(recordedStream({ cameraId: "a", host: "h", stream: "sub" }), "sub", "stream: sub");
  eq(recordedStream({ cameraId: "a", url: "rtsp://h/x" }), "unknown", "a typed-in URL could be either");
  eq(recordedStream(undefined), "unknown", "a camera no longer configured");
});

await check("the detector failing is reported, not taken for an empty scene", async () => {
  const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] } });
  try {
    const r = await run(s, fakeSpawn({ codeFor: () => 1 }));
    eq(r.meta.replayErrors.length, 1, "one failure");
    eq(/exited with 1: RuntimeError: model file is damaged/.test(r.meta.replayErrors[0]), true, `with its last words: ${r.meta.replayErrors[0]}`);
    eq(r.lines.some((l) => /Could not use: .*replay: walk\//.test(l)), true, "in the report");
    // Found in review: this check's title was never asserted. A replay that
    // did not run looked at nothing; scoring it blamed the detector.
    eq(r.score.person.expected, 0, "the clip is NOT scored: its person is not counted as missed");
    eq(r.meta.clipsRefused.map((x) => x.clipId), ["walk"], "it is refused, like missing footage");
    eq(/could not replay it/.test(r.meta.clipsRefused[0].reason), true, `and says why: ${r.meta.clipsRefused[0].reason}`);
  } finally { s.done(); }
});

await check("THE ABSENT WORKER: a granted rate with no worker running is not the live rate", async () => {
  // Found in review: detect-service gives a camera its grantedFps before it
  // tries to start the worker, so a camera with no usable substream sits in
  // detect-health.json as { state: "no_substream", grantedFps: 5 } while
  // live never looks at it.
  for (const state of ["no_substream", "unknown_camera", "starting", undefined]) {
    const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
      health: { cameras: [{ cameraId: CAM, state, grantedFps: 5 }] } });
    try {
      const spawn = fakeSpawn({ framesFor: () => walk(10, 14) });
      const r = await run(s, spawn);
      eq(spawn.calls.length, 0, `state ${state}: nothing replayed`);
      eq(r.meta.fps, [], `state ${state}: no rate is claimed as live`);
      eq(/not watching/.test(r.meta.clipsRefused[0]?.reason ?? ""), true, `state ${state}: refused, saying why`);
    } finally { s.done(); }
  }
});

await check("a replay that hangs is stopped, and the clip is refused", async () => {
  const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] } });
  try {
    const spawn = fakeSpawn({ hang: true });
    const started = Date.now();
    const r = await run(s, spawn, { timeoutMs: 50 });
    eq(Date.now() - started < 5000, true, "the run finishes instead of waiting forever");
    eq(r.meta.clipsRefused.map((x) => x.clipId), ["walk"], "the clip is refused");
    eq(/did not finish/.test(r.meta.clipsRefused[0].reason), true, `saying so: ${r.meta.clipsRefused[0].reason}`);
  } finally { s.done(); }
});

await check("a result that cannot be saved still leaves the whole report", async () => {
  const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] } });
  try {
    writeFileSync(join(s.stateDir, SCORES_DIR), "a file where the directory should be");
    const r = await run(s, fakeSpawn({ framesFor: () => walk(10, 14) }));
    eq(r.score.person.found, 1, "the scoring happened");
    eq(r.lines.length > 3, true, "the report is there");
    eq(r.savedTo, null, "nothing claims to be saved");
    eq(typeof r.saveError, "string", "and the reason it was not is returned");
  } finally { s.done(); }
});

await check("an empty answer key says how to fill it, runs nothing and saves nothing", async () => {
  const s = site({ clips: undefined, detect: null, health: null });
  try {
    const spawn = fakeSpawn();
    const r = await run(s, spawn);
    eq(r.lines[0].includes("Teach the AI"), true, "points at the button");
    eq(spawn.calls.length, 0, "nothing run");
    eq(r.savedTo, null, "nothing saved");
  } finally { s.done(); }
});

// --- Motion-gated inference (protocol items 1, 2 and 4) ---

await check("THE FEARED ONE: a gated live service is scored with the gate", async () => {
  const s = site({
    clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
    detect: { minConfidence: 0.6, model: "/m/x.onnx", motionGate: { enabled: true, threshold: 0.01, keepaliveMs: 20_000 } },
  });
  try {
    const spawn = fakeSpawn({ framesFor: () => walk(10, 14) });
    const r = await run(s, spawn);
    const argv = spawn.calls[0].argv;
    eq(argv.slice(argv.length - 11, argv.length - 4), ["--gate", "--track-floor", "0.6", "--gate-threshold", "0.01", "--gate-keepalive-ms", "20000"],
      `the gate args follow everything replay.py already took, in order: ${argv.join(" ")}`);
    eq([argv.at(-4), argv.at(-2), argv.at(-1)], ["--gate-state", "--gate-clock-offset-ms", "0"],
      "then the carried state, and the file's place on the clip's clock");
    eq(r.meta.gate, { enabled: true, threshold: 0.01, keepaliveMs: 20_000 }, "recorded on the result");
  } finally { s.done(); }
});

await check("an ungated site's replay argv is byte-for-byte what it always was", async () => {
  const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] } }); // no motionGate key at all
  try {
    const spawn = fakeSpawn({ framesFor: () => walk(10, 14) });
    const r = await run(s, spawn);
    const argv = spawn.calls[0].argv;
    eq(argv.length, 12, "not one extra element: -n 19 py replay --file f --model m --fps n --threads 1");
    eq(argv.includes("--gate"), false, "no gate flag");
    eq(argv.includes("--track-floor"), false, "no floor flag");
    eq(r.meta.gate, { enabled: false }, "recorded as off");
  } finally { s.done(); }
});

await check("only the setting given is passed on; enabled:false launches ungated even carrying settings", async () => {
  const s1 = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
    detect: { minConfidence: 0.5, motionGate: { enabled: true, threshold: 0.02 } } });
  try {
    const spawn = fakeSpawn({ framesFor: () => walk(10, 14) });
    await run(s1, spawn);
    eq(spawn.calls[0].argv.slice(-9, -4), ["--gate", "--track-floor", "0.5", "--gate-threshold", "0.02"],
      "no --gate-keepalive-ms when keepaliveMs was not given");
  } finally { s1.done(); }

  const s2 = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
    detect: { minConfidence: 0.5, motionGate: { enabled: false, threshold: 0.02, keepaliveMs: 5000 } } });
  try {
    const spawn = fakeSpawn({ framesFor: () => walk(10, 14) });
    const r = await run(s2, spawn);
    eq(spawn.calls[0].argv.includes("--gate"), false, "enabled:false: no gate flag at all");
    eq(r.meta.gate, { enabled: false }, "and recorded as off, not as a half-on state");
  } finally { s2.done(); }
});

await check("THE MALFORMED GATE: refused before anything runs, naming the field, like a bad minConfidence", async () => {
  for (const [what, motionGate] of [
    ["enabled not a boolean", { enabled: "yes" }],
    ["threshold out of range", { enabled: true, threshold: 1 }],
    ["threshold the wrong type", { enabled: true, threshold: "0.01" }],
    ["keepaliveMs out of range", { enabled: true, keepaliveMs: 500 }],
    ["keepaliveMs not an integer", { enabled: true, keepaliveMs: 2500.5 }],
    ["an unknown key", { enabled: true, mode: "fast" }],
  ]) {
    const s = site({ clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
      detect: { minConfidence: 0.5, motionGate } });
    try {
      const spawn = fakeSpawn();
      const r = await run(s, spawn);
      eq(typeof r.refused, "string", `${what}: refused`);
      eq(/motionGate/.test(r.refused), true, `${what}: names the field: ${r.refused}`);
      eq(spawn.calls.length, 0, `${what}: the detector is never run — there is no live behaviour to match`);
    } finally { s.done(); }
  }
});

await check("ONE GATE PER CLIP: a clip's files carry the gate across, on the clip's clock; clips do not share one", async () => {
  // Found in review: each file used to start a fresh gate, with a free first
  // look and a reset keepalive at every segment boundary. Live never does.
  const s = site({
    clips: [clip("walk", T0, T0 + 120_000, 1), clip("later", T0 + 600_000, T0 + 660_000, 1)],
    files: { walk: [[1, T0 + 60_000], [0, T0]], later: [[0, T0 + 600_000]] },
    detect: { minConfidence: 0.5, motionGate: { enabled: true } },
  });
  try {
    // A stale state file where the first clip's will go: from a run that died.
    const stale = join(s.root, `camplat-gate-${process.pid}-0.json`);
    writeFileSync(stale, JSON.stringify({ state: { last_look_ms: 1, last_seen_ms: 1 }, boxes: [], prev: null }));
    const seen = [];
    const base = fakeSpawn({ framesFor: () => walk(10, 11) });
    const spawn = {
      calls: base.calls,
      spawnFn: (cmd, argv) => {
        const at = argv[argv.indexOf("--gate-state") + 1];
        seen.push({ at, existed: existsSync(at), offset: argv[argv.indexOf("--gate-clock-offset-ms") + 1] });
        writeFileSync(at, "{}"); // what replay.py leaves at the end
        return base.spawnFn(cmd, argv);
      },
    };
    await run(s, spawn);
    eq(seen.length, 3, "three replays");
    eq(seen[0].at, seen[1].at, "both of the first clip's files carry one gate");
    eq(seen[2].at !== seen[0].at, true, "the second clip gets its own");
    eq(seen.map((x) => x.offset), ["0", "60000", "0"], "each file placed on its clip's clock, in time order");
    eq(seen.map((x) => x.existed), [false, true, false], "a stale state is cleared first; the second file picks up the first's");
    eq(existsSync(seen[0].at) || existsSync(seen[2].at), false, "and nothing is left behind");
  } finally { s.done(); }
});

await check("THE GATE TOTALS REACH THE REPORT: the final gate line becomes the report's frames looked", async () => {
  const s = site({
    clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
    detect: { minConfidence: 0.5, motionGate: { enabled: true, threshold: 0.005, keepaliveMs: 10_000 } },
  });
  try {
    const spawn = fakeSpawn({
      framesFor: () => [...walk(10, 10.2), { type: "gate", frames: 100, looked: 5, reasons: { first: 1, motion: 4 } }],
    });
    const r = await run(s, spawn);
    eq(r.meta.gateFrames, 100, "summed from the final line");
    eq(r.meta.gateLooked, 5, "and looked");
    eq(r.lines.some((l) => /Motion gate: on \(threshold 0\.005, keepalive 10 s\), as live runs it; the model looked at 5 of 100 frames \(5\.0%\)\./.test(l)),
      true, `stated in the report: ${r.lines.find((l) => /Motion gate/.test(l))}`);
  } finally { s.done(); }
});

await check("A BAD GATE LINE IS UNREADABLE: malformed totals never silently read as zero", async () => {
  const s = site({
    clips: [clip("walk", T0, T0 + 60_000, 1)], files: { walk: [[0, T0]] },
    detect: { minConfidence: 0.5, motionGate: { enabled: true } },
  });
  try {
    const spawn = fakeSpawn({
      // looked (20) exceeds frames (10): invalid, per protocol item 3/4.
      framesFor: () => [...walk(10, 10.2), { type: "gate", frames: 10, looked: 20, reasons: {} }],
    });
    const r = await run(s, spawn);
    eq(r.meta.gateFrames, 0, "not counted as a total");
    eq(r.meta.unreadable, 1, "counted as unreadable instead");
  } finally { s.done(); }
});

report("scoreClips");
