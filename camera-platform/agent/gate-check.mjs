/**
 * The gate check: what the motion gate costs. Run on the NVR as
 * `camctl gate-check`.
 *
 * It replays recorded footage of the stream the live detector reads in
 * shadow mode (detector/replay.py --gate --gate-shadow): the model runs on
 * EVERY frame, and the gate runs beside it as live runs it, marking the
 * frames it would have looked at. contracts/gateCheck.ts folds both sets and
 * compares them sighting by sighting, and sets both beside the events the
 * live service stored for the same hours. Nobody has to label anything.
 *
 * It reproduces live, as the scoring runner does (agent/score-clips.mjs):
 *   - the footage is the recording of the very stream the detector reads (the
 *     substream, recorded as its own camera), found by comparing where the two
 *     connect; main-stream footage is never passed off as it, and footage
 *     chosen by hand is labelled on every line;
 *   - the frame rate live granted, the live floor, the live model, and the
 *     gate as detect.json sets it, or, with the gate off live, its own
 *     defaults, labelled as a preview;
 *   - one gate carried across every file, on the files' own clock.
 * It measures and changes nothing: no setting is written, and nothing here
 * says whether the gate should stay.
 *
 * NO URL, USER NAME OR PASSWORD LEAVES THIS FILE. Camera URLs are built only
 * to compare host, port and path, and are dropped at once. Every message that
 * came from outside (the detector's errors, a database's) is scrubbed before
 * it is kept, and the finished result is scrubbed again. The owner once found
 * a camera password in a log; it must never happen again.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MERGE_GAP_MS } from "../dist/detection.js";
import { buildRtspUrl } from "../dist/rtsp.js";
import { parseRtspUrl } from "../dist/cameraSource.js";
import { checkMotionGate } from "../dist/scoreRun.js";
import { readShadowReplay, sumShadowReads, compareShadow, sumGateTotals, gateCheckReport } from "../dist/gateCheck.js";
import { assignCamerasToDrives, indexPathFor } from "./config.mjs";
import { openIndex } from "./segindex.mjs";
import { openEventsDb } from "./events-db.mjs";
import { resolveCameraUrl } from "./recorder-service.mjs";
import { replayFile, REPLAY_TIMEOUT_MS, DEFAULT_MIN_CONFIDENCE, DEFAULT_MODEL } from "./score-clips.mjs";

/** Where each check's result is kept, beside the scores. */
export const GATE_CHECKS_DIR = "gate-checks";
/**
 * detector/motion_gate.py's DEFAULT_THRESHOLD and DEFAULT_KEEPALIVE_MS. With
 * the gate off live, no threshold or keepalive is passed, so replay.py runs
 * its own defaults; these are only what the report names them as. The harness
 * reads motion_gate.py and fails if the two drift apart.
 */
export const GATE_DEFAULTS = Object.freeze({ threshold: 0.005, keepaliveMs: 5000 });
/** Shadow mode runs the model on every frame, not the few the gate picks. */
export const DEFAULT_THREADS = 2;
export const MAX_THREADS = 8;
/** A day of footage is a day of replay beside the live detector; more is two runs. */
export const MAX_HOURS = 24;
/** Rows asked of events.db. Hitting it is reported, never read as "that is all". */
export const LIVE_EVENTS_LIMIT = 20_000;

const HOUR_MS = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

