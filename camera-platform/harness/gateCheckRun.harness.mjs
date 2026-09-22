/**
 * The gate check end to end (agent/gate-check.mjs and `camctl gate-check`),
 * with a real temp state directory, a fake detector process standing in for
 * replay.py --gate-shadow, and a fake recording index and events database:
 * nothing real is opened, nothing outside the temp directory is written
 * (build rule 21).
 *
 * THE FEARED FAILURES:
 * - a camera URL, user name or password reaching a report line, the result,
 *   the saved file or the progress log: the owner found a camera password in
 *   a log once, and it must never happen again;
 * - replaying the main stream (or anything else) and calling it what live
 *   sees: the footage must be the recording of the stream the detector
 *   reads, matched on host, port and path;
 * - a fresh gate at every file, or two cameras sharing one gate;
 * - replaying at a rate, floor, thread count or priority live does not use;
 * - partial segments replayed as whole ones, or dropped without a word;
 * - a failed replay read as a quiet stretch, or sinking the whole check;
 * - the gate off live previewed without saying so, or labelled with
 *   defaults the worker does not use;
 * - a result written anywhere but the state directory;
 * - a bad flag running an hour of replay on a guess.
 */
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, eq, report } from "./_assert.mjs";

// CAMPLAT_GATECHECK_UNDER_TEST / CAMPLAT_CAMCTL_UNDER_TEST: a mutated copy to
// run these checks against, so a mutation check never edits the shared file.
const here = dirname(fileURLToPath(import.meta.url));
const modulePath = process.env.CAMPLAT_GATECHECK_UNDER_TEST ?? join(here, "../agent/gate-check.mjs");
const camctlPath = process.env.CAMPLAT_CAMCTL_UNDER_TEST ?? join(here, "../agent/camctl.mjs");
const { runGateCheck, gateCheckFileName, GATE_CHECKS_DIR, GATE_DEFAULTS } = await import(pathToFileURL(modulePath).href);

console.log("gateCheckRun");

const T0 = Date.parse("2026-09-21T03:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const BOX = { x: 0.4, y: 0.5, w: 0.08, h: 0.3 };

// The fake site's logins. Distinctive, so a leak cannot hide in ordinary text;
// the password carries characters that URL-encode, so the encoded form a URL
// would hold is looked for too.
const USER = "gk-viewer-7731";
const PASS = "Pa55@w0rd/zz#9";
const CAM_USER = "yard-login";
const CAM_PASS = "own-cam-S3cret";
const FORBIDDEN = ["rtsp", USER, PASS, encodeURIComponent(PASS), CAM_USER, CAM_PASS];
function noSecrets(text, what) {
  const lower = String(text).toLowerCase();
  for (const f of FORBIDDEN) {
    if (lower.includes(f.toLowerCase())) throw new Error(`${what} contains ${JSON.stringify(f)}: ${String(text).slice(0, 300)}`);
  }
}

const CAMERAS = [
  // Live watches cam2; cam2 itself records the MAIN stream.
  { cameraId: "cam2", host: "192.168.4.64", vendor: "hikvision" },
  // The substream live reads for cam2, recorded as a camera of its own.
  { cameraId: "cam2-sub", host: "192.168.4.64", vendor: "hikvision", stream: "sub" },
  // Watched, and nothing records its substream.
  { cameraId: "cam3", host: "192.168.4.65", vendor: "hikvision" },
  // Live reads a typed-in substream for cam4 ...
  { cameraId: "cam4", host: "10.0.0.9", substreamUrl: "rtsp://10.0.0.9:8554/detect" },
  // ... two decoys, the same path on another port and another path on the
  // same port, listed first so a loose comparison would pick one ...
  { cameraId: "cam4-wrong-port", url: "rtsp://10.0.0.9:554/detect" },
  { cameraId: "cam4-wrong-path", url: "rtsp://10.0.0.9:8554/other" },
  // ... and the real recording of it, under a login of its own.
  { cameraId: "cam4-rec", url: `rtsp://${CAM_USER}:${encodeURIComponent(CAM_PASS)}@10.0.0.9:8554/detect` },
];

const LIVE_GATE = { minConfidence: 0.6, model: "/opt/camplat-models/yolox_s.onnx", motionGate: { enabled: true, threshold: 0.01, keepaliveMs: 8000 } };

/** A site on disk: a state dir, two drives and a gate-state dir, torn down after each check. */
function site({ detect = LIVE_GATE, health = { cameras: [{ cameraId: "cam2", state: "watching", grantedFps: 4 }] },
  index = true, events = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "camplat-gatecheck-"));
  const stateDir = join(root, "state");
  const drives = [join(root, "d0"), join(root, "d1")];
  const gateDir = join(root, "gate");
  for (const d of [stateDir, gateDir, ...drives]) mkdirSync(d, { recursive: true });
  if (detect) writeFileSync(join(stateDir, "detect.json"), JSON.stringify(detect));
  if (health) writeFileSync(join(stateDir, "detect-health.json"), JSON.stringify(health));
  // The fakes open nothing, but the command checks the files are there
  // before opening them (a missing one must not be created).
  if (index) writeFileSync(join(stateDir, "index.db"), "");
  if (events) writeFileSync(join(stateDir, "events.db"), "");
  const seg = (cameraId, startMs, { state = "sealed", drive = 0, lengthMs = MIN, endUtc } = {}) => ({
    cameraId, startUtc: iso(startMs), endUtc: endUtc !== undefined ? endUtc : iso(startMs + lengthMs),
    path: `${cameraId}/${startMs}.mp4`, state, root: drives[drive], bytes: 1000, hold: false, pendingUpload: false, bitrateKbps: null,
  });
  const fileAt = (cameraId, startMs, drive = 0) => join(drives[drive], `${cameraId}/${startMs}.mp4`);
  return { root, stateDir, drives, gateDir, seg, fileAt, done: () => rmSync(root, { recursive: true, force: true }) };
}
const config = (s, cameras = CAMERAS) => ({ storeRoots: s.drives, credentials: { username: USER, password: PASS }, cameras });

