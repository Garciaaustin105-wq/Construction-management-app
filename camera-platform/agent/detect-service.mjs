/**
 * The detection service: orchestrates workers, manages events, monitors health.
 *
 * Spawns one AI worker per camera, distributes detection results to events.db,
 * and tracks detector health. Never opens the recording index; never queues
 * frames (drops to stay live); never logs a password.
 *
 * Known objects (contracts/knownObjects.ts, agent/known-objects.mjs): every
 * event stored is checked against the camera's known objects - a recurring,
 * still false detection learned from its own history - and flagged hidden
 * when it sits on one. Flagged, never deleted: the Review page can show it.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorkerLine, emptyFold, advanceFold, MAX_WORKER_LINE_BYTES } from "../dist/detectStream.js";
import { MERGE_GAP_MS } from "../dist/detection.js";
import { planDetectSchedule } from "../dist/detectSchedule.js";
import { buildRtspUrl, redactRtspUrl } from "../dist/rtsp.js";
import { matchKnown, noteMatch, lapseKnownObjects, learnKnownObjects, LEARN_WINDOW_MS } from "../dist/knownObjects.js";
import { loadConfig, resolveCameraUrl } from "./recorder-service.mjs";
import { openEventsDb } from "./events-db.mjs";
import { createKnownObjectsStore, cameraFingerprint } from "./known-objects.mjs";
import { DEFAULT_PATHS } from "./config.mjs";

/**
 * The most finished events one learning pass reads (the newest are kept, and
 * the pass says when it was cut). Learning looks back two days; a busy street
 * camera can store thousands of walkers in that time, and every one of them
 * is refused as "moved" long before grouping - but they still have to be read.
 * This keeps one pass to a fraction of a second on the appliance, while two
 * days of a still thing is a few hundred rows at most.
 */
