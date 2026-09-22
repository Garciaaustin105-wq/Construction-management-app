/**
 * The scoring runner: plays every clip saved with "Teach the AI" back through
 * the same detector the live service runs, and scores it against the answer
 * the person gave (contracts/clipLibrary.ts). Run on the NVR as
 * `camctl score`.
 *
 * It reproduces live, so the score describes live:
 *   - detector/replay.py, which imports the live worker's own decoding and
 *     post-processing, so the boxes are the boxes live would get;
 *   - the frame rate the live service GRANTED that camera (detect-health.json),
 *     not replay.py's default: more frames make a walk-by easier to catch;
 *   - the live floor, detect.json minConfidence, before folding
 *     (contracts/scoreRun.ts);
 *   - whole linked segments, never trimmed to the clip, so a person crossing
 *     a clip edge folds as live would fold them.
 * What it cannot reproduce it says: the saved footage is whatever the
 * recorder recorded, usually the main stream, and live reads the substream.
 *
 * It runs one replay at a time under `nice`, so scoring a library takes a
 * while and does not take the CPU away from the live detector.
 */

import { spawn } from "node:child_process";
import { readFile, readdir, mkdir, writeFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkLibrary, scoreLibrary, exitGate } from "../dist/clipLibrary.js";
import { foldDetections } from "../dist/detection.js";
import { checkMotionGate, clipFiles, detectionsFromReplay, scoreReport } from "../dist/scoreRun.js";
import { CLIP_DIR, LIBRARY_FILE } from "./clip-library.mjs";

/** Where each run's result is kept, so the next change can be compared with it. */
export const SCORES_DIR = "scores";
/** detect-service.mjs's own defaults, so an unset detect.json means the same thing here. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_MODEL = "/opt/camplat-models/yolox_s.onnx";

/**
 * Which stream a camera's recordings come from, as the recorder builds its
 * URL (recorder-service.mjs): a typed-in URL is used as given, so its stream
 * is unknown; otherwise `stream`, defaulting to "main".
 */
export function recordedStream(camera) {
  if (!camera) return "unknown";
  if (typeof camera.url === "string" && camera.url !== "") return "unknown";
  return camera.stream === "sub" ? "sub" : "main";
}

/** One 60-second segment replays in about a minute beside the live detector
 *  (measured on the laptop NVR: 2 segments in 125 s). Fifteen times that is a
 *  replay that is stuck, not slow; without a limit one wedged child would
 *  hang the whole run with no report at all. */
export const REPLAY_TIMEOUT_MS = 15 * 60_000;

/** Run replay.py over one whole file. Never rejects: a failure is a result. */
function replayFile({ spawnFn, python, replayPath, file, model, fps, nice, timeoutMs = REPLAY_TIMEOUT_MS, gateArgs = [] }) {
  // gateArgs: the same extra flags detect-service.mjs would give the live
  // worker (protocol item 2), appended after everything replay.py already
  // takes today — empty when the gate is off, so an ungated run's argv is
  // byte-for-byte what it always was.
  const args = [replayPath, "--file", file, "--model", model, "--fps", String(fps), "--threads", "1", ...gateArgs];
  const [cmd, argv] = nice ? ["nice", ["-n", "19", python, ...args]] : [python, args];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ lines: [], code: null, error: `could not start the detector: ${err.message}` });
      return;
    }
    let out = "";
    let errTail = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      settle({ lines: out.split("\n"), code: null, error: `the detector did not finish within ${Math.round(timeoutMs / 60_000)} min and was stopped` });
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { errTail = (errTail + b).slice(-400); });
    child.on("error", (err) => settle({ lines: out.split("\n"), code: null, error: `the detector failed to run: ${err.message}` }));
    child.on("close", (code) => settle({
      lines: out.split("\n"),
      code,
      error: code === 0 ? null : `the detector exited with ${code}${errTail.trim() ? `: ${errTail.trim().split("\n").pop()}` : ""}`,
    }));
  });
}

async function readJson(file, readFileFn) {
  try {
    return { value: JSON.parse(await readFileFn(file, "utf8")) };
  } catch (err) {
    return err.code === "ENOENT" ? { missing: true } : { problem: err.message };
  }
}

/**
 * Score the answer key. Returns { refused } when the key itself cannot be
 * trusted, else { lines, score, gate, meta, savedTo, saveError, events }.
 */
