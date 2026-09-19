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
    const child = spawnFn(python, [
      workerPath,
      "--camera", cameraId,
      "--url", substreamUrl,
      "--fps", String(grantedFps),
      "--model", finalModelPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    workers.set(cameraId, { child, substreamUrl, urlPassword: extractUrlPassword(substreamUrl) });
    // The scrubber reads the camera's own password from here: a camera whose
    // URL carries a password other than the site's must have it blanked too.
    cam.urlPassword = extractUrlPassword(substreamUrl);
    cam.state = "watching";
    cam.lastFrameUtc = null;
    cam.invalidLines = 0;
    cam.fold = emptyFold();

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
          const step = advanceFold(cam.fold, parsed.detections, now().toISOString());
          cam.fold = step.state;
          for (const update of step.updated) {
            eventsDb.upsert(update, false);
          }
          for (const finished of step.finished) {
            eventsDb.upsert(finished, true);
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
      timer.unref?.();
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
  tickTimer.unref?.();

  // Health timer
  const healthTimer = setInterval(() => {
    writeHealth();
  }, healthMs);
  healthTimer.unref?.();

  function getCameras() {
    return Array.from(cameras.values()).map((cam) => ({
      cameraId: cam.cameraId,
      state: cam.state,
      grantedFps: cam.grantedFps,
      lastFrameUtc: cam.lastFrameUtc,
      restarts: cam.restarts,
      invalidLines: cam.invalidLines,
    }));
  }

  async function writeHealth() {
    const health = {
      atUtc: now().toISOString(),
      capacityFps: plan.capacityFps,
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

  startDetect({ stateDir }).catch((err) => {
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