async function readJson(file, readFileFn) {
  try {
    return { value: JSON.parse(await readFileFn(file, "utf8")) };
  } catch (err) {
    return err.code === "ENOENT" ? { missing: true } : { problem: err.message };
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- secrets

/**
 * Every user name and password the config holds: the site login, and any
 * carried inside a camera's own URL (a camera can have a login of its own,
 * which the site-login scrub would miss). Longest first, so a secret that
 * contains another is blanked whole.
 */
function secretsOf(config) {
  const users = new Set();
  const passwords = new Set();
  const add = (set, v) => {
    // Under 3 characters a blanking would eat ordinary text; detect-service's
    // scrubber draws the same line.
    if (typeof v !== "string" || v.length < 3) return;
    set.add(v);
    set.add(encodeURIComponent(v));
  };
  for (const login of [config?.credentials, config?.camerasLogin]) {
    add(users, login?.username);
    add(passwords, login?.password);
  }
  for (const camera of config?.cameras ?? []) {
    for (const url of [camera?.url, camera?.substreamUrl]) {
      if (typeof url !== "string") continue;
      const parsed = parseRtspUrl(url);
      if (parsed.kind !== "ok") continue;
      add(users, parsed.username);
      add(passwords, parsed.password);
    }
  }
  const longestFirst = (set) => [...set].sort((a, b) => b.length - a.length);
  return { users: longestFirst(users), passwords: longestFirst(passwords) };
}

/**
 * A scrubber: every RTSP URL goes whole (redactRtspUrl would keep the user
 * name), then every secret given. Text from outside - the detector's errors
 * and stderr, a database's - is scrubbed of user names too. The finished
 * result is scrubbed of URLs and passwords only, so a user name that happens
 * to be part of a drive's path does not blank every footage path.
 */
function makeScrub(secrets) {
  return (text) => {
    let out = String(text).replace(/rtsps?:\/\/\S*/gi, "[a camera address]");
    for (const secret of secrets) out = out.split(secret).join("***");
    return out;
  };
}

function scrubDeep(value, scrub) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)]));
  }
  return value;
}

// ---------------------------------------------------------------- which footage

/** Where a URL connects, and nothing of who connects: host, port and path. */
function endpoint(url) {
  const parsed = parseRtspUrl(url);
  return parsed.kind === "ok" ? `${parsed.host.toLowerCase()}|${parsed.port}|${parsed.path}` : null;
}

/**
 * Where the live detector connects for a camera, built exactly as
 * detect-service.mjs builds its substream URL: substreamUrl through
 * resolveCameraUrl, else the vendor template with stream "sub". Null when
 * nothing can be built. The URL itself never leaves this function.
 */
function detectorEndpoint(camera, credentials) {
  try {
    if (typeof camera.substreamUrl === "string" && camera.substreamUrl !== "") {
      const resolved = resolveCameraUrl({ url: camera.substreamUrl }, credentials);
      return resolved.kind === "ok" ? endpoint(resolved.url) : null;
    }
    if (typeof camera.host === "string" && camera.host !== "") {
      const built = buildRtspUrl({ vendor: camera.vendor ?? "generic", ip: camera.host, channel: camera.channel ?? 1, stream: "sub" }, credentials);
      return built.kind === "ok" ? endpoint(built.url) : null;
    }
  } catch {
    // A template that throws (no login, a channel out of range) builds
    // nothing; its message is not kept, in case it quotes what it was given.
  }
  return null;
}

/** Where a camera's recordings come from, built as recorder-service.mjs builds it. */
function recordingEndpoint(camera, credentials) {
  try {
    const resolved = resolveCameraUrl(camera, credentials);
    return resolved.kind === "ok" ? endpoint(resolved.url) : null;
  } catch {
    return null;
  }
}

/**
 * The configured camera whose recording IS the stream the detector reads:
 * same host, port and path, whatever login each uses. The detect camera
 * itself first (a camera set to record its own substream), then the config's
 * order.
 */
function footageFor(config, detectCamera) {
  const wanted = detectorEndpoint(detectCamera, config.credentials);
  if (wanted === null) return { unbuildable: true };
  const cameras = [detectCamera, ...config.cameras.filter((c) => c !== detectCamera)];
  return { camera: cameras.find((c) => recordingEndpoint(c, config.credentials) === wanted) ?? null };
}

/**
 * The drive a segment is on: the one its row names, when that is still a
 * configured drive, else the drive its camera is assigned to. The same rule
 * as rootOf in api-server.mjs, harvest.mjs and event-crop.mjs.
 */
function fileOf(segment, config, drives) {
  const root = typeof segment.root === "string" && config.storeRoots.includes(segment.root)
    ? segment.root
    : config.storeRoots[drives.get(segment.cameraId) ?? 0];
  return path.join(root, segment.path);
}

function skipReason(segment) {
  if (segment.state === "open") return "still being recorded";
  if (segment.state === "partial") return "a partial segment, cut off mid-write, not sealed";
  if (segment.state === "sealed") return "sealed, but its end time is not recorded";
  return `in state ${JSON.stringify(segment.state)}, not sealed`;
}