export async function runScore({
  stateDir,
  config,
  python,
  replayPath,
  fpsByHand = null,
  now = () => new Date(),
  spawnFn = spawn,
  readdirFn = readdir,
  readFileFn = readFile,
  writeResult = true,
  nice = true,
  timeoutMs = REPLAY_TIMEOUT_MS,
  progress = () => {},
  gateStateDir = os.tmpdir(),
  rmFn = rm,
}) {
  const lib = await readJson(path.join(stateDir, LIBRARY_FILE), readFileFn);
  let library;
  if (lib.missing) {
    library = { version: 1, clips: [] };
  } else if (lib.problem) {
    return { refused: `the answer key cannot be read (${lib.problem}), so nothing was scored` };
  } else {
    // A key that could be wrong makes a bad detector look good. Refuse it
    // whole rather than score the parts that happen to parse.
    const checked = checkLibrary(lib.value);
    if (!checked.ok) return { refused: `the answer key has problems, so nothing was scored: ${checked.errors.join("; ")}` };
    library = checked.library;
  }

  const detect = (await readJson(path.join(stateDir, "detect.json"), readFileFn)).value ?? {};
  const health = (await readJson(path.join(stateDir, "detect-health.json"), readFileFn)).value ?? {};
  const minConfidence = detect.minConfidence === undefined ? DEFAULT_MIN_CONFIDENCE : detect.minConfidence;
  if (typeof minConfidence !== "number" || !(minConfidence >= 0 && minConfidence <= 1)) {
    return { refused: `detect.json minConfidence is ${JSON.stringify(detect.minConfidence)}, not a number from 0 to 1, so the live floor is unknown` };
  }
  const model = typeof detect.model === "string" && detect.model !== "" ? detect.model : DEFAULT_MODEL;

  // Read detect.json's motionGate exactly as detect-service.mjs will before it
  // starts a worker (protocol item 1): a malformed one refuses here too, since
  // the live service would not have started either and there is no live
  // behaviour left to match.
  const gateCheck = checkMotionGate(detect.motionGate);
  if (!gateCheck.ok) return { refused: gateCheck.reason };
  const motionGate = gateCheck.gate;
  // The same extra args live would give the worker (protocol item 2), using
  // the live floor as --track-floor: off, this is [], so an ungated replay's
  // argv never changes.
  const gateArgs = motionGate.enabled
    ? [
        "--gate", "--track-floor", String(minConfidence),
        ...(motionGate.threshold !== null ? ["--gate-threshold", String(motionGate.threshold)] : []),
        ...(motionGate.keepaliveMs !== null ? ["--gate-keepalive-ms", String(motionGate.keepaliveMs)] : []),
      ]
    : [];

  const granted = new Map(
    (Array.isArray(health.cameras) ? health.cameras : [])
      // A granted rate is only the live rate if a worker is running on it:
      // detect-service gives every planned camera a grantedFps BEFORE it
      // tries to start that camera's worker, and a camera with no usable
      // substream keeps the rate in detect-health.json while live never
      // looks at it.
      .filter((c) => c && typeof c.cameraId === "string" && c.state === "watching" &&
        typeof c.grantedFps === "number" && c.grantedFps > 0)
      .map((c) => [c.cameraId, c.grantedFps]),
  );
  const camerasById = new Map((config.cameras ?? []).map((c) => [c.cameraId, c]));

  const meta = {
    clips: library.clips.length,
    clipsScored: 0,
    clipsRefused: [],
    fps: [],
    minConfidence,
    model: path.basename(model),
    streams: [],
    frames: 0,
    belowFloor: 0,
    unreadable: 0,
    replayErrors: [],
    gate: motionGate.enabled ? { enabled: true, threshold: motionGate.threshold, keepaliveMs: motionGate.keepaliveMs } : { enabled: false },
    gateFrames: 0,
    gateLooked: 0,
  };
  const scored = [];
  const events = [];

  for (const [i, clip] of library.clips.entries()) {
    const fps = fpsByHand ?? granted.get(clip.cameraId) ?? null;
    if (fps === null) {
      meta.clipsRefused.push({
        clipId: clip.id,
        reason: `the live detector is not watching ${clip.cameraId}, so there is no live frame rate to match (camctl score --fps N scores it anyway, labelled)`,
      });
      continue;
    }
    // Each linked segment sits on the drive it was recorded to, so a clip can
    // span drives. A name is a segment's start time: seen twice, it is the
    // same segment, and it is replayed once.
    const dirOf = new Map();
    for (const root of config.storeRoots ?? []) {
      const dir = path.join(root, CLIP_DIR, clip.id);
      try {
        for (const name of await readdirFn(dir)) if (!dirOf.has(name)) dirOf.set(name, dir);
      } catch {
        /* this drive holds none of it */
      }
    }
    const { files } = clipFiles([...dirOf.keys()]);
    if (files.length === 0) {
      meta.clipsRefused.push({ clipId: clip.id, reason: "its footage is missing" });
      continue;
    }
    progress(`clip ${i + 1}/${library.clips.length}: ${clip.id}, ${files.length} file${files.length === 1 ? "" : "s"} at ${fps} fps`);

    const detections = [];
    const failed = [];
    // Gated, the clip's files are replayed as ONE gate, as live runs one
    // gate across segment boundaries: each replay picks up the state the last
    // one left (--gate-state) on the clip's own clock (--gate-clock-offset-ms).
    // Found in review: a fresh gate per file had a free first look and a reset
    // keepalive at every boundary, which live never has.
    const gateState = motionGate.enabled ? path.join(gateStateDir, `camplat-gate-${process.pid}-${i}.json`) : null;
    if (gateState) await rmFn(gateState, { force: true }).catch(() => {});
    for (const f of files) {
      const fileGateArgs = gateState
        ? [...gateArgs, "--gate-state", gateState, "--gate-clock-offset-ms", String(f.startMs - files[0].startMs)]
        : gateArgs;
      const run = await replayFile({ spawnFn, python, replayPath, file: path.join(dirOf.get(f.name), f.name), model, fps, nice, timeoutMs, gateArgs: fileGateArgs });
      const read = detectionsFromReplay({ cameraId: clip.cameraId, fileStartMs: f.startMs, lines: run.lines, minConfidence });
      detections.push(...read.detections);
      meta.frames += read.frames;
      meta.belowFloor += read.belowFloor;
      meta.unreadable += read.unreadable;
      if (read.gate) {
        meta.gateFrames += read.gate.frames;
        meta.gateLooked += read.gate.looked;
      }
      for (const e of read.errors) failed.push(`${f.name}: ${e}`);
      if (run.error) failed.push(`${f.name}: ${run.error}`);
    }
    if (gateState) await rmFn(gateState, { force: true }).catch(() => {});
    // A replay that did not run found nobody because it looked at nothing.
    // Scored, its people would count as missed and blame the detector for a
    // broken python, model or disk; so the clip is refused whole, like a
    // clip whose footage is gone, and the reason is kept.
    if (failed.length > 0) {
      for (const e of failed) meta.replayErrors.push(`${clip.id}/${e}`);
      meta.clipsRefused.push({ clipId: clip.id, reason: `the detector could not replay it (${failed[0]})` });
      continue;
    }
    // Folded per clip, across all its files: a walk-by that crosses a
    // segment boundary is one event live, and must be one here.
    events.push(...foldDetections(detections));
    scored.push(clip);
    meta.clipsScored++;
    if (!meta.fps.some((x) => x.cameraId === clip.cameraId)) {
      meta.fps.push({ cameraId: clip.cameraId, fps, source: fpsByHand === null ? "live" : "by_hand" });
    }
    if (!meta.streams.some((x) => x.cameraId === clip.cameraId)) {
      meta.streams.push({ cameraId: clip.cameraId, recorded: recordedStream(camerasById.get(clip.cameraId)) });
    }
  }

  // Refused clips are left out of the score entirely and named in the
  // report: counting their people as missed would blame the detector for
  // footage it never saw.
  const score = scoreLibrary({ version: 1, clips: scored }, events);
  const gate = exitGate(score);
  const lines = scoreReport(score, gate, meta);

  // The run can take an hour; a full disk at the end must cost the saved
  // copy, never the report itself.
  let savedTo = null;
  let saveError = null;
  if (writeResult && meta.clips > 0) {
    const at = now().toISOString();
    const dir = path.join(stateDir, SCORES_DIR);
    const file = path.join(dir, `${at.replace(/[:.]/g, "-")}.json`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ atUtc: at, meta, score, gate, lines }, null, 2) + "\n");
      await rename(`${file}.tmp`, file);
      savedTo = file;
    } catch (err) {
      saveError = err.message;
    }
  }
  // events: what the replay folded to, so a run can be set beside what the
  // live service stored for the same minutes.
  return { lines, score, gate, meta, savedTo, saveError, events };
}