/** The recording index, as segindex.mjs answers: rows handed back in the order given, not sorted. */
function fakeIndex(rows) {
  const log = { opened: [], forCamera: [], inRange: [], closed: 0 };
  const openIndexFn = (file) => {
    log.opened.push(file);
    return {
      forCamera: (id) => { log.forCamera.push(id); return rows.filter((r) => r.cameraId === id).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc)); },
      inRange: (id, from, to) => {
        log.inRange.push([id, from, to]);
        return rows.filter((r) => r.cameraId === id && Date.parse(r.startUtc) < Date.parse(to) &&
          (r.endUtc === null || Date.parse(r.endUtc) > Date.parse(from)));
      },
      close: () => { log.closed++; },
    };
  };
  return { openIndexFn, log };
}

/** events.db, as events-db.mjs answers inRange. */
function fakeEvents(events = [], { truncated = false } = {}) {
  const log = { opened: [], inRange: [], closed: 0 };
  const openEventsFn = (file) => {
    log.opened.push(file);
    return { inRange: (...a) => { log.inRange.push(a); return { events, truncated }; }, close: () => { log.closed++; } };
  };
  return { openEventsFn, log };
}

/** A fake replay.py: prints linesFor(file), writes stderrFor(file), exits codeFor(file). */
function fakeSpawn({ linesFor = () => shadow(), codeFor = () => 0, stderrFor = () => "" } = {}) {
  const calls = [];
  const spawnFn = (cmd, argv) => {
    const file = argv[argv.indexOf("--file") + 1];
    const state = argv.includes("--gate-state") ? argv[argv.indexOf("--gate-state") + 1] : null;
    calls.push({ cmd, argv, file, state, stateExisted: state !== null && existsSync(state) });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      for (const l of linesFor(file)) child.stdout.emit("data", (typeof l === "string" ? l : JSON.stringify(l)) + "\n");
      const err = stderrFor(file);
      if (err) child.stderr.emit("data", err);
      const code = codeFor(file);
      if (code === 0 && state !== null) writeFileSync(state, "{}"); // what replay.py leaves at the end
      child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}

/**
 * One file's --gate-shadow output: every frame at `fps` for `seconds`, the
 * people in view as given, `looked(tSec)` marking the frames the gate would
 * have looked at, then the file's gate totals.
 */
function shadow({ seconds = 60, fps = 4, people = [], looked = () => false, totals = true } = {}) {
  const out = [];
  let n = 0;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    const t = Math.round((i / fps) * 1000) / 1000;
    const detections = people.filter((p) => t >= p.from && t <= p.to)
      .map((p) => ({ kind: p.kind ?? "person", confidence: p.confidence ?? 0.9, box: p.box ?? BOX }));
    const l = looked(t);
    if (l) n++;
    out.push({ frame: i, tSec: t, detections, gateLooked: l });
  }
  if (totals) out.push({ type: "gate", frames, looked: n, reasons: n > 0 ? { motion: n } : {} });
  return out;
}

const run = (s, { spawn = fakeSpawn(), index = fakeIndex([]), events = fakeEvents(), cameras, ...o } = {}) => runGateCheck({
  stateDir: s.stateDir, config: config(s, cameras), python: "py", replayPath: "/opt/camplat/detector/replay.py",
  now: () => new Date("2026-09-21T22:00:00Z"), gateStateDir: s.gateDir,
  spawnFn: spawn.spawnFn, openIndexFn: index.openIndexFn, openEventsFn: events.openEventsFn, ...o,
});
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