const LEARN_EVENT_LIMIT = 20_000;

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
    // Known objects: learn and lapse every 10 minutes; write match counts at
    // most once a minute (and re-read the file then, so a reset by hand or an
    // owner's answer is seen within a minute). A store can be passed in for a
    // harness; otherwise it is <stateDir>/known-objects.json.
    knownPassMs = 600_000,
    knownFlushMs = 60_000,
    knownObjectsStore = null,
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
      // Finished events stored hidden behind a known object since the service
      // started. Not reset when a worker respawns: it counts what this
      // service hid, not what one worker saw.
      hiddenSinceStart: 0,
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
        hiddenSinceStart: 0,
      });
      return cameras.get(cameraId);
    }
    return cam;
  }

  // ---------------------------------------------------------------- known objects
  //
  // AUSTIN'S DECISION (2026-09-20) IS APPLIED HERE: hiding an event behind a
  // known object happens automatically - no operator click gates it. That
  // overrides build rule 13 (nothing auto-applies) for this one feature,
  // because at 2,880 cameras nobody has the installer time to click each
  // umbrella away. What stands in for the click is the contract's belts
  // (contracts/knownObjects.ts) and three rules this service keeps:
  // - a store that cannot be read hides NOTHING, is reported, and is never
  //   overwritten;
  // - hiding is a flag on a stored event (suppressedBy), never a delete;
  // - every stored event is matched again on every update, so an event that
  //   starts on the known spot and then walks off is shown again at once.

  const knownStore = knownObjectsStore ?? createKnownObjectsStore({ stateDir });

  // Each camera's fingerprint as the detector is actually watching it: from
  // the config read at start, the one its worker's address was built from.
  // Not re-read while running - a camera edited since keeps being watched at
  // its old address until the service restarts, and its objects are still
  // true of what it watches; the restart is when the view changes, and the
  // first pass after it lapses them (belt 4). Only cameras this service
  // watches are included: a camera absent from the fingerprints is left
  // alone rather than called "unseen" by a detector that never looked.
  const fingerprints = new Map();
  for (const assignment of plan.assignments) {
    const configCam = Array.isArray(config.cameras)
      ? config.cameras.find((c) => c && c.cameraId === assignment.cameraId)
      : undefined;
    if (configCam === undefined) continue;
    try {
      fingerprints.set(assignment.cameraId, cameraFingerprint(configCam));
    } catch {
      // An entry that is not an object cannot be fingerprinted; left out, its
      // objects are left alone and nothing new is learned for it.
    }
  }

  const known = {
    // Every object the store holds, as last read or written.
    objects: [],
    // The ones matchKnown may hide behind. Empty until the first pass has
    // read the store, and whenever it cannot be trusted.
    active: [],
    // Why the store cannot be trusted, or null.
    problem: null,
    // Why the last learning pass could not learn, or null.
    learnProblem: null,
    // Why the last write of the store failed, or null.
    saveProblem: null,
    // The last learning pass that completed: when, how many finished events
    // it considered, how many objects it learned, and how many events it
    // could not use and why (build rule 16) - so "why was the umbrella not
    // learned?" has an answer ("too_brief: 17"). null before the first.
    lastPass: null,
  };
  // Finished events hidden since the last write: each is counted on its
  // object (noteMatch) at the next write. One entry per finished event, so a
  // match is counted once.
  let pendingNotes = [];
  // One pass or write at a time: both read and write the same file.
  let knownChain = Promise.resolve();
  const logged = new Map();

  /**
   * Log a message only when it is new for this key: a problem that lasts is
   * said once. `same` says what counts as "the same problem" when the text
   * can shift between passes (a row index, an error code) without anything
   * new to say; by default it is the whole line.
   */
  function logOnce(key, level, msg, extra, same = `${msg}\u0000${JSON.stringify(extra ?? {})}`) {
    if (logged.get(key) === same) return;
    logged.set(key, same);
    log(level, msg, extra);
  }

  /**
   * Text from outside (the store file, a contract's error) made safe for a
   * log line or detect-health.json: the site password blanked, and any
   * address removed whole - user name and host with it - since none of this
   * text has any business carrying one.
   */
  function scrub(text) {
    return scrubLine(String(text), config.credentials?.password, null)
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[an address, removed]");
  }

  /**
   * Store one event update, hidden or not. Every eventsDb.upsert goes through
   * here - an open event on each sighting, and a finished one - so an event
   * is matched again every time it changes: one that sat on the known spot
   * and then walked away is passed suppressedBy null on its next update and
   * shows again. matchKnown answers null for every doubt (unknown travel, a
   * moved thing, a lapsed object, a loose overlap), and null is "show it".
   */
  function storeEvent(update, finished) {
    let suppressedBy = null;
    try {
      suppressedBy = matchKnown(update.event, known.active);
    } catch (err) {
      // matchKnown throws only for a bad option, which this service never
      // passes; if it ever does, the event is stored and shown, never lost.
      logOnce("match-failed", "warn", "known objects: an event could not be matched, so it is shown", { error: scrub(err.message) });
      suppressedBy = null;
    }
    eventsDb.upsert(update, finished, { suppressedBy });
    if (finished && suppressedBy !== null) {
      pendingNotes.push({ objectId: suppressedBy, event: update.event, atUtc: now().toISOString() });
      const cam = cameras.get(update.event.cameraId);
      if (cam) cam.hiddenSinceStart += 1;
    }
  }

  /** Count each noted match on its object, if that object is still active. */
  function applyNotes(objects, notes) {
    if (notes.length === 0) return objects;
    const next = [...objects];
    const at = new Map(next.map((o, i) => [o.id, i]));
    for (const note of notes) {
      const i = at.get(note.objectId);
      // Gone from the file, or lapsed (reset by hand since): nothing to count on.
      if (i === undefined || next[i].state !== "active") continue;
      try {
        next[i] = noteMatch(next[i], note.event, note.atUtc);
      } catch {
        // Another camera or kind: matchKnown never pairs those, so skip it.
      }
    }
    return next;
  }

  function syncKnown(opts) {
    const run = knownChain.then(() => syncKnownNow(opts));
    knownChain = run.catch(() => {});
    return run;
  }

  /**
   * Bring the store and this service's view of it together. Always: read the
   * file (so a reset by hand or an owner's answer written by another process
   * is seen) and count the noted matches. With `learn`: also lapse (belt 4)
   * and learn new objects from the last two days of finished events, then
   * hide each new object's member events. Never throws: a failure here must
   * not stop detection, only known objects.
   */
  async function syncKnownNow({ learn }) {
    try {
      const nowUtc = now().toISOString();
      const notes = pendingNotes;
      pendingNotes = [];
      let learned = [];
      let lapsedHere = [];
      let learnProblem = null;
      let truncated = false;
      let learning = null;
      // The objects with notes counted and lapses applied, before anything is
      // learned: kept so a write that fails can still stop hiding behind what
      // lapsed (hiding less is the safe side), without hiding behind anything
      // new that was never saved.
      let withoutLearned = null;

      const result = await knownStore.update((objects) => {
        learned = [];
        lapsedHere = [];
        learnProblem = null;
        truncated = false;
        learning = null;
        let next = applyNotes(objects, notes);
        if (!learn) {
          withoutLearned = next;
          return notes.length > 0 ? next : null;
        }
        const lapsed = lapseKnownObjects(next, nowUtc, fingerprints);
        lapsedHere = lapsed.filter((o, i) => o.state === "lapsed" && next[i].state === "active");
        next = lapsed;
        withoutLearned = next;
        try {
          const since = new Date(Date.parse(nowUtc) - LEARN_WINDOW_MS).toISOString();
          const recent = eventsDb.recentFinished(since, LEARN_EVENT_LIMIT);
          truncated = recent.truncated;
          learning = learnKnownObjects({ events: recent.events, existing: next, nowUtc, fingerprints });
          learned = learning.learned;
          next = [...next, ...learned];
        } catch (err) {
          // One unreadable stored event stops learning for every camera
          // (learnKnownObjects refuses rather than skip it). Said, and kept in
          // detect-health.json; objects already known go on hiding.
          learnProblem = `learning failed: ${scrub(err.message)}`;
        }
        return next;
      });

      if (!result.ok) {
        if (result.code === "unreadable") {
          // Nothing is hidden while the file cannot be trusted, and nothing
          // is written over it. Matches noted meanwhile have nothing to be
          // counted on, and are dropped.
          known.objects = [];
          known.active = [];
          known.problem = scrub(result.problem);
          logOnce("store", "warn", "known objects file cannot be trusted: nothing is hidden until it is fixed, and it will not be overwritten", { problem: known.problem });
        } else {
          // The file on disk is still what it was, and still readable. Keep
          // the counts to write next time, stop hiding behind anything that
          // lapsed, and do not hide behind anything learned but not saved.
          pendingNotes = [...notes, ...pendingNotes];
          known.objects = withoutLearned ?? result.objects;
          known.active = known.objects.filter((o) => o.state === "active");
          known.problem = null;
          known.saveProblem = scrub(result.problem);
          // Said once while it lasts, whatever the error code of each try.
          logOnce("save", "warn", "known objects could not be saved; will try again", { problem: known.saveProblem }, "failing");
        }
        return;
      }

      if (known.problem !== null) {
        log("info", "known objects file can be read again", {});
        logged.delete("store");
      }
      known.problem = null;
      if (known.saveProblem !== null) logged.delete("save");
      known.saveProblem = null;

      const before = new Map(known.objects.map((o) => [o.id, o]));
      const after = new Map(result.objects.map((o) => [o.id, o]));
      const lapsedIds = new Set(lapsedHere.map((o) => o.id));

      for (const o of learned) {
        if (!after.has(o.id)) continue;
        // Saved first, then its members hidden. The other order could leave
        // events hidden behind an object that never reached the file, where
        // no reset by hand could find it.
        let hidden = null;
        try {
          hidden = eventsDb.setSuppressed(o.memberEventIds, o.id);
        } catch (err) {
          logOnce(`hide-${o.id}`, "warn", "known object learned, but its events could not be marked hidden", { objectId: o.id, error: scrub(err.message) });
        }
        const round = (v) => Math.round(v * 1000) / 1000;
        log("info", "known object learned: events on this spot are now hidden automatically", {
          cameraId: o.cameraId,
          kind: o.kind,
          objectId: o.id,
          box: { x: round(o.box.x), y: round(o.box.y), w: round(o.box.w), h: round(o.box.h) },
          members: o.members,
          firstSeenUtc: o.firstSeenUtc,
          lastSeenUtc: o.lastSeenUtc,
          spanMinutes: Math.round((Date.parse(o.lastSeenUtc) - Date.parse(o.firstSeenUtc)) / 60_000),
          hidden,
        });
      }
      for (const o of lapsedHere) {
        if (after.get(o.id)?.state !== "lapsed") continue;
        log("info", "known object lapsed: events on this spot are shown again", {
          cameraId: o.cameraId, kind: o.kind, objectId: o.id, reason: o.lapseReason,
        });
      }
      // Changes another process made: a reset by hand (camctl), or an object
      // taken out of the file. camctl already showed their events again, but
      // this service kept hiding new ones until it read the file - so show
      // those too. Only for objects this service was hiding behind.
      for (const [id, prev] of before) {
        if (prev.state !== "active" || lapsedIds.has(id)) continue;
        const cur = after.get(id);
        if (cur !== undefined && cur.state === "active") continue;
        if (cur !== undefined && cur.lapseReason !== "reset_by_hand") continue;
        let shown = null;
        try {
          shown = eventsDb.clearSuppressed(id);
        } catch (err) {
          logOnce(`show-${id}`, "warn", "known object stopped, but its events could not be shown again", { objectId: id, error: scrub(err.message) });
        }
        log("info", cur === undefined
          ? "known object is no longer in the file: its events are shown again"
          : "known object reset by hand: its events are shown again", {
          cameraId: prev.cameraId, kind: prev.kind, objectId: id, shown,
        });
      }

      known.objects = result.objects;
      known.active = result.objects.filter((o) => o.state === "active");
      if (learn) {
        // Events it could not use, counted by reason (each event sits in
        // exactly one refusal). null counts when learning itself failed:
        // nothing was considered, which is not the same as zero refused.
        let rejected = null;
        if (learning !== null) {
          rejected = {};
          for (const r of learning.rejected) rejected[r.reason] = (rejected[r.reason] ?? 0) + r.eventIds.length;
        }
        known.lastPass = {
          atUtc: nowUtc,
          considered: learning?.considered ?? null,
          learned: learned.length,
          rejected,
          truncated,
        };
        known.learnProblem = learnProblem;
        // Said once while it lasts: the message names a row by its place in
        // the list, which moves as events arrive, with nothing new to say.
        if (learnProblem !== null) logOnce("learn", "warn", "known objects: nothing could be learned this pass", { problem: learnProblem }, "failing");
        else logged.delete("learn");
        if (truncated) {
          logOnce("truncated", "info", "known objects: learning read only the newest finished events", { limit: LEARN_EVENT_LIMIT });
        }
      }
    } catch (err) {
      // A bug here must not take detection down with it.
      logOnce("sync", "warn", "known objects could not be brought up to date", { error: scrub(err.message) });
    }
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
          // the event holds. storeEvent adds only the known-object flag.
          for (const update of step.updated) {
            storeEvent(update, false);
          }
          for (const finished of step.finished) {
            storeEvent(finished, true);
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

  // Read the known objects (and learn) BEFORE the first worker starts, so the
  // first frame is matched against them rather than slipping through while
  // the file is still being read. syncKnown never throws: a store it cannot
  // read leaves nothing hidden and detection starts all the same.
  await syncKnown({ learn: true });

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
        storeEvent(finished, true);
      }
    }
  }, tickMs);

  // Health timer
  const healthTimer = setInterval(() => {
    writeHealth();
  }, healthMs);

  // Known objects: learn and lapse, and separately write match counts (and
  // re-read the file). Neither runs once stop() has begun.
  const knownPassTimer = setInterval(() => {
    if (!stopping) syncKnown({ learn: true });
  }, knownPassMs);
  const knownFlushTimer = setInterval(() => {
    if (!stopping) syncKnown({ learn: false });
  }, knownFlushMs);

  function getCameras() {
    return Array.from(cameras.values()).map((cam) => ({
      cameraId: cam.cameraId,
      state: cam.state,
      grantedFps: cam.grantedFps,
      // Read only as "this camera is alive", never as "this camera is
      // stalled": with the gate on, a quiet camera can go a whole
      // keepalive (5 s by default, motion_gate.py's DEFAULT_KEEPALIVE_MS) between
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
      // active: the known objects hiding events on this camera now (0 while
      // the store cannot be read - see the top-level problem). hiddenSinceStart:
      // finished events stored hidden since the service started; the member
      // events hidden when an object is learned are counted on the object
      // (its `members`), not here.
      knownObjects: {
        active: known.active.filter((o) => o.cameraId === cam.cameraId).length,
        hiddenSinceStart: cam.hiddenSinceStart,
      },
    }));
  }

  async function writeHealth() {
    const health = {
      atUtc: now().toISOString(),
      capacityFps: plan.capacityFps,
      minConfidence,
      motionGate,
      // problem: why known-objects.json cannot be trusted (nothing is hidden
      // while it is set), or null. learnProblem / saveProblem: why the last
      // learning pass or write failed, or null. lastPass: the last learning
      // pass that completed - { atUtc, considered, learned, rejected (events
      // per reason), truncated } - or null before the first.
      knownObjects: {
        active: known.active.length,
        lapsed: known.objects.filter((o) => o.state === "lapsed").length,
        problem: known.problem,
        learnProblem: known.learnProblem,
        saveProblem: known.saveProblem,
        lastPass: known.lastPass,
      },
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
    clearInterval(knownPassTimer);
    clearInterval(knownFlushTimer);

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
        storeEvent(finished, true);
      }
    }

    // Count the last matches before the database closes; a pass already
    // running finishes first (the chain), and none starts after this.
    await syncKnown({ learn: false });

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
          storeEvent(finished, true);
        }
      }
    },
    writeHealth,
    // For a harness, as tick is: run what the timers run, now.
    knownPass: () => syncKnown({ learn: true }),
    knownFlush: () => syncKnown({ learn: false }),
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