/**
 * The result file's name. A camera id is the person's own text: anything that
 * could climb out of the directory or trouble a file system becomes "_".
 */
export function gateCheckFileName(atUtc, cameraId) {
  const id = String(cameraId);
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  // Found in review: "cam:1" and "cam/1" both became "cam_1", and a run over
  // both saved one camera's result over the other's while saying it saved
  // both. An id that had to change carries a short hash of the real one.
  const tag = safe === id ? "" : `-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
  return `${atUtc.replace(/:/g, "-")}-${safe}${tag}.json`;
}

// ---------------------------------------------------------------- the run

/**
 * Check what the gate costs, per camera. Returns { refused } when nothing can
 * be checked at all (detect.json cannot be trusted, no camera to check), else
 * { results: [{ cameraId, refused, result, lines, savedTo, saveError }] }, one
 * per camera, a camera that could not be checked carrying only its reason.
 */
export async function runGateCheck({
  stateDir,
  config,
  python,
  replayPath,
  cameraId = null,
  fromUtc = null,
  toUtc = null,
  hours = 1,
  fpsByHand = null,
  threads = DEFAULT_THREADS,
  footageCameraId = null,
  now = () => new Date(),
  spawnFn = spawn,
  openIndexFn = openIndex,
  openEventsFn = openEventsDb,
  readFileFn = readFile,
  writeResult = true,
  nice = true,
  timeoutMs = REPLAY_TIMEOUT_MS,
  progress = () => {},
  gateStateDir = os.tmpdir(),
  rmFn = rm,
}) {
  const secrets = secretsOf(config);
  const scrubOutside = makeScrub([...secrets.users, ...secrets.passwords].sort((a, b) => b.length - a.length));
  const scrubResult = makeScrub(secrets.passwords);

  // The same limits camctl checks, so a caller that skipped them is refused
  // rather than run for days.
  if (!Number.isInteger(threads) || threads < 1 || threads > MAX_THREADS) {
    return { refused: `threads must be a whole number from 1 to ${MAX_THREADS}` };
  }
  if (fpsByHand !== null && !(typeof fpsByHand === "number" && fpsByHand > 0 && fpsByHand <= 30)) {
    return { refused: "a frame rate given by hand must be a number above 0 and at most 30" };
  }
  let window = null;
  if (fromUtc !== null || toUtc !== null) {
    const fromMs = Date.parse(fromUtc);
    const toMs = Date.parse(toUtc);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { refused: "the window needs both a start and an end time" };
    if (!(fromMs < toMs)) return { refused: "the window's start must be before its end" };
    if (toMs - fromMs > MAX_HOURS * HOUR_MS) return { refused: `the window is longer than ${MAX_HOURS} h` };
    window = { fromMs, toMs };
  } else if (!(typeof hours === "number" && hours > 0 && hours <= MAX_HOURS)) {
    return { refused: `hours must be a number above 0 and at most ${MAX_HOURS}` };
  }

  // detect.json is what live runs. Missing, live detection is not configured
  // and there is no floor or gate to match; unreadable, any setting read from
  // it would be a guess. Both refuse, where the scorer falls back to the
  // defaults: here the live gate is the whole question.
  const detectRead = await readJson(path.join(stateDir, "detect.json"), readFileFn);
  if (detectRead.missing) return { refused: "there is no detect.json: live detection is not configured here, so there is no live floor or gate to match" };
  if (detectRead.problem) return { refused: `detect.json cannot be read (${scrubOutside(detectRead.problem)}), so the live settings are unknown` };
  const detect = detectRead.value ?? {};
  const minConfidence = detect.minConfidence === undefined ? DEFAULT_MIN_CONFIDENCE : detect.minConfidence;
  if (typeof minConfidence !== "number" || !(minConfidence >= 0 && minConfidence <= 1)) {
    return { refused: `detect.json minConfidence is ${JSON.stringify(detect.minConfidence)}, not a number from 0 to 1, so the live floor is unknown` };
  }
  const model = typeof detect.model === "string" && detect.model !== "" ? detect.model : DEFAULT_MODEL;
  // Read exactly as detect-service.mjs reads it: a malformed one would not
  // have started live either, so there is no live gate to measure.
  const gateRead = checkMotionGate(detect.motionGate);
  if (!gateRead.ok) return { refused: gateRead.reason };
  const motionGate = gateRead.gate;
  // Shadow mode always runs the gate. On live, it runs as detect.json sets it:
  // a threshold or keepalive only when detect.json gives one, as live passes
  // them. Off live, it runs replay.py's defaults, which the report names.
  const gateArgs = [
    "--gate", "--gate-shadow", "--track-floor", String(minConfidence),
    ...(motionGate.threshold !== null ? ["--gate-threshold", String(motionGate.threshold)] : []),
    ...(motionGate.keepaliveMs !== null ? ["--gate-keepalive-ms", String(motionGate.keepaliveMs)] : []),
  ];
  const gateSettings = motionGate.enabled
    ? { threshold: motionGate.threshold, keepaliveMs: motionGate.keepaliveMs, liveEnabled: true }
    : { threshold: GATE_DEFAULTS.threshold, keepaliveMs: GATE_DEFAULTS.keepaliveMs, liveEnabled: false };

  const healthRead = await readJson(path.join(stateDir, "detect-health.json"), readFileFn);
  const health = healthRead.value ?? {};
  const watching = (Array.isArray(health.cameras) ? health.cameras : [])
    // As runScore: a granted rate is the live rate only while a worker runs
    // on it; detect-service grants a rate before it tries to start a worker.
    .filter((c) => c && typeof c.cameraId === "string" && c.state === "watching" &&
      typeof c.grantedFps === "number" && c.grantedFps > 0);
  const granted = new Map(watching.map((c) => [c.cameraId, c.grantedFps]));
  const cameraIds = cameraId !== null ? [cameraId] : [...new Set(watching.map((c) => c.cameraId))];
  if (cameraIds.length === 0) {
    return {
      refused: healthRead.problem
        ? `detect-health.json cannot be read (${scrubOutside(healthRead.problem)}), so which cameras live watches is unknown; name one with --camera`
        : "the live detector is not watching any camera (detect-health.json), so there is none to check; name one with --camera",
    };
  }
  if (footageCameraId !== null && cameraIds.length > 1) {
    return { refused: "a footage camera chosen by hand needs the one camera it stands in for: add --camera" };
  }
  const storeRoots = Array.isArray(config?.storeRoots) ? config.storeRoots : [];
  if (storeRoots.length === 0) return { refused: "the config lists no recording drives, so there is no footage to replay" };
  const configCameras = Array.isArray(config?.cameras) ? config.cameras : [];
  const drives = assignCamerasToDrives(configCameras.map((c) => c.cameraId), storeRoots.length);
  const cfg = { ...config, cameras: configCameras, storeRoots };

  // One stamp for the whole run: every camera's saved result carries it.
  const atUtc = now().toISOString();
  const results = [];
  for (const [i, id] of cameraIds.entries()) {
    const refuse = (reason) => ({ cameraId: id, refused: scrubResult(reason), result: null, lines: [], savedTo: null, saveError: null });

    const fps = fpsByHand ?? granted.get(id) ?? null;
    if (fps === null) {
      results.push(refuse(healthRead.problem
        ? `detect-health.json cannot be read, so there is no live frame rate to match for ${id} (camctl gate-check --fps N checks it anyway, labelled)`
        : `the live detector is not watching ${id}, so there is no live frame rate to match (camctl gate-check --fps N checks it anyway, labelled)`));
      continue;
    }

    // The footage: the recording of the stream this camera's detector reads.
    const detectCamera = cfg.cameras.find((c) => c.cameraId === id) ?? null;
    let footageCamera;
    let footageIsLiveStream;
    if (footageCameraId !== null) {
      footageCamera = cfg.cameras.find((c) => c.cameraId === footageCameraId) ?? null;
      if (footageCamera === null) {
        results.push(refuse(`${footageCameraId} is not in the camera config, so what it recorded cannot be told`));
        continue;
      }
      // Chosen by hand, it is the live stream only if it really is: the
      // label says what was replayed, not what was asked for.
      const wanted = detectCamera === null ? null : detectorEndpoint(detectCamera, cfg.credentials);
      footageIsLiveStream = wanted !== null && recordingEndpoint(footageCamera, cfg.credentials) === wanted;
    } else {
      if (detectCamera === null) {
        results.push(refuse(`${id} is not in the camera config, so the stream the live detector reads for it cannot be told ` +
          "(--footage-camera ID replays a recording chosen by hand, labelled)"));
        continue;
      }
      const found = footageFor(cfg, detectCamera);
      if (found.unbuildable) {
        results.push(refuse(`the stream the live detector reads for ${id} cannot be built from the camera config`));
        continue;
      }
      if (found.camera === null) {
        results.push(refuse(`no recording of the stream the live detector reads for ${id}: no configured camera records it ` +
          "(record the substream as a camera of its own, or name a recording with --footage-camera ID, labelled as not the live stream)"));
        continue;
      }
      footageCamera = found.camera;
      footageIsLiveStream = true;
    }
    const footageId = footageCamera.cameraId;

    // The segments. The index is checked for first, as `camctl audit` does:
    // opening a missing one would create it, hiding a wrong state directory.
    const indexFile = indexPathFor(stateDir);
    if (!(await exists(indexFile))) {
      results.push(refuse(`there is no index at ${indexFile}: nothing has recorded here, or the state directory is wrong`));
      continue;
    }
    let rows;
    let requestedFromMs;
    let requestedToMs;
    try {
      const index = openIndexFn(indexFile);
      try {
        if (window !== null) {
          requestedFromMs = window.fromMs;
          requestedToMs = window.toMs;
        } else {
          // The hours ending where the footage ends, not at the clock: a
          // recorder that stopped an hour ago still has its last hours.
          const newest = index.forCamera(footageId).filter((s) => s.state === "sealed" && s.endUtc !== null).at(-1);
          if (newest === undefined) {
            results.push(refuse(`the index holds no sealed recording of ${footageId}`));
            continue;
          }
          requestedToMs = Date.parse(newest.endUtc);
          // Whole milliseconds: 0.05 h is not exact in floating point.
          requestedFromMs = requestedToMs - Math.round(hours * HOUR_MS);
        }
        rows = index.inRange(footageId, iso(requestedFromMs), iso(requestedToMs));
      } finally {
        index.close();
      }
    } catch (err) {
      results.push(refuse(`the recording index cannot be read (${scrubOutside(err?.message ?? err)})`));
      continue;
    }
    const sorted = [...rows].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    const files = [];
    const skipped = [];
    for (const s of sorted) {
      const file = fileOf(s, cfg, drives);
      if (s.state === "sealed" && s.endUtc !== null) files.push({ path: file, startMs: Date.parse(s.startUtc), endMs: Date.parse(s.endUtc) });
      else skipped.push({ path: file, reason: skipReason(s) });
    }
    if (files.length === 0) {
      results.push(refuse(`no sealed footage of ${footageId} from ${iso(requestedFromMs)} to ${iso(requestedToMs)}` +
        (skipped.length > 0 ? ` (${skipped.length} segment${skipped.length === 1 ? "" : "s"} there, none sealed: ${skipped[0].reason})` : "")));
      continue;
    }

    // Opened before the replay, so a database that cannot be read refuses
    // now rather than after an hour of CPU. As with the index, a missing one
    // is not created: live has stored nothing here to compare with.
    const eventsFile = path.join(stateDir, "events.db");
    if (!(await exists(eventsFile))) {
      results.push(refuse(`there is no events.db in ${stateDir}: the live service has stored nothing here to compare with`));
      continue;
    }
    let events;
    try {
      events = openEventsFn(eventsFile);
    } catch (err) {
      results.push(refuse(`events.db cannot be opened (${scrubOutside(err?.message ?? err)})`));
      continue;
    }

    let outcome;
    try {
      progress(`${id}: replaying ${files.length} file${files.length === 1 ? "" : "s"} of ${footageId} at ${fps} fps, ` +
        `${threads} thread${threads === 1 ? "" : "s"}, the model on every frame with the gate beside it`);
      // ONE gate across the camera's files, as live runs one gate across
      // segment boundaries: each replay picks up the state the last one left,
      // on the first file's clock. A fresh gate per file would get a free
      // first look and a reset keepalive at every boundary, which live never
      // has. One file per camera, so two cameras never share a gate.
      const gateState = path.join(gateStateDir, `camplat-gatecheck-${process.pid}-${i}.json`);
      const reads = [];
      const failed = [];
      await rmFn(gateState, { force: true }).catch(() => {});
      try {
        for (const [k, f] of files.entries()) {
          progress(`${id}: file ${k + 1}/${files.length}`);
          const run = await replayFile({
            spawnFn, python, replayPath, file: f.path, model, fps, nice, timeoutMs, threads,
            gateArgs: [...gateArgs, "--gate-state", gateState, "--gate-clock-offset-ms", String(f.startMs - files[0].startMs)],
          });
          // A replay that did not finish looked at nothing: its frames are not
          // counted, and it is named, never read as a quiet stretch.
          if (run.error) {
            failed.push({ path: f.path, error: scrubOutside(run.error) });
            continue;
          }
          const read = readShadowReplay({ cameraId: id, fileStartMs: f.startMs, lines: run.lines, minConfidence });
          reads.push({ path: f.path, file: f, read: { ...read, errors: read.errors.map(scrubOutside) } });
        }
      } finally {
        await rmFn(gateState, { force: true }).catch(() => {});
      }
      if (reads.length === 0) {
        outcome = refuse(`every replay failed (${failed.length} file${failed.length === 1 ? "" : "s"}); the first: ${failed[0].error}`);
      } else {
        const replayedFromMs = Math.min(...reads.map((r) => r.file.startMs));
        const replayedToMs = Math.max(...reads.map((r) => r.file.endMs));
        // Widened by the fold's own gap, as the comparison widens each event.
        const live = events.inRange(id, iso(replayedFromMs - MERGE_GAP_MS), iso(replayedToMs + MERGE_GAP_MS), ["person", "vehicle"], LIVE_EVENTS_LIMIT);
        const comparison = compareShadow({
          files: files.map((f) => ({ path: f.path, startMs: f.startMs, endMs: f.endMs })),
          reference: reads.flatMap((r) => r.read.reference),
          gated: reads.flatMap((r) => r.read.gated),
          live: live.events,
        });
        const totals = sumGateTotals(reads.map((r) => r.read.gate));
        const result = {
          atUtc,
          camera: { detectCameraId: id, footageCameraId: footageId, footageIsLiveStream },
          settings: {
            fps,
            fpsSource: fpsByHand === null ? "live" : "by_hand",
            minConfidence,
            model: path.basename(model),
            gate: gateSettings,
          },
          span: {
            requestedFromUtc: iso(requestedFromMs),
            requestedToUtc: iso(requestedToMs),
            replayedFromUtc: iso(replayedFromMs),
            replayedToUtc: iso(replayedToMs),
            // Every file handed to the replay, failed ones included, so the
            // report can say how much footage a failure cost.
            files,
            skipped,
            failed,
          },
          frames: { total: totals.frames, looked: totals.looked, share: totals.share, reasons: totals.reasons, missing: totals.missing },
          read: sumShadowReads(reads.map((r) => ({ path: r.path, read: r.read }))),
          live: { truncated: live.truncated === true },
          comparison,
        };
        // Scrubbed once more as a whole: nothing above should hold a secret,
        // and this is where a mistake above would be caught.
        const clean = scrubDeep(result, scrubResult);
        outcome = { cameraId: id, refused: null, result: clean, lines: gateCheckReport(clean).map(scrubResult), savedTo: null, saveError: null };
      }
    } catch (err) {
      outcome = refuse(`the check stopped: ${scrubOutside(err?.message ?? err)}`);
    } finally {
      try { events.close(); } catch { /* already closed */ }
    }

    // The run can take hours; a full disk at the end must cost the saved
    // copy, never the report itself.
    if (outcome.result && writeResult) {
      const dir = path.join(stateDir, GATE_CHECKS_DIR);
      const file = path.join(dir, gateCheckFileName(atUtc, id));
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ ...outcome.result, lines: outcome.lines }, null, 2) + "\n");
        await rename(`${file}.tmp`, file);
        outcome.savedTo = file;
      } catch (err) {
        outcome.saveError = scrubOutside(err?.message ?? err);
      }
    }
    results.push(outcome);
  }
  return { results };
}