await check("THE LIVE SETTINGS: shadow mode, the live floor, the granted rate, the threads, the model, niced", async () => {
  const s = site({ health: { cameras: [{ cameraId: "cam2", state: "watching", grantedFps: 4 }, { cameraId: "cam4", state: "watching", grantedFps: 3 }] } });
  try {
    const spawn = fakeSpawn();
    const index = fakeIndex([s.seg("cam2-sub", T0), s.seg("cam4-rec", T0, { drive: 1 })]);
    const r = await run(s, { spawn, index, threads: 3, fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(r.results.map((x) => x.refused), [null, null], "both cameras checked");
    eq(spawn.calls.length, 2, "one replay per file");
    for (const [c, fps] of [[spawn.calls[0], "4"], [spawn.calls[1], "3"]]) {
      eq(c.cmd, "nice", "under nice");
      eq(c.argv.slice(0, 3), ["-n", "19", "py"], "at the lowest priority, so live detection keeps the CPU");
      eq(after(c.argv, "--fps"), fps, "at the rate live GRANTED that camera");
      eq(after(c.argv, "--threads"), "3", "with the threads asked for");
      eq(after(c.argv, "--model"), "/opt/camplat-models/yolox_s.onnx", "with the live model");
      eq(c.argv.slice(c.argv.indexOf("--gate"), c.argv.indexOf("--gate-state")),
        ["--gate", "--gate-shadow", "--track-floor", "0.6", "--gate-threshold", "0.01", "--gate-keepalive-ms", "8000"],
        `shadow mode, with the live floor and the live gate settings: ${c.argv.join(" ")}`);
      eq(c.argv.includes("--start") || c.argv.includes("--frames"), false, "and the whole file");
    }
    const res = r.results[0].result;
    eq(res.settings, { fps: 4, fpsSource: "live", minConfidence: 0.6, model: "yolox_s.onnx", gate: { threshold: 0.01, keepaliveMs: 8000, liveEnabled: true } },
      "the result records what it ran with");
    eq(r.results[0].lines.some((l) => l === "The gate is ON on this NVR (threshold 0.01, keepalive 8 s); this replays it as set."), true, "and the report says so");
  } finally { s.done(); }
});

await check("ONE GATE PER CAMERA: a camera's files carry one gate on one clock; two cameras never share one", async () => {
  const s = site({ health: { cameras: [{ cameraId: "cam2", state: "watching", grantedFps: 4 }, { cameraId: "cam4", state: "watching", grantedFps: 3 }] } });
  try {
    // A stale state file where the first camera's will go: from a run that died.
    const stale = join(s.gateDir, `camplat-gatecheck-${process.pid}-0.json`);
    writeFileSync(stale, JSON.stringify({ state: { last_look_ms: 1 }, boxes: [], prev: null }));
    const spawn = fakeSpawn();
    // Handed back out of time order, across both drives.
    const index = fakeIndex([s.seg("cam2-sub", T0 + 2 * MIN), s.seg("cam2-sub", T0, { drive: 1 }), s.seg("cam2-sub", T0 + MIN),
      s.seg("cam4-rec", T0 + 5 * MIN), s.seg("cam4-rec", T0 + 4 * MIN)]);
    await run(s, { spawn, index, fromUtc: iso(T0), toUtc: iso(T0 + 6 * MIN) });
    eq(spawn.calls.map((c) => c.file), [s.fileAt("cam2-sub", T0, 1), s.fileAt("cam2-sub", T0 + MIN), s.fileAt("cam2-sub", T0 + 2 * MIN),
      s.fileAt("cam4-rec", T0 + 4 * MIN), s.fileAt("cam4-rec", T0 + 5 * MIN)], "each camera's files in time order, on the drive the index names");
    const cam2 = spawn.calls.slice(0, 3);
    const cam4 = spawn.calls.slice(3);
    eq(new Set(cam2.map((c) => c.state)).size, 1, "cam2's three files carry one gate");
    eq(new Set(cam4.map((c) => c.state)).size, 1, "cam4's two files carry one gate");
    eq(cam2[0].state !== cam4[0].state, true, "and the two cameras do not share it");
    eq(spawn.calls.every((c) => dirname(c.state) === s.gateDir), true, "kept in the gate-state directory");
    eq(cam2.map((c) => after(c.argv, "--gate-clock-offset-ms")), ["0", "60000", "120000"], "each file placed on its camera's clock");
    eq(cam4.map((c) => after(c.argv, "--gate-clock-offset-ms")), ["0", "60000"], "the second camera on its own clock");
    eq(spawn.calls.map((c) => c.stateExisted), [false, true, true, false, true], "a stale state is cleared first; each later file picks up the last");
    eq(readdirSync(s.gateDir), [], "and nothing is left behind");
  } finally { s.done(); }
});

await check("THE FOOTAGE IS THE STREAM LIVE READS: matched on host, port and path; a camera with no such recording is refused", async () => {
  const s = site({ health: { cameras: ["cam2", "cam3", "cam4"].map((cameraId) => ({ cameraId, state: "watching", grantedFps: 4 })) } });
  try {
    const spawn = fakeSpawn();
    const index = fakeIndex([s.seg("cam2", T0), s.seg("cam2-sub", T0), s.seg("cam3", T0),
      s.seg("cam4-wrong-port", T0), s.seg("cam4-wrong-path", T0), s.seg("cam4-rec", T0)]);
    const r = await run(s, { spawn, index, fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    const [cam2, cam3, cam4] = r.results;
    eq(cam2.result.camera, { detectCameraId: "cam2", footageCameraId: "cam2-sub", footageIsLiveStream: true },
      "cam2: its substream's recording, not cam2's own main-stream footage");
    eq(cam4.result.camera, { detectCameraId: "cam4", footageCameraId: "cam4-rec", footageIsLiveStream: true },
      "cam4: past the decoys on another port and another path, whatever login it records with");
    eq(/no recording of the stream the live detector reads for cam3/.test(cam3.refused ?? ""), true, `cam3 refused, saying why: ${cam3.refused}`);
    eq(/--footage-camera/.test(cam3.refused), true, "and how to check it anyway");
    eq(spawn.calls.map((c) => c.file), [s.fileAt("cam2-sub", T0), s.fileAt("cam4-rec", T0)], "only the matched recordings are replayed");
    eq(index.log.inRange.map((q) => q[0]), ["cam2-sub", "cam4-rec"], "and the index is only asked for them");
    eq(cam2.lines[0].includes("of cam2-sub, the stream the live detector reads for cam2,"), true, `the report names both: ${cam2.lines[0]}`);
  } finally { s.done(); }
});

await check("NO SECRET LEAVES: no line, result field, saved file or progress message holds a URL, user name or password", async () => {
  const s = site({ health: { cameras: ["cam2", "cam3", "cam4"].map((cameraId) => ({ cameraId, state: "watching", grantedFps: 4 })) } });
  try {
    const leakyUrl = `rtsp://${USER}:${encodeURIComponent(PASS)}@192.168.4.64:554/Streaming/Channels/102`;
    const spawn = fakeSpawn({
      // The detector's own words carry every secret there is: an error line
      // in a replay that finished, and the last stderr line of one that did not.
      linesFor: () => [{ type: "error", message: `opened ${leakyUrl} as ${USER} with ${PASS}` },
        ...shadow({ people: [{ from: 10, to: 12 }], looked: (t) => t >= 10 && t <= 11 })],
      codeFor: (f) => (f.endsWith(`${T0 + MIN}.mp4`) ? 1 : 0),
      stderrFor: (f) => (f.endsWith(`${T0 + MIN}.mp4`)
        ? `Traceback...\nRuntimeError: ${CAM_USER}:${CAM_PASS} refused at rtsp://${CAM_USER}:${CAM_PASS}@10.0.0.9:8554/detect and ${encodeURIComponent(PASS)}\n`
        : ""),
    });
    const index = fakeIndex([s.seg("cam2-sub", T0), s.seg("cam2-sub", T0 + MIN), s.seg("cam4-rec", T0), s.seg("cam4-rec", T0 + MIN)]);
    const progress = [];
    const r = await run(s, { spawn, index, fromUtc: iso(T0), toUtc: iso(T0 + 2 * MIN), progress: (m) => progress.push(m) });
    eq(r.results.map((x) => x.cameraId), ["cam2", "cam3", "cam4"], "three cameras");
    eq(r.results[0].result.span.failed.length, 1, "the failure is kept");
    eq(/exited with 1: RuntimeError: \*\*\*:\*\*\* refused at \[a camera address\]/.test(r.results[0].result.span.failed[0].error), true,
      `and still says what happened, the secrets blanked: ${r.results[0].result.span.failed[0].error}`);
    eq(r.results[0].lines.some((l) => /opened \[a camera address\] as \*\*\* with \*\*\*/.test(l)), true, "the detector's error line is reported, blanked");
    for (const x of r.results) {
      noSecrets(JSON.stringify(x), `${x.cameraId}'s result`);
      for (const line of x.lines) noSecrets(line, `${x.cameraId}'s report line`);
      if (x.savedTo) noSecrets(readFileSync(x.savedTo, "utf8"), `${x.cameraId}'s saved file`);
    }
    eq(r.results.filter((x) => x.savedTo).length, 2, "both checked cameras saved (so the saved files were searched)");
    for (const m of progress) noSecrets(m, "a progress message");
    eq(progress.length > 0, true, "progress was reported (so it was searched)");
  } finally { s.done(); }
});

await check("PARTIAL SEGMENTS: only sealed segments are replayed; the rest are skipped and named", async () => {
  const s = site();
  try {
    const spawn = fakeSpawn();
    const index = fakeIndex([s.seg("cam2-sub", T0), s.seg("cam2-sub", T0 + MIN, { state: "partial" }), s.seg("cam2-sub", T0 + 2 * MIN),
      s.seg("cam2-sub", T0 + 3 * MIN, { state: "sealed", endUtc: null }), s.seg("cam2-sub", T0 + 4 * MIN, { state: "open", endUtc: null })]);
    const r = await run(s, { spawn, index, fromUtc: iso(T0), toUtc: iso(T0 + 5 * MIN) });
    eq(spawn.calls.map((c) => c.file), [s.fileAt("cam2-sub", T0), s.fileAt("cam2-sub", T0 + 2 * MIN)], "only the sealed ones with an end are replayed");
    const res = r.results[0].result;
    eq(res.span.skipped, [
      { path: s.fileAt("cam2-sub", T0 + MIN), reason: "a partial segment, cut off mid-write, not sealed" },
      { path: s.fileAt("cam2-sub", T0 + 3 * MIN), reason: "sealed, but its end time is not recorded" },
      { path: s.fileAt("cam2-sub", T0 + 4 * MIN), reason: "still being recorded" },
    ], "each skipped one is named with its reason");
    eq(r.results[0].lines.some((l) => l === `  - skipped ${s.fileAt("cam2-sub", T0 + MIN)}: a partial segment, cut off mid-write, not sealed.`), true,
      "in the report's could-not-use list");
    eq(res.span.files.map((f) => f.startMs), [T0, T0 + 2 * MIN], "the replayed files are the result's files");
  } finally { s.done(); }
});

await check("A FAILED FILE: listed with its error and length, its frames not counted, the rest still compared", async () => {
  const s = site();
  try {
    const spawn = fakeSpawn({
      linesFor: (f) => (f.endsWith(`${T0}.mp4`)
        ? shadow({ people: [{ from: 10, to: 14 }], looked: (t) => t >= 10 && t <= 11 })   // found
        : shadow({ people: [{ from: 30, to: 33 }], looked: () => false })),                // never looked at: lost
      codeFor: (f) => (f.endsWith(`${T0 + MIN}.mp4`) ? 1 : 0),
      stderrFor: () => "Traceback...\nRuntimeError: model file is damaged\n",
    });
    const index = fakeIndex([s.seg("cam2-sub", T0), s.seg("cam2-sub", T0 + MIN), s.seg("cam2-sub", T0 + 2 * MIN)]);
    const r = await run(s, { spawn, index, fromUtc: iso(T0), toUtc: iso(T0 + 3 * MIN) });
    const res = r.results[0].result;
    eq(res.span.failed.map((f) => f.path), [s.fileAt("cam2-sub", T0 + MIN)], "the failed file is listed");
    eq(/exited with 1: RuntimeError: model file is damaged/.test(res.span.failed[0].error), true, `with its last words: ${res.span.failed[0].error}`);
    eq(res.span.files.length, 3, "and kept among the files, so its length can be stated");
    eq([res.read.files, res.read.frames, res.frames.total], [2, 480, 480], "its frames are counted nowhere");
    eq([res.comparison.person.reference, res.comparison.person.found, res.comparison.person.lost.length], [2, 1, 1],
      "the other two files are still compared: the person looked at is found, the one never looked at is lost");
    const lost = res.comparison.person.lost[0];
    eq(lost.footage.path, s.fileAt("cam2-sub", T0 + 2 * MIN), "the lost one points at its footage");
    eq(lost.footage.offsetSec >= 30 && lost.footage.offsetSec <= 33, true, `at its offset: ${lost.footage.offsetSec}`);
    eq([res.span.replayedFromUtc, res.span.replayedToUtc], [iso(T0), iso(T0 + 3 * MIN)], "the replayed span");
    eq(r.results[0].lines.some((l) => l.startsWith(`  - replay failed for ${s.fileAt("cam2-sub", T0 + MIN)} (1 min of footage, not counted)`)), true,
      "the report names it and what it cost");
    eq(r.results[0].lines.some((l) => /Missed with the gate: 1\./.test(l)), true, "and the miss");
  } finally { s.done(); }
});

await check("EVERY FILE FAILED: refused, nothing saved, no gate state left", async () => {
  const s = site();
  try {
    const spawn = fakeSpawn({ codeFor: () => 1, stderrFor: () => "RuntimeError: no onnxruntime\n" });
    const index = fakeIndex([s.seg("cam2-sub", T0), s.seg("cam2-sub", T0 + MIN)]);
    const events = fakeEvents();
    const r = await run(s, { spawn, index, events, fromUtc: iso(T0), toUtc: iso(T0 + 2 * MIN) });
    eq(/every replay failed \(2 files\)/.test(r.results[0].refused ?? ""), true, `refused, saying why: ${r.results[0].refused}`);
    eq(/no onnxruntime/.test(r.results[0].refused), true, "with the first error");
    eq([r.results[0].result, r.results[0].savedTo], [null, null], "no result, nothing claimed saved");
    eq(existsSync(join(s.stateDir, GATE_CHECKS_DIR)), false, "nothing written");
    eq(readdirSync(s.gateDir), [], "no gate state left");
    eq(events.log.closed, 1, "and events.db is closed");
  } finally { s.done(); }
});

await check("THE GATE OFF LIVE: previewed at the worker's own defaults, no settings passed, and labelled", async () => {
  for (const [what, motionGate] of [["absent", undefined], ["enabled:false, carrying settings", { enabled: false, threshold: 0.02, keepaliveMs: 9000 }]]) {
    const s = site({ detect: { minConfidence: 0.5, ...(motionGate ? { motionGate } : {}) } });
    try {
      const spawn = fakeSpawn();
      const r = await run(s, { spawn, index: fakeIndex([s.seg("cam2-sub", T0)]), fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
      const argv = spawn.calls[0].argv;
      eq(argv.slice(argv.indexOf("--gate"), argv.indexOf("--gate-state")), ["--gate", "--gate-shadow", "--track-floor", "0.5"],
        `${what}: the gate runs beside the model, with no threshold or keepalive of its own`);
      eq(r.results[0].result.settings.gate, { threshold: 0.005, keepaliveMs: 5000, liveEnabled: false }, `${what}: recorded as off live`);
      eq(r.results[0].lines.includes("The gate is OFF on this NVR; this previews it at threshold 0.005, keepalive 5 s."), true,
        `${what}: labelled as a preview`);
    } finally { s.done(); }
  }
});

check("THE LABEL IS TRUE: the defaults the report names are motion_gate.py's own", () => {
  const py = readFileSync(join(here, "../detector/motion_gate.py"), "utf8");
  const threshold = Number(/^DEFAULT_THRESHOLD\s*=\s*([\d._]+)/m.exec(py)?.[1].replace(/_/g, ""));
  const keepaliveMs = Number(/^DEFAULT_KEEPALIVE_MS\s*=\s*([\d._]+)/m.exec(py)?.[1].replace(/_/g, ""));
  eq({ threshold, keepaliveMs }, { ...GATE_DEFAULTS }, "gate-check.mjs's GATE_DEFAULTS match detector/motion_gate.py");
});

await check("SAVED UNDER THE STATE DIRECTORY ONLY, atomically; a save that fails keeps the report", async () => {
  const s = site();
  try {
    const r = await run(s, { index: fakeIndex([s.seg("cam2-sub", T0)]), fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    const dir = join(s.stateDir, GATE_CHECKS_DIR);
    eq(r.results[0].savedTo, join(dir, "2026-09-21T22-00-00.000Z-cam2.json"), "under <state>/gate-checks, named by time and camera");
    eq(readdirSync(dir), ["2026-09-21T22-00-00.000Z-cam2.json"], "one file, no .tmp left");
    const body = JSON.parse(readFileSync(r.results[0].savedTo, "utf8"));
    eq([body.atUtc, body.camera.footageCameraId, Array.isArray(body.lines)], ["2026-09-21T22:00:00.000Z", "cam2-sub", true], "the result and its report");
    eq(readdirSync(s.root).sort(), ["d0", "d1", "gate", "state"], "nothing written beside the state directory");
    eq(readdirSync(s.stateDir).sort(), ["detect-health.json", "detect.json", "events.db", GATE_CHECKS_DIR, "index.db"].sort(), "and nothing else in it");
    // Found in review: ids that differ only in characters the name cannot
    // hold must not share a file; an ordinary id keeps its plain name.
    const names = ["cam:1", "cam/1", "cam_1"].map((id) => gateCheckFileName("2026-09-21T22:00:00.000Z", id));
    eq(new Set(names).size, 3, `three ids, three files: ${names.join(", ")}`);
    eq(names[2], "2026-09-21T22-00-00.000Z-cam_1.json", "an id that needed no change is not tagged");
    for (const id of ["../../etc/cron.d/x", "a\\..\\..\\b", "cam:2"]) {
      const name = gateCheckFileName("2026-09-21T22:00:00.000Z", id);
      eq(/[/\\:]/.test(name), false, `a camera id cannot climb out of the directory: ${name}`);
      eq(dirname(resolve(dir, name)), resolve(dir), `${id} lands in the directory`);
    }
  } finally { s.done(); }
  const s2 = site();
  try {
    writeFileSync(join(s2.stateDir, GATE_CHECKS_DIR), "a file where the directory should be");
    const r = await run(s2, { index: fakeIndex([s2.seg("cam2-sub", T0)]), fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(r.results[0].lines.length > 5, true, "the report is there");
    eq(r.results[0].savedTo, null, "nothing claims to be saved");
    eq(typeof r.results[0].saveError, "string", "and the reason is returned");
  } finally { s2.done(); }
});

await check("THE LIVE EVENTS: asked for the replayed span widened by the fold's gap, both kinds, with a limit that is reported when hit", async () => {
  const s = site();
  try {
    const spawn = fakeSpawn({ linesFor: () => shadow({ people: [{ from: 10, to: 12 }, { from: 40, to: 41, kind: "vehicle" }], looked: () => true }) });
    const liveEvent = (kind, fromMs, toMs) => ({ id: `${kind}-${fromMs}`, cameraId: "cam2", kind, firstUtc: iso(fromMs), lastUtc: iso(toMs), count: 3,
      bestConfidence: 0.8, bestBox: BOX, bestUtc: iso(fromMs), finished: true });
    // A person stored live beside the replayed person; a vehicle stored live
    // at the person's moment, 28 s from the replayed vehicle. Kinds never
    // cross-match, so it stands alone.
    // And a person stored live 5 s after the only replayed file ends, inside
    // the query's 10 s margin: live-only, and in no replayed file (found in
    // review: it was pointed 65 s into a 60 s file).
    const events = fakeEvents([liveEvent("person", T0 + 11_000, T0 + 12_000), liveEvent("vehicle", T0 + 10_000, T0 + 12_000),
      liveEvent("person", T0 + MIN + 5_000, T0 + MIN + 6_000)], { truncated: true });
    const r = await run(s, { spawn, index: fakeIndex([s.seg("cam2-sub", T0)]), events, fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(events.log.inRange, [["cam2", iso(T0 - 10_000), iso(T0 + MIN + 10_000), ["person", "vehicle"], 20_000]],
      "asked of the DETECT camera, over the replayed span plus 10 s each side");
    const c = r.results[0].result.comparison;
    eq([c.person.live.storedLive, c.person.live.liveOnly.length], [1, 1], "the person is stored live; the later one is live-only");
    eq(c.person.live.liveOnly[0].footage, null, "and past the replayed file's end it points at no footage");
    eq([c.vehicle.reference, c.vehicle.live.storedLive, c.vehicle.live.liveOnly.length], [1, 0, 1],
      "the vehicle stored at the person's moment matches neither: live-only, and the replayed vehicle not stored live");
    eq(r.results[0].result.live, { truncated: true }, "the limit being hit is kept");
    eq(r.results[0].lines.some((l) => /the live events query hit its limit/.test(l)), true, "and reported");
    eq(events.log.closed, 1, "events.db is closed");
  } finally { s.done(); }
});

await check("FOOTAGE BY HAND: labelled not the live stream unless it is; refused when it is not a camera, or stands in for several", async () => {
  const s = site();
  try {
    const index = fakeIndex([s.seg("cam2", T0), s.seg("cam2-sub", T0)]);
    const main = await run(s, { index, footageCameraId: "cam2", fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(main.results[0].result.camera, { detectCameraId: "cam2", footageCameraId: "cam2", footageIsLiveStream: false }, "cam2's main stream is not what live reads");
    const lines = main.results[0].lines;
    eq(lines[0].includes("which is NOT the stream the live detector reads for cam2 (chosen by hand)"), true, `the first line says so: ${lines[0]}`);
    for (const l of lines.filter((x) => /^(The gate would|People|Vehicles|Stored live)/.test(x.replace("[not the live stream] ", "")))) {
      eq(l.startsWith("[not the live stream] "), true, `every measurement line carries it: ${l}`);
    }
    eq(lines.some((l) => /cam2 is not the stream the live detector reads for cam2/.test(l)), true, "and the could-not-use list names it");
    const sub = await run(s, { index, footageCameraId: "cam2-sub", fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(sub.results[0].result.camera.footageIsLiveStream, true, "the substream's recording chosen by hand IS the live stream, and says so");
    const none = await run(s, { index, footageCameraId: "nope", fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(/nope is not in the camera config/.test(none.results[0].refused ?? ""), true, `an unknown recording is refused: ${none.results[0].refused}`);
  } finally { s.done(); }
  const s2 = site({ health: { cameras: [{ cameraId: "cam2", state: "watching", grantedFps: 4 }, { cameraId: "cam4", state: "watching", grantedFps: 4 }] } });
  try {
    const spawn = fakeSpawn();
    const r = await run(s2, { spawn, footageCameraId: "cam2-sub" });
    eq(/needs the one camera/.test(r.refused ?? ""), true, `one recording cannot stand in for two cameras: ${r.refused}`);
    eq(spawn.calls.length, 0, "nothing is replayed");
  } finally { s2.done(); }
});

await check("A CAMERA LIVE DOES NOT WATCH: refused, unless a rate is given by hand, and then labelled", async () => {
  const s = site({ health: { cameras: [{ cameraId: "cam2", state: "no_substream", grantedFps: 5 }] } });
  try {
    const index = fakeIndex([s.seg("cam2-sub", T0)]);
    const spawn = fakeSpawn();
    const top = await run(s, { spawn, index });
    eq(/not watching any camera/.test(top.refused ?? ""), true, `with none watching and none named: ${top.refused}`);
    const refused = await run(s, { spawn, index, cameraId: "cam2", fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(/not watching cam2/.test(refused.results[0].refused ?? "") && /--fps/.test(refused.results[0].refused), true,
      `named, it is refused, saying how to check it anyway: ${refused.results[0].refused}`);
    eq(spawn.calls.length, 0, "a granted rate with no worker running is not the live rate: nothing replayed");
    const byHand = await run(s, { spawn, index, cameraId: "cam2", fpsByHand: 2, fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
    eq(after(spawn.calls[0].argv, "--fps"), "2", "replayed at the rate given");
    eq(byHand.results[0].result.settings.fpsSource, "by_hand", "recorded as by hand");
    eq(byHand.results[0].lines[0].includes("(set by hand, not the live rate)"), true, "and labelled");
  } finally { s.done(); }
});

await check("THE DEFAULT WINDOW: the hours ending where the newest sealed footage ends, not at the clock", async () => {
  const s = site();
  try {
    const index = fakeIndex([0, 1, 2, 3, 4].map((k) => s.seg("cam2-sub", T0 + k * MIN)).concat([s.seg("cam2-sub", T0 + 5 * MIN, { state: "open", endUtc: null })]));
    const spawn = fakeSpawn();
    const r = await run(s, { spawn, index, hours: 0.05 });
    eq(index.log.inRange, [["cam2-sub", iso(T0 + 2 * MIN), iso(T0 + 5 * MIN)]], "3 min ending at the newest sealed end");
    eq(spawn.calls.map((c) => c.file), [2, 3, 4].map((k) => s.fileAt("cam2-sub", T0 + k * MIN)), "those files replayed");
    eq([r.results[0].result.span.requestedFromUtc, r.results[0].result.span.requestedToUtc], [iso(T0 + 2 * MIN), iso(T0 + 5 * MIN)], "and recorded as asked for");
    const empty = await run(s, { spawn, index: fakeIndex([]), hours: 1 });
    eq(/no sealed recording of cam2-sub/.test(empty.results[0].refused ?? ""), true, `no footage at all is refused: ${empty.results[0].refused}`);
  } finally { s.done(); }
});

await check("UNTRUSTED SETTINGS: detect.json missing, unreadable or malformed refuses before anything runs", async () => {
  for (const [what, write, pattern] of [
    ["missing", null, /no detect\.json/],
    ["unparseable", "{not json", /detect\.json cannot be read/],
    ["a floor that is not a number", JSON.stringify({ minConfidence: "high" }), /minConfidence/],
    ["a malformed gate", JSON.stringify({ minConfidence: 0.5, motionGate: { enabled: true, threshold: 2 } }), /motionGate/],
  ]) {
    const s = site({ detect: null });
    try {
      if (write !== null) writeFileSync(join(s.stateDir, "detect.json"), write);
      const spawn = fakeSpawn();
      const index = fakeIndex([s.seg("cam2-sub", T0)]);
      const r = await run(s, { spawn, index });
      eq(pattern.test(r.refused ?? ""), true, `${what}: refused, naming it: ${r.refused}`);
      eq([spawn.calls.length, index.log.opened.length], [0, 0], `${what}: nothing opened or run`);
    } finally { s.done(); }
  }
});

await check("A MISSING INDEX OR events.db IS REFUSED, NOT CREATED", async () => {
  for (const [what, opts, pattern] of [["index", { index: false }, /no index at/], ["events.db", { events: false }, /no events\.db/]]) {
    const s = site(opts);
    try {
      const spawn = fakeSpawn();
      const index = fakeIndex([s.seg("cam2-sub", T0)]);
      const events = fakeEvents();
      const r = await run(s, { spawn, index, events, fromUtc: iso(T0), toUtc: iso(T0 + MIN) });
      eq(pattern.test(r.results[0].refused ?? ""), true, `no ${what}: refused: ${r.results[0].refused}`);
      eq(spawn.calls.length, 0, `no ${what}: nothing replayed`);
      eq(what === "index" ? index.log.opened.length : events.log.opened.length, 0, `no ${what}: never opened, so never created`);
    } finally { s.done(); }
  }
});

// ---------------------------------------------------------------- the command line

const camctl = (dir, flags) => spawnSync(process.execPath, [camctlPath, "gate-check", ...flags],
  { env: { ...process.env, CAMPLAT_STATE_DIR: dir, CAMPLAT_DETECT_PYTHON: "no-such-python" }, encoding: "utf8", timeout: 60_000 });

await check("BAD FLAGS EXIT 2 before anything is read or run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "camplat-gatecheck-cli-"));
  try {
    const Z = (h) => `2026-09-21T0${h}:00:00Z`;
    for (const flags of [
      ["--hours", "0"], ["--hours", "25"], ["--hours", "abc"], ["--hours"],
      ["--threads", "0"], ["--threads", "9"], ["--threads", "1.5"],
      ["--fps", "0"], ["--fps", "31"],
      ["--from", Z(3)], ["--to", Z(4)],
      ["--from", Z(4), "--to", Z(3)],
      ["--from", "2026-09-21T03:00:00", "--to", "2026-09-21T04:00:00"],
      ["--from", "2026-09-20T03:00:00Z", "--to", Z(4)],
      ["--from", Z(3), "--to", Z(4), "--hours", "1"],
      ["--hour", "3"], ["--camera", "--hours", "1"], ["--hours", "1", "--hours", "2"], ["stray"],
      ["--pass", PASS], [`--pass=${PASS}`],
    ]) {
      const p = camctl(dir, flags);
      eq(p.status, 2, `${flags.join(" ")}: exit 2 (stderr: ${(p.stderr ?? "").trim().split("\n")[0]})`);
      eq(p.stdout, "", `${flags.join(" ")}: nothing on stdout`);
      eq(p.stderr.includes("usage: camctl gate-check"), true, `${flags.join(" ")}: the usage is shown`);
      noSecrets(p.stderr, `${flags.join(" ")}: stderr`);
    }
    eq(readdirSync(dir), [], "nothing was written to the state directory");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("THE COMMAND REFUSES WITH EXIT 1, and a broken config.json does not leak its password", async () => {
  const dir = mkdtempSync(join(tmpdir(), "camplat-gatecheck-cli-"));
  try {
    const p = camctl(dir, ["--hours", "2", "--threads", "4"]);
    eq(p.status, 1, `valid flags, no config: exit 1 (${p.stdout.trim()})`);
    eq(/^Refused: no config at /.test(p.stdout), true, "and says why");
    eq(readdirSync(dir), [], "nothing was written");
    // Broken exactly at the password: the JSON parser quotes the text around it.
    writeFileSync(join(dir, "config.json"), `{"credentials":{"username":"${USER}","password":${PASS}},"cameras":[]}`);
    const leak = camctl(dir, []);
    eq(leak.status, 1, "exit 1");
    eq(/^Refused: .*config\.json is not valid JSON( at line \d+, column \d+)?\s*$/.test(leak.stdout), true, `says what is wrong, and no more: ${leak.stdout.trim()}`);
    noSecrets(leak.stdout + leak.stderr, "the refusal");
    // Found in review: the line and column were cut too, leaving no way to
    // find the typo. Broken just after the password, on its own line.
    writeFileSync(join(dir, "config.json"), `{\n  "credentials": {\n    "username": "${USER}",\n    "password": "${PASS}"\n    "x": 1\n  },\n  "cameras": []\n}`);
    const placed = camctl(dir, []);
    eq(placed.status, 1, "exit 1");
    eq(/config\.json is not valid JSON at line 5, column 5\s*$/.test(placed.stdout), true, `says where, and no more: ${placed.stdout.trim()}`);
    noSecrets(placed.stdout + placed.stderr, "the placed refusal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

report("gateCheckRun");
