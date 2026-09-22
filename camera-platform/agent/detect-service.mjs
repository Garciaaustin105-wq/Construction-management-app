/**
 * The detection service: orchestrates workers, manages events, monitors health.
 *
 * Spawns one AI worker per camera, distributes detection results to events.db,
 * and tracks detector health. Never opens the recording index; never queues
 * frames (drops to stay live); never logs a password.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorkerLine, emptyFold, advanceFold, MAX_WORKER_LINE_BYTES } from "../dist/detectStream.js";
import { MERGE_GAP_MS } from "../dist/detection.js";
import { planDetectSchedule } from "../dist/detectSchedule.js";
import { buildRtspUrl, redactRtspUrl } from "../dist/rtsp.js";
import { loadConfig, resolveCameraUrl } from "./recorder-service.mjs";
import { openEventsDb } from "./events-db.mjs";
import { DEFAULT_PATHS } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultLog = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

/**
 * Redact passwords from a string. Replaces the password from config and
 * URL-encoded versions, as well as any password embedded in an RTSP URL.
 */
function scrubLine(text, password, urlPassword) {
  let scrubbed = redactRtspUrl(text);
  if (typeof password === "string" && password.length >= 3) {
    scrubbed = scrubbed.split(password).join("***");
    scrubbed = scrubbed.split(encodeURIComponent(password)).join("***");
  }
  if (typeof urlPassword === "string" && urlPassword.length >= 3) {
    scrubbed = scrubbed.split(urlPassword).join("***");
    scrubbed = scrubbed.split(encodeURIComponent(urlPassword)).join("***");
  }
  return scrubbed;
}

function extractUrlPassword(url) {
  try {
    const u = new URL(url);
    return u.password ? decodeURIComponent(u.password) : null;
  } catch {
    return null;
  }
}

export async function startDetect(opts = {}) {
  const {
    stateDir,
    spawnFn = spawn,
    now = () => new Date(),
    tickMs = 1000,
    healthMs = 10000,
    restartMs = { first: 2000, max: 30000 },
    killAfterMs = 5000,
    log = defaultLog,
    python = "python3",
    workerPath = path.join(__dirname, "../detector/yolox_worker.py"),
    modelPath,
  } = opts;

  // Read detect.json
  let detect;
  try {
    const raw = await readFile(path.join(stateDir, "detect.json"), "utf8");
    detect = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("detection is not configured: no detect.json");
    }
    throw new Error(`cannot read detect.json: ${err.message}`);
  }

  // Plan the schedule
  const plan = planDetectSchedule(detect.cameras ?? [], detect.capacityFps ?? null);
  if (!plan.ok) {
    const message = plan.code === "unmeasured_capacity"
      ? `detection capacity must be measured on this box: ${plan.message}`
      : plan.message;
    throw new Error(message);
  }

  // The storing floor. The worker stays permissive (its own floor is low, so
  // the clip library can measure what a floor would miss); only sightings at
  // or above this become events. Bench 2026-09-19: without it, a 0.35
  // "vehicle" and a whole-frame 0.67 "person" cluttered the timeline.
  // Absent means the default; null is something someone wrote, and is refused.
  const minConfidence = detect.minConfidence === undefined ? 0.5 : detect.minConfidence;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(`detect.json minConfidence must be a number from 0 to 1, got ${JSON.stringify(detect.minConfidence)}`);
  }

  // Motion gating: OPTIONAL. Absent means off, and the worker is launched
  // exactly as it is today - no new args, nothing for an older detect.json to
  // trip over. Present but malformed refuses to start and names the field,
  // the same discipline as minConfidence above: a gate silently ignored would
  // leave a camera thinking it is being watched every frame when it is not.
  const motionGateRaw = detect.motionGate;
  let motionGate = { enabled: false, threshold: null, keepaliveMs: null };
  if (motionGateRaw !== undefined) {
    if (typeof motionGateRaw !== "object" || motionGateRaw === null || Array.isArray(motionGateRaw)) {
      throw new Error(`detect.json motionGate must be an object, got ${JSON.stringify(motionGateRaw)}`);
    }
    for (const key of Object.keys(motionGateRaw)) {
      if (key !== "enabled" && key !== "threshold" && key !== "keepaliveMs") {
        throw new Error(`detect.json motionGate has an unknown field: ${key}`);
      }
    }
    if (typeof motionGateRaw.enabled !== "boolean") {
      throw new Error(`detect.json motionGate.enabled must be a boolean, got ${JSON.stringify(motionGateRaw.enabled)}`);
    }
    let threshold = null;
    if (motionGateRaw.threshold !== undefined) {
      threshold = motionGateRaw.threshold;
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
        throw new Error(`detect.json motionGate.threshold must be a number strictly between 0 and 1, got ${JSON.stringify(threshold)}`);
      }
    }
    let keepaliveMs = null;
    if (motionGateRaw.keepaliveMs !== undefined) {
      keepaliveMs = motionGateRaw.keepaliveMs;
      if (!Number.isInteger(keepaliveMs) || keepaliveMs < 1000 || keepaliveMs > 600000) {
        throw new Error(`detect.json motionGate.keepaliveMs must be an integer from 1000 to 600000, got ${JSON.stringify(keepaliveMs)}`);
      }
    }
    // enabled:false is still a validated config (a malformed threshold beside
    // it is not let through just because the gate is off) - it just leaves
    // the gate off, same as motionGate being absent entirely. Found in
    // review: off, its settings used to reach detect-health.json, which then
    // read as a gate running at that threshold. Off reports none.
    motionGate = motionGateRaw.enabled
      ? { enabled: true, threshold, keepaliveMs }
      : { enabled: false, threshold: null, keepaliveMs: null };
  }

  // Load camera config
  const config = await loadConfig(stateDir);

  // Open events database
  const eventsDb = openEventsDb(path.join(stateDir, "events.db"));

  // Determine model path
  const finalModelPath = modelPath ?? (detect.model ?? "/opt/camplat-models/yolox_s.onnx");

  // Per-camera state
  const cameras = new Map();
  const workers = new Map();
  const restartTimers = new Map();
  let stopping = false;

  // Initialize camera state
  for (const assignment of plan.assignments) {
    cameras.set(assignment.cameraId, {
      cameraId: assignment.cameraId,
      state: "unknown",
      grantedFps: assignment.grantedFps,
      lastFrameUtc: null,
      restarts: 0,
      invalidLines: 0,
      fold: emptyFold(),
      gate: motionGate.enabled ? { lastWindow: null, sinceStart: null } : null,
    });
  }

  function getCameraState(cameraId) {
    const cam = cameras.get(cameraId);
    if (!cam) {
      cameras.set(cameraId, {
        cameraId,
        state: "unknown_camera",
        grantedFps: null,
        lastFrameUtc: null,
        restarts: 0,
        invalidLines: 0,
        fold: emptyFold(),
        gate: motionGate.enabled ? { lastWindow: null, sinceStart: null } : null,
      });
      return cameras.get(cameraId);
    }
    return cam;
  }

  function spawnWorker(assignment) {
    const cameraId = assignment.cameraId;
    const cam = getCameraState(cameraId);
    const configCam = config.cameras.find((c) => c.cameraId === cameraId);

    if (!configCam) {
      cam.state = "unknown_camera";
      log("warn", "detection skipped: camera not found in config", { cameraId });
      return;
    }

    // Determine substream URL
    let substreamUrl = null;
    if (typeof configCam.substreamUrl === "string" && configCam.substreamUrl !== "") {
      // The site login is added when the address has none, as the recorder
      // does (resolveCameraUrl); without it the camera answers 401.
      const resolved = resolveCameraUrl({ url: configCam.substreamUrl }, config.credentials);
      if (resolved.kind === "ok") substreamUrl = resolved.url;
    } else if (typeof configCam.host === "string" && configCam.host !== "") {
      const vendor = configCam.vendor ?? "generic";
      const channel = configCam.channel ?? 1;
      const built = buildRtspUrl({ vendor, ip: configCam.host, channel, stream: "sub" }, config.credentials);
      if (built.kind === "ok") {
        substreamUrl = built.url;
      }
    }

    if (!substreamUrl) {
      cam.state = "no_substream";
      log("warn", "detection skipped: camera has no substream", { cameraId });
      return;
    }

    const grantedFps = assignment.grantedFps;
    // Protocol item 2, exact order: nothing new when the gate is off, so an
    // unchanged detect.json launches byte-for-byte what it always has.
    const gateArgs = motionGate.enabled
      ? [
          "--gate", "--track-floor", String(minConfidence),
          ...(motionGate.threshold !== null ? ["--gate-threshold", String(motionGate.threshold)] : []),
          ...(motionGate.keepaliveMs !== null ? ["--gate-keepalive-ms", String(motionGate.keepaliveMs)] : []),
        ]
      : [];
    const child = spawnFn(python, [
      workerPath,
      "--camera", cameraId,
      "--url", substreamUrl,
      "--fps", String(grantedFps),
      "--model", finalModelPath,
      ...gateArgs,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    workers.set(cameraId, { child, substreamUrl, urlPassword: extractUrlPassword(substreamUrl) });
    // The scrubber reads the camera's own password from here: a camera whose
    // URL carries a password other than the site's must have it blanked too.
    cam.urlPassword = extractUrlPassword(substreamUrl);
    cam.state = "watching";
    cam.lastFrameUtc = null;
    cam.invalidLines = 0;
    cam.fold = emptyFold();
    // Reset with the worker: a respawned worker starts its own duty cycle
    // over, and yesterday's totals must not bleed into it.
    cam.gate = motionGate.enabled ? { lastWindow: null, sinceStart: null } : null;

    // Handle stdout
    let pendingLine = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      pendingLine += text;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() || "";

      for (const line of lines) {
        if (line.length > MAX_WORKER_LINE_BYTES) {
          cam.invalidLines += 1;
          continue;
        }

        const parsed = parseWorkerLine(line, cameraId);
        if (parsed.kind === "invalid") {
          cam.invalidLines += 1;
        } else if (parsed.kind === "ready") {
          log("info", "detect worker ready", { cameraId, model: parsed.model });
        } else if (parsed.kind === "error") {
          const scrubbed = scrubLine(parsed.message, config.credentials?.password, cam.urlPassword);
          log("warn", "detect worker error", { cameraId, message: scrubbed });
        } else if (parsed.kind === "frame") {
          cam.lastFrameUtc = parsed.atUtc;
          const kept = parsed.detections.filter((d) => d.confidence >= minConfidence);
          const step = advanceFold(cam.fold, kept, now().toISOString());
          cam.fold = step.state;
          // update.event / finished.event already carry species when
          // advanceFold set one (the best sighting's) - nothing here needs to
          // single it out, the same as plate: eventsDb.upsert stores whatever
          // the event holds.
          for (const update of step.updated) {
            eventsDb.upsert(update, false);
          }
          for (const finished of step.finished) {
            eventsDb.upsert(finished, true);
          }
        } else if (parsed.kind === "gate") {
          // Only kept when the gate is actually on for this camera: a worker
          // launched without --gate should never say "gate", and if one did
          // anyway the health file must still read "off" the way the config
          // says, not flip live because a line arrived.
          if (motionGate.enabled) {
            const share = parsed.frames > 0 ? parsed.looked / parsed.frames : null;
            const lastWindow = {
              atUtc: now().toISOString(),
              windowS: parsed.windowS,
              frames: parsed.frames,
              looked: parsed.looked,
              share,
              reasons: parsed.reasons,
            };
            const prevTotal = cam.gate?.sinceStart ?? null;
            const totalFrames = (prevTotal?.frames ?? 0) + parsed.frames;
            const totalLooked = (prevTotal?.looked ?? 0) + parsed.looked;
            cam.gate = {
              lastWindow,
              sinceStart: { frames: totalFrames, looked: totalLooked, share: totalFrames > 0 ? totalLooked / totalFrames : null },
            };
          }
        }
      }
    });

    // Handle stderr
    const stderrLines = [];
    child.stderr?.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line) {
          const scrubbed = scrubLine(line, config.credentials?.password, cam.urlPassword);
          stderrLines.push(scrubbed);
          if (stderrLines.length > 10) {
            stderrLines.shift();
          }
        }
      }
    });

    // Handle exit
    child.once("exit", (code) => {
      workers.delete(cameraId);
      if (stopping) return;

      log("warn", "detect worker exited", {
        cameraId,
        code,
        stderrTail: stderrLines.slice(-3).join("; "),
      });

      cam.restarts += 1;
      const currentRestarts = cam.restarts;
      const delay = Math.min(
        restartMs.first * Math.pow(2, Math.max(0, currentRestarts - 1)),
        restartMs.max,
      );

      const timer = setTimeout(() => {
        if (!stopping && cam.restarts === currentRestarts) {
          spawnWorker(assignment);
        }
      }, delay);
      // Not unref()'d: while the only worker is down, this timer may be the one
      // thing keeping the daemon alive (bench 2026-09-20: the service exited
      // with its worker, and systemd restarted it every 10 s). stop() clears it.
      restartTimers.set(cameraId, timer);
    });
  }

  // Spawn all workers
  for (const assignment of plan.assignments) {
    spawnWorker(assignment);
  }

  // Tick timer: advance folds with no detections
  const tickTimer = setInterval(() => {
    for (const cam of cameras.values()) {
      const step = advanceFold(cam.fold, [], now().toISOString());
      cam.fold = step.state;
      for (const finished of step.finished) {
        eventsDb.upsert(finished, true);
      }
    }
  }, tickMs);

  // Health timer
  const healthTimer = setInterval(() => {
    writeHealth();
  }, healthMs);

  function getCameras() {
    return Array.from(cameras.values()).map((cam) => ({
      cameraId: cam.cameraId,
      state: cam.state,
      grantedFps: cam.grantedFps,
      // Read only as "this camera is alive", never as "this camera is
      // stalled": with the gate on, a quiet camera can go a whole
      // keepalive (~10 s, motion_gate.py's DEFAULT_KEEPALIVE_MS) between
      // frame lines on purpose. Checked 2026-09-21: no consumer in agent/,
      // contracts/ or agent/ui/ reads detect-health.json's lastFrameUtc as a
      // staleness signal today (score-clips.mjs reads only state/grantedFps;
      // health.json's own staleAfterMs is the RECORDER's file, not this
      // one) - so nothing here currently misreads a gated, healthy camera as
      // stalled. If a staleness check on this field is ever added, it must
      // compare against cam.gate?.lastWindow?.atUtc too, not lastFrameUtc
      // alone.
      lastFrameUtc: cam.lastFrameUtc,
      restarts: cam.restarts,
      invalidLines: cam.invalidLines,
      gate: cam.gate,
    }));
  }

  async function writeHealth() {
    const health = {
      atUtc: now().toISOString(),
      capacityFps: plan.capacityFps,
      minConfidence,
      motionGate,
      cameras: getCameras(),
    };
    const tmpFile = path.join(stateDir, "detect-health.json.tmp");
    const finalFile = path.join(stateDir, "detect-health.json");
    await writeFile(tmpFile, JSON.stringify(health));
    await rename(tmpFile, finalFile);
  }

  async function stop() {
    stopping = true;
    clearInterval(tickTimer);
    clearInterval(healthTimer);

    // Cancel pending restarts
    for (const timer of restartTimers.values()) {
      clearTimeout(timer);
    }

    // Send SIGTERM to all workers
    const workersArray = Array.from(workers.values());
    for (const worker of workersArray) {
      try {
        worker.child.kill("SIGTERM");
      } catch {}
    }

    // Wait for workers to exit or timeout
    const killDeadline = Date.now() + killAfterMs;
    while (workers.size > 0 && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Force kill any remaining workers
    for (const worker of workers.values()) {
      try {
        worker.child.kill("SIGKILL");
      } catch {}
    }

    // Wait for all workers to actually exit
    while (workers.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Finish all open events
    const nowUtc = new Date(8.64e15).toISOString();
    for (const cam of cameras.values()) {
      const step = advanceFold(cam.fold, [], nowUtc);
      cam.fold = step.state;
      for (const finished of step.finished) {
        eventsDb.upsert(finished, true);
      }
    }

    eventsDb.close();
  }

  return {
    stop,
    cameras: getCameras,
    tick: () => {
      for (const cam of cameras.values()) {
        const step = advanceFold(cam.fold, [], now().toISOString());
        cam.fold = step.state;
        for (const finished of step.finished) {
          eventsDb.upsert(finished, true);
        }
      }
    },
    writeHealth,
  };
}

// Run as a daemon if invoked directly
if (process.argv[1]?.endsWith("detect-service.mjs")) {
  const stateDir = process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  // The AI libraries live in their own environment, not the system Python.
  const pythonBin = process.env.CAMPLAT_DETECT_PYTHON ?? "python3";
  // CAMPLAT_DETECT_WORKER: another worker program, for the harness's fakes.
  const worker = process.env.CAMPLAT_DETECT_WORKER;

  startDetect({ stateDir, python: pythonBin, ...(worker ? { workerPath: worker } : {}) }).catch((err) => {
    defaultLog("error", err.message);
    process.exit(1);
  }).then((svc) => {
    const shutdown = async () => {
      await svc.stop();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
