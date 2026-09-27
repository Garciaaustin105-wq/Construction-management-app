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

import { readFile, writeFile, rename, mkdir, appendFile, readdir, unlink, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorkerLine, emptyFold, advanceFold, MAX_WORKER_LINE_BYTES } from "../dist/detectStream.js";
import { MERGE_GAP_MS } from "../dist/detection.js";
import { planDetectSchedule } from "../dist/detectSchedule.js";
import { buildRtspUrl, redactRtspUrl, RtspTemplateError } from "../dist/rtsp.js";
import { matchKnown, noteMatch, lapseKnownObjects, learnKnownObjects, LEARN_WINDOW_MS } from "../dist/knownObjects.js";
import {
  checkCameraAiSettingsFile, settingsForCamera, judgeDetection, scheduleOpen, CAMERA_AI_SETTINGS_VERSION,
} from "../dist/cameraAiSettings.js";
import { checkAreasFile, boxInsideArea, AREAS_VERSION } from "../dist/areas.js";
import { advanceOccupancy, INITIAL_OCCUPANCY_STATE } from "../dist/zoneOccupancy.js";
import { wholeCameraAreaId, reportDayRange } from "../dist/managerRules.js";
import { localParts } from "../dist/alertRules.js";
import {
  checkSiteSettingsFile, siteSettingsView, isFeatureEnabled, effectiveTimeZone, DEFAULT_APPEARANCE_MATCH_PERCENT,
} from "../dist/siteSettings.js";
import {
  learnTodaysManager, matchAppearance, checkAppearanceTodayFile, isAppearanceTodayStale, APPEARANCE_TODAY_VERSION,
  MIN_SIGNATURES_TO_LEARN,
} from "../dist/appearance.js";
import { loadConfig, resolveCameraUrl } from "./recorder-service.mjs";
import { openEventsDb } from "./events-db.mjs";
import { openOccupancyDb, OCCUPANCY_DB_FILE } from "./occupancy-db.mjs";
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

/**
 * Teach list, piece 1 (TEACH-LIST-SPEC.md): the gate's own minute-by-minute
 * bookkeeping, kept so the teach list can find a minute where the gate saw
 * motion but nothing was stored - a miss leaves no event, so motion is the
 * only thing that can point at one. One line per camera per minute, in
 * `<stateDir>/gate-windows/<YYYY-MM-DD>.jsonl` (UTC day - the same day a
 * GET /teach-moments?day= names). contracts/teachCandidates.ts's GateWindow
 * type and agent/api-server.mjs's readGateWindowsForDay read exactly this
 * shape back; this file owns the writing and the housekeeping, they own the
 * reading, and neither copies the other's code (build rule 3).
 */
const GATE_WINDOWS_DIR_NAME = "gate-windows";
const GATE_WINDOWS_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const GATE_WINDOWS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-camera AI settings (CAMERA-AI-SETTINGS-SPEC.md): zones, schedule,
 * sensitivity, kinds, installer-written from the Cameras page's own API
 * (agent/camera-ai-settings.mjs) and picked up here on a timer, never a
 * restart. `<stateDir>/camera-ai.json` - same directory, same tmp-then-
 * rename convention as detect.json and known-objects.json.
 */
const CAMERA_AI_SETTINGS_FILE = "camera-ai.json";
const AI_SETTINGS_RELOAD_MS = 30_000;
function emptyAiSettingsFile() {
  return { version: CAMERA_AI_SETTINGS_VERSION, cameras: {} };
}

/**
 * Manager rules' occupancy (MANAGER-RULES-SPEC.md section 2): areas.json
 * (the installer-drawn polygons) and the `managerRules` feature switch, both
 * re-read every `occupancyReloadMs`, same "keep the last good copy"
 * discipline camera-ai.json already gets above. The switch lives in
 * site.json (contracts/siteSettings.ts) - a SEPARATE file with a separate
 * owner (agent/site-settings.mjs). This service reads it with its OWN small
 * reader (loadManagerRulesSwitchNow, below) - never `createSiteSettings`
 * (which wants an `audit` function and a whole HTTP route this service has
 * no business running), and never contracts/siteSettings.ts's own
 * `checkSiteSettingsFile`/`isFeatureEnabled` either: `managerRules` is not in
 * that file's FEATURE_REGISTRY yet in this build (a later build adds the
 * Rules/Reports pages and registers it there), and `checkSiteSettingsFile`
 * REFUSES THE WHOLE FILE over any feature key its registry does not list
 * ("an unknown feature key ... gets 400") - so a real site.json naming this
 * switch would fail that validator entirely and fall back to the last good
 * reading, never the switch's own value, however carefully this service
 * "kept the last good copy" around that call. This service's job is only
 * ever "is this one boolean true", so it reads exactly that from the raw
 * JSON and ignores every other field - "a small shared reader", the
 * alternative this service's own job description names.
 */
const AREAS_FILE = "areas.json";
const SITE_SETTINGS_FILE = "site.json";
const OCCUPANCY_RELOAD_MS = 30_000;
const MANAGER_RULES_FEATURE_KEY = "managerRules";
/** contracts/zoneOccupancy.ts's own OccupancyKind - the two kinds areas are judged on. */
const OCCUPANCY_KINDS = ["person", "vehicle"];
function emptyAreasFile() {
  return { version: AREAS_VERSION, areas: [] };
}

/**
 * Appearance of the day (APPEARANCE-OF-DAY-SPEC.md, MANAGER-RULES-SPEC.md
 * build 3): "just need to learn what managers look like daily without
 * learning the face" - a per-site switch (contracts/siteSettings.ts's own
 * `appearanceOfDay` feature, off by default in every preset), re-read from
 * the SAME site.json every `appearanceReloadMs`. Unlike `managerRulesEnabled`
 * above (a hand-rolled single-field reader, kept that way for a historical
 * reason its own comment explains), `appearanceOfDay` and `managerRules` are
 * BOTH already listed in contracts/siteSettings.ts's FEATURE_REGISTRY today,
 * so this reader uses the real validator (`checkSiteSettingsFile`) rather
 * than inventing a second one - a malformed site.json is logged once and the
 * last good appearance settings are kept, exactly the "keep the last good
 * copy" discipline every other file this service reloads already keeps.
 */
const APPEARANCE_RELOAD_MS = 30_000;
const APPEARANCE_TODAY_FILE = "appearance-today.json";
/** "The first hour of the site's openHours" / "the first two hours" - the
 *  gate `learnTodaysManager` needs both a primary-manager window and a
 *  (superset) second-manager window. Agent-level, not a pure contract: this
 *  file decides which raw sightings fall in which window (contracts/
 *  appearance.ts's own header comment: "this file does not itself decide
 *  WHICH detections fall inside a window ... that judgement belongs to
 *  whoever correlates occupancy tracking with this event id"). */
const FIRST_MANAGER_WINDOW_MS = 60 * 60_000;
const SECOND_MANAGER_WINDOW_MS = 2 * 60 * 60_000;

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

/**
 * Fresh time-source counters. arrival/read start at null, not 0 (build rule
 * 5 - a blank is not a zero): until this worker has sent a single FRAME line
 * carrying a timeSource, we have not observed either one, so we cannot say
 * "0 arrival frames" without pretending we looked and found none. unknown
 * starts at 0: whether a frame carries the field at all is answered the
 * instant it arrives, with none of that same ambiguity - it is a fact about
 * the line itself, not a guess about a clock we have not seen yet.
 */
function emptyTimeSourceCounts() {
  return { arrival: null, read: null, unknown: 0 };
}

/**
 * Record one frame's timeSource into a counts bucket, in place. `source` is
 * exactly what contracts/detectStream.ts's parseWorkerLine handed back for a
 * "frame" line: "arrival", "read", or undefined for an older worker that has
 * never heard of the field - never defaulted to either name here, same as
 * that parser refuses to invent one.
 */
function bumpTimeSourceCounts(counts, source) {
  if (source === "arrival" || source === "read") {
    // The FIRST typed frame this bucket has ever seen flips BOTH fields from
    // null to a real count together: once timeSource is flowing at all, "0
    // arrival frames so far" is a fact worth showing, not a guess - and
    // showing it is exactly what makes a camera stuck on "read" only visible
    // as such, instead of reading as two unknowns.
    if (counts.arrival === null) counts.arrival = 0;
    if (counts.read === null) counts.read = 0;
    counts[source] += 1;
  } else {
    // No field at all: an older worker. Counted on its own, never folded into
    // arrival or read - a mix of old and new workers behind one camera (a
    // mid-fleet upgrade) must stay visibly split, not average out into a
    // number that looks like a clock decision nobody made.
    counts.unknown += 1;
  }
}

/**
 * Close out a camera's current time-source window: whatever counts built up
 * become the reported lastWindow, and a fresh, empty window starts counting
 * from here. Called on the same boundary the gate feature already uses (a
 * "gate" line, once per windowS) when the gate is on, or on this service's
 * own timeSourceWindowMs timer when it is off - see that option's comment
 * for why the two do not share one mechanism.
 */
function closeTimeSourceWindow(cam) {
  cam.timeSource.lastWindow = cam.timeSourceOpenWindow;
  cam.timeSourceOpenWindow = emptyTimeSourceCounts();
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
    // Per-camera AI settings (CAMERA-AI-SETTINGS-SPEC.md): how often
    // camera-ai.json is re-read. A harness passes something small so a check
    // does not have to wait a real 30 s; svc.reloadAiSettings() (below) also
    // lets a harness trigger a re-read on demand, the same way knownPass and
    // knownFlush already do for known objects.
    aiSettingsReloadMs = AI_SETTINGS_RELOAD_MS,
    // Manager rules' occupancy (MANAGER-RULES-SPEC.md section 2): how often
    // areas.json and the managerRules feature switch (site.json) are
    // re-read. A harness passes something small so a check does not have to
    // wait a real 30 s; svc.reloadOccupancyConfig() (below) also lets a
    // harness trigger a re-read on demand, same as reloadAiSettings does for
    // camera-ai.json.
    occupancyReloadMs = OCCUPANCY_RELOAD_MS,
    // Appearance of the day: how often site.json's `appearanceOfDay` switch,
    // `appearanceMatchPercent`, `openHours` and effective time zone are
    // re-read. A harness passes something small so a check does not have to
    // wait a real 30 s; svc.reloadAppearanceConfig() (below) also lets a
    // harness trigger a re-read on demand, same as reloadOccupancyConfig does
    // for areas.json/managerRules.
    appearanceReloadMs = APPEARANCE_RELOAD_MS,
    // Teach list, piece 1: how often the once-a-day sweep of old gate-window
    // files runs. A day in production; a harness passes something small so a
    // check does not have to wait a real day to see it happen again.
    gateRetentionCheckMs = 24 * 60 * 60 * 1000,
    // How often a camera's timeSource lastWindow closes and starts fresh,
    // WHEN THE GATE IS OFF. The worker never sends a periodic timeSource
    // rollup the way it does for the gate (every frame line carries its own
    // stamp, one at a time) - so with no gate line to close a window on,
    // this is the only boundary there is. Default 60 s matches
    // detector/yolox_worker.py's own gate windowS default, so
    // detect-health.json reads on a comparable "per minute" basis whether or
    // not motionGate is configured. With the gate ON, its own "gate" line
    // closes the window instead (see closeTimeSourceWindow's other call
    // site) and this timer is not created at all - running both would slice
    // the same frames on two independently-timed clocks.
    timeSourceWindowMs = 60_000,
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
      // Unlike gate, tracked for every camera regardless of motionGate - a
      // silently failed arrival stamp is exactly as real a problem with the
      // gate off as with it on. sinceStart/lastWindow are always present
      // objects (never null themselves); only the arrival/read counts inside
      // them start null, per emptyTimeSourceCounts's own comment.
      timeSource: { sinceStart: emptyTimeSourceCounts(), lastWindow: emptyTimeSourceCounts() },
      // The window currently being counted, not yet closed out to
      // timeSource.lastWindow - internal bookkeeping only, never read back by
      // getCameras()/detect-health.json directly.
      timeSourceOpenWindow: emptyTimeSourceCounts(),
      // Finished events stored hidden behind a known object since the service
      // started. Not reset when a worker respawns: it counts what this
      // service hid, not what one worker saw.
      hiddenSinceStart: 0,
      // Per-camera AI settings' schedule (CAMERA-AI-SETTINGS-SPEC.md): null
      // until the first check, then { open, sinceUtc } - sinceUtc moves only
      // on a real open/closed transition, never on every check.
      aiScheduleState: null,
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
        timeSource: { sinceStart: emptyTimeSourceCounts(), lastWindow: emptyTimeSourceCounts() },
        timeSourceOpenWindow: emptyTimeSourceCounts(),
        hiddenSinceStart: 0,
        aiScheduleState: null,
      });
      return cameras.get(cameraId);
    }
    return cam;
  }

  // ---------------------------------------------------------------- per-camera AI settings

  // The last GOOD settings file, or the empty defaults if there never was
  // one. Re-read every aiSettingsReloadMs (see the timer near the other
  // interval timers below); a file that cannot be read or fails validation
  // is logged once and this is left exactly as it is (CAMERA-AI-SETTINGS-
  // SPEC.md: "a bad file is logged and the previous good settings are kept").
  let aiSettingsFile = emptyAiSettingsFile();

  function aiSettingsFor(cameraId) {
    return settingsForCamera(aiSettingsFile, cameraId);
  }

  /** Re-read camera-ai.json now. Never throws: every failure keeps the last
   *  good settings and logs once while it lasts (logOnce, defined below with
   *  known objects' own problem logging - shared dedupe map). */
  async function loadAiSettingsNow() {
    let raw;
    try {
      raw = await readFile(path.join(stateDir, CAMERA_AI_SETTINGS_FILE), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        // Never configured (or removed by hand): the defaults for every
        // camera, same as a freshly-provisioned site - not a problem to log.
        if (logged.has("ai-settings")) logged.delete("ai-settings");
        aiSettingsFile = emptyAiSettingsFile();
        return;
      }
      logOnce("ai-settings", "warn", "camera AI settings could not be read; the last good settings are kept", { error: scrub(err.message) });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOnce("ai-settings", "warn", "camera AI settings file is not valid JSON; the last good settings are kept", { error: scrub(err.message) });
      return;
    }
    const check = checkCameraAiSettingsFile(parsed, minConfidence);
    if (!check.ok) {
      logOnce("ai-settings", "warn", "camera AI settings file failed validation; the last good settings are kept", {
        errors: check.errors.slice(0, 3).map((e) => `${e.cameraId || "(file)"}: ${e.field}: ${e.reason}`),
      }, `bad:${check.errors.length}`);
      return;
    }
    if (logged.has("ai-settings")) {
      logged.delete("ai-settings");
      log("info", "camera AI settings file can be read again", {});
    }
    aiSettingsFile = check.file;
  }

  /**
   * Whether `cam`'s AI is watching at `nowUtc`, per its current settings'
   * schedule - and the { open, sinceUtc } this tick's detect-health.json
   * reports. `sinceUtc` only moves on a real open<->closed transition, so a
   * camera that has been open for hours does not report "since" every call.
   */
  function refreshAiSchedule(cam, settings, nowUtc) {
    const open = scheduleOpen(settings, Date.parse(nowUtc));
    if (cam.aiScheduleState === null || cam.aiScheduleState.open !== open) {
      cam.aiScheduleState = { open, sinceUtc: nowUtc };
    }
    return cam.aiScheduleState;
  }

  // ---------------------------------------------------------------- manager rules' occupancy
  //
  // MANAGER-RULES-SPEC.md section 2. Fed from the SAME raw frames the fold
  // above sees (never from events.db - a parked car hidden behind a known
  // object must still show `present` in its spot, because occupancy never
  // asks known objects anything), gated by the SAME camera-ai settings
  // judgement (`judgeDetection`) storeEvent already applies - "the same
  // 'counts' decision the camera's settings make" (the spec's own words).
  //
  // The switch is OFF unless site.json's `managerRules` feature is on: see
  // this constant's own comment above for why that is `false` in this build
  // regardless of what site.json says, until a later build registers the
  // key at all.

  /** The last GOOD areas.json, or the empty file if there never was one (or
   *  it does not exist yet - most sites, most of the time). */
  let areasFile = emptyAreasFile();
  /** The last GOOD reading of site.json's `managerRules` switch. Starts
   *  `false` (the registry default) - a site that has never touched
   *  site.json, or whose site.json this service has not read yet, samples
   *  no occupancy, same as "never configured" everywhere else in this file. */
  let managerRulesEnabled = false;

  function areasForCamera(cameraId) {
    return areasFile.areas.filter((a) => a.cameraId === cameraId);
  }

  /** Re-read areas.json now. Never throws: a bad or missing file keeps the
   *  last good areas and logs once while it lasts (same logOnce dedupe every
   *  other file-reload problem in this service uses). */
  async function loadAreasFileNow() {
    let raw;
    try {
      raw = await readFile(path.join(stateDir, AREAS_FILE), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        // Never configured: no areas anywhere, on any camera - not a problem
        // to log, same as camera-ai.json's own ENOENT above.
        if (logged.has("areas-file")) logged.delete("areas-file");
        areasFile = emptyAreasFile();
        return;
      }
      logOnce("areas-file", "warn", "areas file could not be read; the last good areas are kept", { error: scrub(err.message) });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOnce("areas-file", "warn", "areas file is not valid JSON; the last good areas are kept", { error: scrub(err.message) });
      return;
    }
    const checked = checkAreasFile(parsed);
    if (!checked.ok) {
      logOnce("areas-file", "warn", "areas file failed validation; the last good areas are kept", {
        errors: checked.errors.slice(0, 3).map((e) => `${e.index}: ${e.field}: ${e.reason}`),
      }, `bad:${checked.errors.length}`);
      return;
    }
    if (logged.has("areas-file")) {
      logged.delete("areas-file");
      log("info", "areas file can be read again", {});
    }
    areasFile = checked.file;
  }

  /**
   * Re-read site.json's `managerRules` switch now - deliberately NOT through
   * contracts/siteSettings.ts's own checkSiteSettingsFile/siteSettingsView
   * (see this section's header comment for why: that validator refuses the
   * WHOLE file over a feature key its registry does not list yet, which
   * `managerRules` is not, in this build). This reads exactly one thing -
   * `parsed.features.managerRules`, a plain boolean - and ignores every
   * other field of site.json entirely; it is not a second, competing
   * validator for the rest of that file, only a narrow, single-purpose
   * lookup. `false` (the switch's eventual registry default) whenever the
   * field is missing or not really a boolean, same as "a feature not
   * mentioned reads at its default" everywhere else this codebase reads a
   * feature switch. Never throws: a bad or missing file keeps the last good
   * reading of the switch, exactly like camera-ai.json's own reload above.
   */
  async function loadManagerRulesSwitchNow() {
    let raw;
    try {
      raw = await readFile(path.join(stateDir, SITE_SETTINGS_FILE), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        if (logged.has("site-settings-occupancy")) logged.delete("site-settings-occupancy");
        managerRulesEnabled = false;
        return;
      }
      logOnce("site-settings-occupancy", "warn", "site settings could not be read; the last good managerRules switch is kept", { error: scrub(err.message) });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOnce("site-settings-occupancy", "warn", "site.json is not valid JSON; the last good managerRules switch is kept", { error: scrub(err.message) });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logOnce("site-settings-occupancy", "warn", "site.json is not an object; the last good managerRules switch is kept", {});
      return;
    }
    if (logged.has("site-settings-occupancy")) {
      logged.delete("site-settings-occupancy");
      log("info", "site settings can be read again", {});
    }
    const features = parsed.features;
    const isFeaturesRecord = typeof features === "object" && features !== null && !Array.isArray(features);
    const flag = isFeaturesRecord ? features[MANAGER_RULES_FEATURE_KEY] : undefined;
    managerRulesEnabled = typeof flag === "boolean" ? flag : false;
  }

  async function loadOccupancyConfigNow() {
    await loadAreasFileNow();
    await loadManagerRulesSwitchNow();
  }

  /** One (area, kind) tracker's state, keyed by area id (globally unique -
   *  checkAreasFile refuses a duplicate anywhere) plus kind, so an id never
   *  has to be paired with its cameraId to be looked up. */
  const occupancyTrackers = new Map();
  function occupancyTrackerKey(areaId, kind) {
    return `${areaId}\u0000${kind}`;
  }

  /** occupancy.db, opened on the first transition this service ever has to
   *  write - never at start, so a site with the switch off (most of them,
   *  most of the time) never creates the file at all. Opened at most once;
   *  a failure to open it is logged once and every later write is silently
   *  skipped (occupancyDbHandle keeps answering null) rather than retried
   *  every frame. */
  let occupancyDb = null;
  let occupancyDbOpenFailed = false;
  function occupancyDbHandle() {
    if (occupancyDb !== null) return occupancyDb;
    if (occupancyDbOpenFailed) return null;
    try {
      occupancyDb = openOccupancyDb(path.join(stateDir, OCCUPANCY_DB_FILE));
      return occupancyDb;
    } catch (err) {
      occupancyDbOpenFailed = true;
      logOnce("occupancy-db-open", "warn", "occupancy.db could not be opened; occupancy transitions are not being recorded", { error: scrub(err.message) });
      return null;
    }
  }

  /** Write one transition - never thrown into the frame path: a failure to
   *  open or write occupancy.db is logged once and detection keeps running
   *  (MANAGER-RULES-SPEC.md section 2: "a failure is logged, never thrown
   *  into the frame path"). */
  function writeOccupancyTransition(areaId, cameraId, kind, transition) {
    const db = occupancyDbHandle();
    if (db === null) return;
    try {
      db.insert({ areaId, cameraId, kind, state: transition.state, atMs: transition.atMs });
    } catch (err) {
      logOnce("occupancy-db-write", "warn", "an occupancy transition could not be saved; detection keeps running", { error: scrub(err.message) });
    }
  }

  /** Advance one (area, kind) tracker by one piece of evidence, and write
   *  the transition (if any) to occupancy.db. The only place this service
   *  touches an occupancy tracker's state - every caller below hands in
   *  evidence, never a state, per contracts/zoneOccupancy.ts's own pure
   *  `advanceOccupancy`. */
  function feedOccupancy(area, cameraId, kind, evidence) {
    const key = occupancyTrackerKey(area.id, kind);
    const state = occupancyTrackers.get(key) ?? INITIAL_OCCUPANCY_STATE;
    const step = advanceOccupancy(state, evidence, kind);
    occupancyTrackers.set(key, step.state);
    if (step.transition !== null) {
      writeOccupancyTransition(area.id, cameraId, kind, step.transition);
    }
  }

  /**
   * One frame, schedule OPEN: for every area on this camera and every kind,
   * presence evidence when at least one kept detection of that kind is
   * VISIBLE (judgeDetection's `store && hiddenBy === null` - "the same
   * 'counts' decision the camera's settings make", so a settings-hidden
   * detection, or one below this camera's own floor, is never evidence) and
   * lies inside the area (boxInsideArea: ground point, or 40% coverage on
   * the 5x5 grid, for a seated person the desk hides); absence evidence
   * otherwise. `kept` is the SAME site-floor-filtered detections the fold
   * above sees - occupancy applies the camera's own settings on top, exactly
   * as storeEvent does for events.
   *
   * Also feeds a synthetic "whole camera" tracker per kind, keyed
   * `wholeCameraAreaId(cameraId)` (MANAGER-RULES-SPEC.md section 1: "a rule
   * may also use whole camera"; build gap: "whole-camera rules never
   * fire"). Its own "inside" is simpler than a drawn area's - any VISIBLE
   * detection of that kind anywhere in frame, no polygon to test against -
   * but it is the same evidence, the same hysteresis (advanceOccupancy does
   * not know or care which kind of area fed it), and the same gap/
   * schedule-closed ticks below, so a whole-camera rule is never a second,
   * looser measurement than an area rule. Run unconditionally (never gated
   * on `areas.length > 0`): a site with the switch on but no areas drawn yet
   * must still be able to fire "Person after hours".
   */
  function processOccupancyFrame(cameraId, settings, kept, atMs) {
    const areas = areasForCamera(cameraId);
    for (const kind of OCCUPANCY_KINDS) {
      const visibleBoxes = [];
      for (const d of kept) {
        if (d.kind !== kind) continue;
        const judged = judgeDetection(settings, { kind: d.kind, bestConfidence: d.confidence, bestBox: d.box }, minConfidence, atMs);
        if (!judged.store || judged.hiddenBy !== null) continue;
        visibleBoxes.push(d.box);
      }
      for (const area of areas) {
        const inside = visibleBoxes.some((box) => boxInsideArea(box, area.points));
        feedOccupancy(area, cameraId, kind, { type: inside ? "presence" : "absence", atMs });
      }
      const wholeInside = visibleBoxes.length > 0;
      feedOccupancy({ id: wholeCameraAreaId(cameraId) }, cameraId, kind, { type: wholeInside ? "presence" : "absence", atMs });
    }
  }

  /** The schedule closed: not_watching at once, every area and kind on this
   *  camera, plus the whole-camera tracker - MANAGER-RULES-SPEC.md: "The
   *  camera's AI schedule closed: not_watching straight away." Safe to call
   *  every tick while closed: advanceOccupancy's scheduleClosed evidence is
   *  idempotent once already not_watching (no further transition, nothing
   *  written twice). */
  function occupancyScheduleClosed(cameraId, atMs) {
    for (const area of areasForCamera(cameraId)) {
      for (const kind of OCCUPANCY_KINDS) {
        feedOccupancy(area, cameraId, kind, { type: "scheduleClosed", atMs });
      }
    }
    for (const kind of OCCUPANCY_KINDS) {
      feedOccupancy({ id: wholeCameraAreaId(cameraId) }, cameraId, kind, { type: "scheduleClosed", atMs });
    }
  }

  /** "Check now whether the camera has gone quiet" - fed from the existing
   *  1 s tick, schedule OPEN. A no-op for a tracker that has not yet seen a
   *  real frame, or has not gone 120 s since its last one (advanceOccupancy's
   *  own gapTick rule); safe to call every tick regardless. Covers the
   *  whole-camera tracker too, so a whole-camera-only site (no areas drawn)
   *  still gets `not_watching` after a real gap, never silence read as
   *  presence or absence. */
  function occupancyGapTick(cameraId, atMs) {
    for (const area of areasForCamera(cameraId)) {
      for (const kind of OCCUPANCY_KINDS) {
        feedOccupancy(area, cameraId, kind, { type: "gapTick", atMs });
      }
    }
    for (const kind of OCCUPANCY_KINDS) {
      feedOccupancy({ id: wholeCameraAreaId(cameraId) }, cameraId, kind, { type: "gapTick", atMs });
    }
  }

  // ---------------------------------------------------------------- appearance of the day
  //
  // APPEARANCE-OF-DAY-SPEC.md, MANAGER-RULES-SPEC.md build 3: "just need to
  // learn what managers look like daily without learning the face". NO FACE
  // RECOGNITION, EVER - this service never reads a signature apart from the
  // 145 numbers detector/appearance.py (via the worker's own --appearance
  // flag) already reduced a detection to; it never opens a crop, a face
  // detector or a landmark library, and it never writes a person's name
  // anywhere.

  /** The last GOOD reading of the switch, the match threshold, openHours and
   *  the effective time zone - all from site.json, all re-read together on
   *  the same timer (see APPEARANCE_RELOAD_MS's own comment above for why
   *  this uses the real siteSettings validator, unlike managerRulesEnabled's
   *  hand-rolled reader). Starts at the registry defaults / off, same as
   *  "never configured" everywhere else in this file. */
  let appearanceOfDayEnabled = false;
  let appearanceMatchPercent = DEFAULT_APPEARANCE_MATCH_PERCENT;
  let appearanceOpenHours = null;
  let appearanceTimeZone = "UTC";

  /**
   * The zone every "what is today, locally" question in this section is
   * asked in: the openHours SCHEDULE's own timeZone when one is set (it is
   * the schedule's own zone that decides when the store opens each day, and
   * therefore when its "first hour" is - contracts/alertRules.ts's own
   * `isOpen` already reads `schedule.timeZone`, never a separate site
   * setting), falling back to `appearanceTimeZone` (the site's effective
   * zone) only when there is no schedule at all (nothing to fall back to
   * otherwise, and the nightly wipe still has to ask SOME zone). Keeping the
   * window computation and the staleness check on the SAME zone is the
   * point: two different zones for "when did today start" would let the
   * two disagree about what day it is, which is exactly the bug this
   * function exists to rule out.
   */
  function appearanceZone() {
    return appearanceOpenHours !== null ? appearanceOpenHours.timeZone : appearanceTimeZone;
  }

  /** Today's learned signature(s), in memory - the ONLY durable copy is
   *  `<stateDir>/appearance-today.json` itself; this is a cache of what this
   *  process last read or wrote there. `null` until learned (or once wiped). */
  let appearanceTodayFile = null;

  /** This local day's in-progress learning: which fold event ids have been
   *  seen at the manager's desk so far today, and every desk sighting each
   *  one has (timestamp + signature), capped to the first two hours by
   *  never recording past them (see recordAppearanceSighting below).
   *  Reset whenever the local date changes (a new day's window). */
  let appearanceLearning = { localDate: null, sightings: new Map() };

  const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  /** Re-read site.json's appearance-of-day settings now. Never throws: a bad
   *  or missing file keeps the last good reading, exactly like every other
   *  file this service reloads. On a real change of the switch itself, every
   *  running worker is restarted (see restartWorkerForAppearanceChange) so
   *  its --appearance flag matches the new value, the same way any other
   *  worker-launch argument change would need a restart to take effect. */
  async function loadAppearanceConfigNow() {
    let raw;
    try {
      raw = await readFile(path.join(stateDir, SITE_SETTINGS_FILE), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        if (logged.has("site-settings-appearance")) logged.delete("site-settings-appearance");
        appearanceMatchPercent = DEFAULT_APPEARANCE_MATCH_PERCENT;
        appearanceOpenHours = null;
        appearanceTimeZone = systemTimeZone();
        await applyAppearanceSwitch(false);
        return;
      }
      logOnce("site-settings-appearance", "warn", "site settings could not be read; the last good appearance-of-day settings are kept", { error: scrub(err.message) });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOnce("site-settings-appearance", "warn", "site.json is not valid JSON; the last good appearance-of-day settings are kept", { error: scrub(err.message) });
      return;
    }
    const checked = checkSiteSettingsFile(parsed);
    if (!checked.ok) {
      logOnce("site-settings-appearance", "warn", "site settings failed validation; the last good appearance-of-day settings are kept", {
        errors: checked.errors.slice(0, 3).map((e) => `${e.field}: ${e.reason}`),
      }, `bad:${checked.errors.length}`);
      return;
    }
    if (logged.has("site-settings-appearance")) {
      logged.delete("site-settings-appearance");
      log("info", "site settings can be read again", {});
    }
    const view = siteSettingsView(checked.file);
    appearanceMatchPercent = view.appearanceMatchPercent;
    appearanceOpenHours = view.openHours;
    appearanceTimeZone = effectiveTimeZone(view, systemTimeZone());
    await applyAppearanceSwitch(isFeatureEnabled(view.features, "appearanceOfDay"));
  }

  /** Flip the in-memory switch, restarting every running worker so its
   *  --appearance flag catches up (a no-op when the value has not actually
   *  changed). Turning it OFF also wipes appearance-today.json and every
   *  manager-match sighting at once - "deleted ... when the switch turns
   *  off" (APPEARANCE-OF-DAY-SPEC.md) - and clears this day's in-progress
   *  learning, so turning the switch back on later starts learning fresh
   *  rather than resuming stale, possibly-hours-old sightings. */
  async function applyAppearanceSwitch(nextEnabled) {
    if (nextEnabled === appearanceOfDayEnabled) return;
    appearanceOfDayEnabled = nextEnabled;
    for (const worker of workers.values()) {
      worker.restartForSettingChange = true;
      try {
        worker.child.kill("SIGTERM");
      } catch {
        // Already gone; its own exit handler (or the next spawn attempt) sorts it out.
      }
    }
    if (!nextEnabled) {
      appearanceLearning = { localDate: null, sightings: new Map() };
      await wipeAppearanceToday("switch turned off");
    }
  }

  /** Delete appearance-today.json (if any) and every manager-match sighting,
   *  logging once why. Used by the switch turning off, the nightly local-
   *  midnight wipe, and a start whose file's date is already stale - the
   *  three cases APPEARANCE-OF-DAY-SPEC.md names as "DELETED". Never throws:
   *  a failed delete is logged once and the in-memory copy is cleared
   *  regardless, so this service's own idea of "today's manager" is never
   *  stale even if the file on disk could not be removed just now. */
  async function wipeAppearanceToday(reason) {
    appearanceTodayFile = null;
    try {
      await unlink(path.join(stateDir, APPEARANCE_TODAY_FILE));
    } catch (err) {
      if (err.code !== "ENOENT") {
        logOnce("appearance-today-delete", "warn", "appearance-today.json could not be deleted", { error: scrub(err.message), reason });
      }
    }
    clearManagerMatchesIfPresent();
  }

  /** Delete every manager-match row, WITHOUT creating occupancy.db just to
   *  find it empty - a site that has never opened occupancy.db for any
   *  reason must not have this cleanup step be the thing that creates it. */
  function clearManagerMatchesIfPresent() {
    const dbPath = path.join(stateDir, OCCUPANCY_DB_FILE);
    if (occupancyDb === null && !existsSync(dbPath)) return;
    const db = occupancyDbHandle();
    if (db === null) return;
    try {
      db.clearManagerMatches();
    } catch (err) {
      logOnce("manager-matches-clear", "warn", "manager-match sightings could not be cleared", { error: scrub(err.message) });
    }
  }

  /** Re-read appearance-today.json now: absent is fine (not learned yet
   *  today); present is validated and, if stale (a date that is not today,
   *  in the site's own time zone - never UTC), wiped at once, per
   *  isAppearanceTodayStale's own contract. An unreadable or invalid file is
   *  treated as "not learned" (never guessed at, never left half-trusted) -
   *  the next successful learning pass simply overwrites it. */
  async function loadAppearanceTodayNow() {
    let raw;
    try {
      raw = await readFile(path.join(stateDir, APPEARANCE_TODAY_FILE), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        appearanceTodayFile = null;
        return;
      }
      logOnce("appearance-today-read", "warn", "appearance-today.json could not be read; treated as not learned today", { error: scrub(err.message) });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOnce("appearance-today-read", "warn", "appearance-today.json is not valid JSON; treated as not learned today", { error: scrub(err.message) });
      return;
    }
    const checked = checkAppearanceTodayFile(parsed);
    if (!checked.ok) {
      logOnce("appearance-today-read", "warn", "appearance-today.json failed validation; treated as not learned today", {});
      return;
    }
    if (logged.has("appearance-today-read")) logged.delete("appearance-today-read");
    if (isAppearanceTodayStale(checked.file, appearanceZone(), now().toISOString())) {
      await wipeAppearanceToday("stale date on read");
      return;
    }
    appearanceTodayFile = checked.file;
  }

  async function loadAppearanceStateNow() {
    await loadAppearanceConfigNow();
    await loadAppearanceTodayNow();
  }

  /** One area's own manager-desk role, or null - "one manager per store,
   *  very rarely two" means at most one such area site-wide (checkArea/
   *  checkAreasFile already refuse a second one anywhere on the site). */
  function managerDeskArea() {
    return areasFile.areas.find((a) => a.role === "managerDesk") ?? null;
  }

  /** "The first hour of the site's openHours" / "the first two hours",
   *  resolved to real UTC instants for TODAY (the site's own local day at
   *  `nowMs`) - null when the site is closed all day today (no interval, or
   *  a closed date), which simply means no learning window exists today,
   *  not a refusal of the feature itself. `reportDayRange`'s own DST
   *  correction resolves local midnight; the day's own open time is added on
   *  top of that as a flat offset, an approximation this file accepts (a
   *  DST transition landing between midnight and opening time on the same
   *  day is a corner case no store's real hours are likely to hit).
   */
  function firstManagerWindowsToday(openHours, timeZone, nowMs) {
    const { date, weekday } = localParts(timeZone, nowMs);
    if (openHours.closedDates.includes(date)) return null;
    const intervals = openHours.weekly[weekday] ?? [];
    if (intervals.length === 0) return null;
    let earliestOpen = null;
    for (const interval of intervals) {
      if (earliestOpen === null || interval.open < earliestOpen) earliestOpen = interval.open;
    }
    if (earliestOpen === null) return null;
    const dayRange = reportDayRange(timeZone, date);
    if (!dayRange.ok) return null;
    const windowStartMs = dayRange.startMs + earliestOpen * 60_000;
    return {
      windowStartMs,
      firstHourEndMs: windowStartMs + FIRST_MANAGER_WINDOW_MS,
      secondWindowEndMs: windowStartMs + SECOND_MANAGER_WINDOW_MS,
    };
  }

  /** This local day's sightings, restricted to whatever was seen before
   *  `beforeMs`, one PersonSignatureRun (contracts/appearance.ts) per fold
   *  event id that has at least one such sighting. Both the desk-presence
   *  span and the signature LIST are cut at the same boundary, so a run's
   *  signature count never counts a sighting from a later sub-window than
   *  the one being asked about. */
  function appearanceRunsBefore(beforeMs) {
    const runs = [];
    for (const [eventId, sightings] of appearanceLearning.sightings) {
      const inWindow = sightings.filter((s) => s.atMs < beforeMs);
      if (inWindow.length === 0) continue;
      let firstAtMs = inWindow[0].atMs;
      let lastAtMs = inWindow[0].atMs;
      const signatures = [];
      for (const s of inWindow) {
        if (s.atMs < firstAtMs) firstAtMs = s.atMs;
        if (s.atMs > lastAtMs) lastAtMs = s.atMs;
        signatures.push(s.signature);
      }
      runs.push({ eventId, deskPresenceMs: lastAtMs - firstAtMs, signatures });
    }
    return runs;
  }

  let appearanceWriteChain = Promise.resolve();

  /** Write appearance-today.json - 0600, tmp then rename, the same
   *  convention agent/manager-rules.mjs's own persist() and agent/areas.mjs
   *  already keep for their own files. Chained so two learning passes never
   *  interleave two half-written files; failures are logged once and never
   *  thrown into the frame path. `appearanceTodayFile` is updated in memory
   *  BEFORE the write settles, so matching can use today's manager the very
   *  moment learning succeeds, and so this day's learning never re-attempts
   *  itself while the write is still in flight. */
  function writeAppearanceTodayFile(file) {
    appearanceTodayFile = file;
    appearanceWriteChain = appearanceWriteChain
      .then(async () => {
        const finalPath = path.join(stateDir, APPEARANCE_TODAY_FILE);
        const tmpPath = `${finalPath}.tmp`;
        const fh = await open(tmpPath, "w", 0o600);
        try {
          await fh.writeFile(JSON.stringify(file));
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmpPath, finalPath);
        log("info", "today's manager learned from the desk (a clothing signature, never a face)", {
          date: file.date, hasSecondary: file.secondary !== null,
        });
      })
      .catch((err) => {
        logOnce("appearance-today-write", "warn", "appearance-today.json could not be saved; will try again next pass", { error: scrub(err.message) });
      });
    return appearanceWriteChain;
  }

  /** Try to learn today's manager from whatever has been collected so far.
   *  A no-op once already learned today (appearanceTodayFile.date === the
   *  window's own local date) - "it keeps trying until the window ends"
   *  means retrying on more data, never re-learning over an answer already
   *  found. Never throws: learnTodaysManager only throws for a malformed
   *  signature, which cannot happen here (every signature reaching
   *  appearanceLearning already passed parseWorkerLine's own strict check). */
  function attemptLearnTodaysManager(localDate, windows, nowMs) {
    if (appearanceTodayFile !== null && appearanceTodayFile.date === localDate) return;
    const runsFirstHour = appearanceRunsBefore(windows.firstHourEndMs);
    const runsFirstTwoHours = appearanceRunsBefore(windows.secondWindowEndMs);
    let result;
    try {
      result = learnTodaysManager(appearanceOpenHours, runsFirstHour, runsFirstTwoHours);
    } catch (err) {
      log("error", "appearance of the day: learning could not run", { error: err?.message ?? String(err) });
      return;
    }
    if (!result.ok) return;
    writeAppearanceTodayFile({
      version: APPEARANCE_TODAY_VERSION,
      date: localDate,
      primary: result.primary.signature,
      secondary: result.secondary === null ? null : result.secondary.signature,
      learnedAtUtc: new Date(nowMs).toISOString(),
    });
  }

  /**
   * One frame, on the manager-desk camera only, schedule OPEN, appearanceOfDay
   * on, openHours set: record every person detection with a real signature
   * that lies inside the manager's-desk area, keyed by the SAME fold event id
   * `advanceFold` just assigned it (`assigned`, aligned to `kept` by input
   * order - contracts/detectStream.ts's own EventUpdate/assigned contract),
   * then try to learn. Sightings are never recorded past the second window
   * (two hours after opening) - nothing is kept growing forever once the
   * window has closed for the day.
   */
  function recordAppearanceLearning(cameraId, kept, keptAppearances, assignedIds, atMs) {
    const desk = managerDeskArea();
    if (desk === null || desk.cameraId !== cameraId || appearanceOpenHours === null) return;
    const { date: localDate } = localParts(appearanceZone(), atMs);
    if (appearanceLearning.localDate !== localDate) {
      appearanceLearning = { localDate, sightings: new Map() };
    }
    const windows = firstManagerWindowsToday(appearanceOpenHours, appearanceZone(), atMs);
    if (windows === null) return; // closed today: no learning window at all
    if (atMs < windows.windowStartMs || atMs >= windows.secondWindowEndMs) return;
    for (let i = 0; i < kept.length; i++) {
      const d = kept[i];
      const signature = keptAppearances[i];
      if (d.kind !== "person" || signature === null) continue;
      if (!boxInsideArea(d.box, desk.points)) continue;
      const eventId = assignedIds[i];
      let sightings = appearanceLearning.sightings.get(eventId);
      if (sightings === undefined) {
        sightings = [];
        appearanceLearning.sightings.set(eventId, sightings);
      }
      sightings.push({ atMs, signature });
    }
    attemptLearnTodaysManager(localDate, windows, atMs);
  }

  /**
   * One frame, appearanceOfDay on: match every person detection with a real
   * signature against today's file (contracts/appearance.ts's
   * `matchAppearance`), and for every area on THIS camera whose polygon the
   * detection's box lies inside, write a manager-match sighting - "camera,
   * area, at_ms, similarity%" (this build's own job description). A no-op
   * while today's manager is not yet learned (nothing to match against), and
   * for a camera with no areas drawn at all (a match sighting always names
   * an area - a door, an exit, the desk - never "whole camera").
   */
  function processAppearanceMatches(cameraId, kept, keptAppearances, atMs) {
    if (appearanceTodayFile === null) return;
    const areas = areasForCamera(cameraId);
    if (areas.length === 0) return;
    for (let i = 0; i < kept.length; i++) {
      const d = kept[i];
      const signature = keptAppearances[i];
      if (d.kind !== "person" || signature === null) continue;
      const decision = matchAppearance(signature, appearanceTodayFile, appearanceMatchPercent);
      if (!decision.match) continue;
      for (const area of areas) {
        if (!boxInsideArea(d.box, area.points)) continue;
        writeManagerMatch(area.id, cameraId, atMs, decision.which, decision.similarityPercent);
      }
    }
  }

  /**
   * GET /appearance/status's own read (agent/api-server.mjs, a SEPARATE
   * process): learned or not and why, `learnedAtUtc`, a sample count, and
   * whether a second manager exists - NEVER the signature itself, which
   * never leaves this function (it is not even in scope: only
   * `appearanceTodayFile.secondary !== null`, a boolean, is read). Reasons,
   * in the order this build's own job description names them: "switch off",
   * "open hours not set", "no manager's desk area", "not enough sightings
   * yet: N of M" - `null` once actually learned today.
   */
  function appearanceStatusForHealth(nowMs) {
    if (!appearanceOfDayEnabled) {
      return { enabled: false, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: null, minSignaturesToLearn: MIN_SIGNATURES_TO_LEARN, reason: "switch off" };
    }
    const { date: today } = localParts(appearanceZone(), nowMs);
    if (appearanceTodayFile !== null && appearanceTodayFile.date === today) {
      return {
        enabled: true, learnedToday: true, learnedAtUtc: appearanceTodayFile.learnedAtUtc,
        hasSecondary: appearanceTodayFile.secondary !== null, sampleCount: null,
        minSignaturesToLearn: MIN_SIGNATURES_TO_LEARN, reason: null,
      };
    }
    if (appearanceOpenHours === null) {
      return { enabled: true, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: null, minSignaturesToLearn: MIN_SIGNATURES_TO_LEARN, reason: "open hours not set" };
    }
    if (managerDeskArea() === null) {
      return { enabled: true, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount: null, minSignaturesToLearn: MIN_SIGNATURES_TO_LEARN, reason: "no manager's desk area" };
    }
    let sampleCount = 0;
    if (appearanceLearning.localDate === today) {
      const windows = firstManagerWindowsToday(appearanceOpenHours, appearanceZone(), nowMs);
      if (windows !== null) {
        for (const run of appearanceRunsBefore(windows.firstHourEndMs)) {
          if (run.signatures.length > sampleCount) sampleCount = run.signatures.length;
        }
      }
    }
    return {
      enabled: true, learnedToday: false, learnedAtUtc: null, hasSecondary: false, sampleCount,
      minSignaturesToLearn: MIN_SIGNATURES_TO_LEARN,
      reason: `not enough sightings yet: ${sampleCount} of ${MIN_SIGNATURES_TO_LEARN}`,
    };
  }

  /** Write one manager-match sighting - never thrown into the frame path: a
   *  failure to open or write occupancy.db is logged once and detection
   *  keeps running, the exact discipline writeOccupancyTransition already
   *  keeps for the 'occupancy' table in the same database. */
  function writeManagerMatch(areaId, cameraId, atMs, which, similarityPercent) {
    const db = occupancyDbHandle();
    if (db === null) return;
    try {
      db.insertManagerMatch({ areaId, cameraId, atMs, which, similarityPercent });
    } catch (err) {
      logOnce("manager-match-write", "warn", "a manager-match sighting could not be saved; detection keeps running", { error: scrub(err.message) });
    }
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
   *
   * CAMERA-AI-SETTINGS-SPEC.md's "Where it runs": the per-camera threshold,
   * kinds and zones are applied here, BEFORE the known-objects check -
   * judgeDetection first decides whether this update is even stored at all
   * (below the camera's own confidence: "not an event at all", the same
   * meaning the site floor already has), then whether it is hidden by the
   * settings themselves. A `settings:` verdict is used directly as
   * suppressedBy and matchKnown is never even called for this update -
   * "settings-hidden beats known objects", enforced by simply never letting
   * a known-object match have a turn, not by comparing the two afterwards.
   */
  function storeEvent(update, finished) {
    const event = update.event;
    const cam = cameras.get(event.cameraId);
    const settings = aiSettingsFor(event.cameraId);
    const judged = judgeDetection(settings, { kind: event.kind, bestConfidence: event.bestConfidence, bestBox: event.bestBox }, minConfidence, now().getTime());
    if (!judged.store) {
      // Below THIS camera's own minimum confidence: not an event at all, the
      // same meaning the site-wide storing floor already has. Nothing is
      // written - not even a first insert - so an id that never crossed the
      // camera's own floor never appears in events.db at all.
      return;
    }
    let suppressedBy = judged.hiddenBy;
    if (suppressedBy === null) {
      try {
        suppressedBy = matchKnown(event, known.active);
      } catch (err) {
        // matchKnown throws only for a bad option, which this service never
        // passes; if it ever does, the event is stored and shown, never lost.
        logOnce("match-failed", "warn", "known objects: an event could not be matched, so it is shown", { error: scrub(err.message) });
        suppressedBy = null;
      }
    }
    eventsDb.upsert(update, finished, { suppressedBy });
    // Known-objects bookkeeping (matched counts, hiddenSinceStart) is about
    // objects THIS SERVICE learned - never about a settings hide, which
    // teaches nothing and is never counted as a known-object match.
    if (finished && suppressedBy !== null && !suppressedBy.startsWith("settings:")) {
      // update.id is the same events.db id eventsDb.upsert just wrote this
      // event under, and the Review page's /event-crop?id= asks for exactly
      // that id - so noteMatch can move sampleEventId onto it.
      pendingNotes.push({ objectId: suppressedBy, event: { ...event, id: update.id }, atUtc: now().toISOString() });
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
          // CAMERA-AI-SETTINGS-SPEC.md: "known-objects learning ignores
          // events hidden by settings" - a zone- or kind-hidden event was
          // never shown to anyone, and teaching a known object from it would
          // let a setting the installer chose train a DIFFERENT, automatic
          // hide (Austin's 2026-09-20 override) that nothing here asked for.
          const learnable = recent.events.filter((e) => !(typeof e.suppressedBy === "string" && e.suppressedBy.startsWith("settings:")));
          learning = learnKnownObjects({ events: learnable, existing: next, nowUtc, fingerprints });
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

  // ---------------------------------------------------------------- gate windows (teach list, piece 1)
  //
  // Append-only, and never on the critical path: a gate line arrives inside
  // the worker's stdout handler (synchronous, one line at a time), so the
  // write is fired without an await and its own errors are caught inside it -
  // detection must never wait on a disk write, and a bad state dir must never
  // slow or stop it. Every append is chained onto the one before it (the same
  // shape as knownChain above) so two cameras finishing their minute in the
  // same tick cannot interleave two half-written lines into one file.
  const gateWindowsDir = path.join(stateDir, GATE_WINDOWS_DIR_NAME);
  let gateWriteChain = Promise.resolve();

  /** Append one gate window - exactly the six fields TEACH-LIST-SPEC.md
   *  names, nothing more - to its UTC day's file. Never throws: a failure is
   *  logged once (logOnce, the same dedupe every other problem in this
   *  service uses) and that one line is simply lost; the next minute's is
   *  still worth having. */
  function appendGateWindow(window) {
    const line = `${JSON.stringify(window)}\n`;
    const file = path.join(gateWindowsDir, `${window.atUtc.slice(0, 10)}.jsonl`);
    gateWriteChain = gateWriteChain
      .then(() => mkdir(gateWindowsDir, { recursive: true }))
      .then(() => appendFile(file, line, "utf8"))
      .catch((err) => {
        logOnce("gate-windows-write", "warn", "teach list: a gate window could not be saved; detection keeps running", { error: scrub(err.message) });
      });
  }

  /**
   * Delete this directory's OWN files older than 7 days - only a name that is
   * exactly YYYY-MM-DD.jsonl is ever touched, so anything else found here (or
   * anywhere else in stateDir - this never reads outside gateWindowsDir) is
   * left alone. Runs once at start and once a day after that. A directory
   * that does not exist yet (the gate has never run) is not a problem, just
   * nothing to do; a directory that cannot be listed or a file that cannot be
   * deleted is said once and otherwise ignored - a stale file left a little
   * longer is not worth risking detection over.
   */
  async function pruneGateWindows() {
    let entries;
    try {
      entries = await readdir(gateWindowsDir);
    } catch (err) {
      if (err.code === "ENOENT") return;
      logOnce("gate-windows-prune-list", "warn", "teach list: the gate-windows directory could not be listed; nothing pruned this pass", { error: scrub(err.message) });
      return;
    }
    // A file's day is kept once its calendar day is within the last 7 days of
    // now; anything older is deleted. String comparison sorts YYYY-MM-DD
    // exactly the way it sorts in time, so no date parsing is needed here.
    const cutoffDayKey = new Date(now().getTime() - GATE_WINDOWS_RETENTION_MS).toISOString().slice(0, 10);
    for (const name of entries) {
      if (!GATE_WINDOWS_FILE_PATTERN.test(name)) continue;
      if (name.slice(0, 10) >= cutoffDayKey) continue;
      try {
        await unlink(path.join(gateWindowsDir, name));
      } catch (err) {
        if (err.code !== "ENOENT") {
          logOnce(`gate-windows-prune-${name}`, "warn", "teach list: an old gate-windows file could not be deleted", { file: name, error: scrub(err.message) });
        }
      }
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
      // does (resolveCameraUrl); without it the camera answers 401. Checked:
      // resolveCameraUrl never calls buildRtspUrl on this path (a substream
      // URL always has `camera.url` set, so it takes the manual-URL branch,
      // which only ever calls urlForPath) - so a bad site login cannot throw
      // out of this call the way it could out of the host branch below.
      const resolved = resolveCameraUrl({ url: configCam.substreamUrl }, config.credentials);
      if (resolved.kind === "ok") substreamUrl = resolved.url;
    } else if (typeof configCam.host === "string" && configCam.host !== "") {
      const vendor = configCam.vendor ?? "generic";
      const channel = configCam.channel ?? 1;
      // buildRtspUrl REFUSES (throws RtspTemplateError) rather than hand back
      // a broken address when the site login has no username, or the ip it
      // was given is empty - either one would just 401 or never connect. That
      // refusal used to reach here uncaught: one camera with a bad login took
      // the WHOLE detector down, and systemd restarted it in a loop while
      // every other camera on the site sat undetected too. One bad camera
      // must only take itself out.
      let built;
      try {
        built = buildRtspUrl({ vendor, ip: configCam.host, channel, stream: "sub" }, config.credentials);
      } catch (err) {
        if (!(err instanceof RtspTemplateError)) throw err; // anything else is a real bug - let it surface
        cam.state = "bad_login";
        log("warn", "detection skipped: camera's stream address could not be built", { cameraId, reason: scrub(err.message) });
        return;
      }
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
    // Appearance of the day: --appearance ONLY while the site's switch is on
    // at the moment this worker is (re)launched - "off means nothing is
    // computed and nothing is sent" (APPEARANCE-OF-DAY-SPEC.md). A later
    // change of the switch is picked up by restarting this worker
    // (applyAppearanceSwitch above), never by this worker noticing on its own.
    const appearanceArgs = appearanceOfDayEnabled ? ["--appearance"] : [];
    const child = spawnFn(python, [
      workerPath,
      "--camera", cameraId,
      "--url", substreamUrl,
      "--fps", String(grantedFps),
      "--model", finalModelPath,
      ...gateArgs,
      ...appearanceArgs,
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
    // Same reasoning for timeSource: a new worker process (a restart, a
    // deploy) is a fresh clock, and a run of "arrival" from the old worker
    // must never blend with "read" from a new one that just started falling
    // back - that blend is exactly the silent failure this feature exists to
    // surface.
    cam.timeSource = { sinceStart: emptyTimeSourceCounts(), lastWindow: emptyTimeSourceCounts() };
    cam.timeSourceOpenWindow = emptyTimeSourceCounts();

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
          // Every frame line counts toward timeSource, gate on or off, and
          // regardless of whether any detection survives minConfidence below
          // - this is about whether the CLOCK the detector is trusting is
          // real, not about what it saw.
          bumpTimeSourceCounts(cam.timeSource.sinceStart, parsed.timeSource);
          bumpTimeSourceCounts(cam.timeSourceOpenWindow, parsed.timeSource);
          // CAMERA-AI-SETTINGS-SPEC.md: "outside the schedule the AI is NOT
          // WATCHING... frames for that camera are ignored: not folded, not
          // stored." Checked against THIS frame's own timestamp, not the
          // wall clock, so a replayed or catch-up frame is judged by the
          // instant it depicts. Round 1 does not stop the worker (the gate
          // above and timeSource counting just ran regardless) - only the
          // fold and the event store are skipped while closed.
          const settings = aiSettingsFor(cameraId);
          const aiSchedule = refreshAiSchedule(cam, settings, parsed.atUtc);
          const frameAtMs = Date.parse(parsed.atUtc);
          // kept/keptAppearances are built TOGETHER, index by index, so a
          // signature (contracts/detectStream.ts's own `appearances`, aligned
          // to `parsed.detections` before this filter) never drifts out of
          // step with the detection it belongs to once minConfidence drops
          // some of them - the same pairing advanceFold's own `assigned`
          // (below) then extends with a third, equally-aligned array.
          const kept = [];
          const keptAppearances = [];
          for (let i = 0; i < parsed.detections.length; i++) {
            if (parsed.detections[i].confidence < minConfidence) continue;
            kept.push(parsed.detections[i]);
            keptAppearances.push(parsed.appearances[i]);
          }
          // Manager rules' occupancy (MANAGER-RULES-SPEC.md section 2): fed
          // from this SAME frame, right beside advanceFold - "in the frame
          // handler... right where kept is formed". Only when the site's
          // managerRules switch is on; the schedule gate applies here too
          // (closed: not_watching at once, never a folded frame's worth of
          // presence/absence), independent of whether the fold below runs.
          if (managerRulesEnabled) {
            if (aiSchedule.open) {
              processOccupancyFrame(cameraId, settings, kept, frameAtMs);
            } else {
              occupancyScheduleClosed(cameraId, frameAtMs);
            }
          }
          // Appearance of the day (APPEARANCE-OF-DAY-SPEC.md): matching runs
          // whenever the switch is on and AI is watching, regardless of the
          // separate managerRules switch above - it is this build's own
          // feature, with its own switch. Learning additionally needs the
          // fold's own event ids (`step.assigned`, below), so it runs after
          // advanceFold rather than here.
          if (appearanceOfDayEnabled && aiSchedule.open) {
            processAppearanceMatches(cameraId, kept, keptAppearances, frameAtMs);
          }
          if (aiSchedule.open) {
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
            if (appearanceOfDayEnabled) {
              recordAppearanceLearning(cameraId, kept, keptAppearances, step.assigned, frameAtMs);
            }
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
            // Teach list, piece 1: kept for the whole day, not just the last
            // window in memory. Only the six fields the spec names - `share`
            // above is this service's own figure, never written to disk.
            appendGateWindow({
              cameraId,
              atUtc: lastWindow.atUtc,
              windowS: lastWindow.windowS,
              frames: lastWindow.frames,
              looked: lastWindow.looked,
              reasons: lastWindow.reasons,
            });
            // This gate line IS the boundary: it reports on exactly the
            // windowS seconds of frames that just went by, so this is where
            // timeSource's own lastWindow closes too - the two figures then
            // describe the same span, not two clocks drifting apart.
            closeTimeSourceWindow(cam);
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
      const worker = workers.get(cameraId);
      workers.delete(cameraId);
      if (stopping) return;

      // Appearance of the day: a deliberate kill from applyAppearanceSwitch,
      // not a crash - respawn AT ONCE with the new --appearance value,
      // rather than counting it as a restart and waiting out the backoff a
      // real crash would deserve (cam.restarts is left untouched).
      if (worker?.restartForSettingChange) {
        spawnWorker(assignment);
        return;
      }

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

  // Per-camera AI settings (CAMERA-AI-SETTINGS-SPEC.md): read once before the
  // first worker starts, same reasoning as known objects above - the first
  // frame is judged against real settings rather than the defaults for the
  // instant it takes this to read the file. loadAiSettingsNow never throws.
  await loadAiSettingsNow();

  // Manager rules' occupancy (MANAGER-RULES-SPEC.md section 2): read areas.json
  // and the managerRules switch once before the first worker starts, same
  // reasoning as camera AI settings above. loadOccupancyConfigNow never throws.
  await loadOccupancyConfigNow();

  // Appearance of the day (APPEARANCE-OF-DAY-SPEC.md): read site.json's
  // switch/threshold/openHours/timezone AND appearance-today.json (deleting
  // it at once if its date is already stale) before the first worker starts
  // - so a stale file from a previous run is never matched against for even
  // one frame, and the very first worker launch already knows whether to
  // pass --appearance. loadAppearanceStateNow never throws.
  await loadAppearanceStateNow();

  // Teach list, piece 1: drop this directory's own files older than 7 days
  // before the first new one can be written, same as the known-objects read
  // above - once at start, and the timer below repeats it once a day.
  // pruneGateWindows never throws, so a bad state dir cannot stop detection
  // from starting.
  await pruneGateWindows();

  // Spawn all workers
  for (const assignment of plan.assignments) {
    spawnWorker(assignment);
  }

  /**
   * Advance every camera's fold with no new detections (finishing events a
   * missed frame would otherwise leave open forever), and, when manager
   * rules' occupancy is switched on, feed this same tick's gap-tick or
   * schedule-closed evidence to every area on that camera - "feed frame-gap
   * and schedule-closed ticks from the existing 1 s tick" (this service's
   * own job description). One function so the real timer below and the
   * harness's `tick()` (returned at the bottom) can never drift apart into
   * two different answers for "what does a tick do".
   */
  function runTick() {
    const nowIso = now().toISOString();
    const nowMs = Date.parse(nowIso);
    for (const cam of cameras.values()) {
      const step = advanceFold(cam.fold, [], nowIso);
      cam.fold = step.state;
      for (const finished of step.finished) {
        storeEvent(finished, true);
      }
      if (managerRulesEnabled) {
        const aiSchedule = refreshAiSchedule(cam, aiSettingsFor(cam.cameraId), nowIso);
        if (aiSchedule.open) {
          occupancyGapTick(cam.cameraId, nowMs);
        } else {
          occupancyScheduleClosed(cam.cameraId, nowMs);
        }
      }
    }
  }

  // Tick timer: advance folds with no detections, and (when switched on)
  // manager rules' occupancy gap/schedule ticks.
  const tickTimer = setInterval(runTick, tickMs);

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

  // Per-camera AI settings: re-read camera-ai.json every aiSettingsReloadMs
  // (CAMERA-AI-SETTINGS-SPEC.md: "it re-reads camera-ai.json every 30 s").
  // loadAiSettingsNow never throws.
  const aiSettingsTimer = setInterval(() => {
    if (!stopping) loadAiSettingsNow();
  }, aiSettingsReloadMs);

  // Manager rules' occupancy: re-read areas.json and the managerRules switch
  // every occupancyReloadMs ("every 30 s", MANAGER-RULES-SPEC.md section 2).
  // loadOccupancyConfigNow never throws.
  const occupancyReloadTimer = setInterval(() => {
    if (!stopping) loadOccupancyConfigNow();
  }, occupancyReloadMs);

  // Appearance of the day: re-read site.json's switch/threshold/openHours/
  // timezone, AND re-check appearance-today.json's own date against "now" -
  // this is what actually notices local midnight (or a date that went stale
  // some other way) and wipes the file, since nothing else in this service
  // watches the clock for that purpose. loadAppearanceStateNow never throws.
  const appearanceReloadTimer = setInterval(() => {
    if (!stopping) loadAppearanceStateNow();
  }, appearanceReloadMs);

  // Teach list, piece 1: the once-a-day sweep. pruneGateWindows never throws
  // (its own failures are logged and swallowed), so nothing here needs to
  // catch it either.
  const gateRetentionTimer = setInterval(() => {
    if (!stopping) pruneGateWindows();
  }, gateRetentionCheckMs);

  // timeSource window, gate-off fallback ONLY: see timeSourceWindowMs's own
  // comment for why this does not run, and is not needed, when the gate is
  // on - that path closes the window itself, on its own "gate" line.
  const timeSourceWindowTimer = motionGate.enabled
    ? null
    : setInterval(() => {
        if (stopping) return;
        for (const cam of cameras.values()) {
          closeTimeSourceWindow(cam);
        }
      }, timeSourceWindowMs);

  function getCameras() {
    return Array.from(cameras.values()).map((cam) => ({
      cameraId: cam.cameraId,
      state: cam.state,
      grantedFps: cam.grantedFps,
      // Per-camera AI settings' schedule, refreshed against THIS instant so a
      // camera whose worker sends no frames (down, or simply quiet) still
      // reports accurately rather than freezing at whatever a frame last
      // said. { open, sinceUtc }: sinceUtc only moves on a real transition.
      aiSchedule: refreshAiSchedule(cam, aiSettingsFor(cam.cameraId), now().toISOString()),
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
      timeSource: cam.timeSource,
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
    const nowIsoForHealth = now().toISOString();
    const health = {
      atUtc: nowIsoForHealth,
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
      // Appearance of the day's own status (GET /appearance/status,
      // agent/api-server.mjs — a SEPARATE process that has no other way to
      // see this process's in-memory learning progress): NEVER the
      // signature itself, only whether it is learned and why, learnedAtUtc,
      // a sample count, and whether a second manager exists.
      appearance: appearanceStatusForHealth(Date.parse(nowIsoForHealth)),
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
    clearInterval(aiSettingsTimer);
    clearInterval(occupancyReloadTimer);
    clearInterval(appearanceReloadTimer);
    clearInterval(gateRetentionTimer);
    if (timeSourceWindowTimer) clearInterval(timeSourceWindowTimer);

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
    if (occupancyDb !== null) occupancyDb.close();
  }

  return {
    stop,
    cameras: getCameras,
    // For a harness, as knownPass/knownFlush are: run what the real tick
    // timer runs (fold advance, and manager rules' gap/schedule ticks), now.
    tick: () => runTick(),
    writeHealth,
    // For a harness, as tick is: run what the timers run, now.
    knownPass: () => syncKnown({ learn: true }),
    knownFlush: () => syncKnown({ learn: false }),
    // For a harness, as knownPass/knownFlush are: run the once-a-day sweep now.
    pruneGateWindows: () => pruneGateWindows(),
    // For a harness, as knownPass/knownFlush are: re-read camera-ai.json now,
    // rather than waiting aiSettingsReloadMs.
    reloadAiSettings: () => loadAiSettingsNow(),
    // For a harness, as reloadAiSettings is: re-read areas.json and the
    // managerRules switch now, rather than waiting occupancyReloadMs.
    reloadOccupancyConfig: () => loadOccupancyConfigNow(),
    // For a harness, as reloadOccupancyConfig is: re-read site.json's
    // appearance-of-day settings AND re-check appearance-today.json's own
    // date now, rather than waiting appearanceReloadMs - this is also how a
    // harness proves the local-midnight (or stale-date) wipe without a real
    // wait.
    reloadAppearanceConfig: () => loadAppearanceStateNow(),
    // For a harness: today's learned signature(s), or null - read-only, and
    // never handed to anything outside this process. NEVER exposed over
    // HTTP; GET /appearance/status (agent/api-server.mjs) reports only
    // whether it is learned and why, never this value itself.
    appearanceToday: () => appearanceTodayFile,
    // For a harness, as tick/pruneGateWindows are: close every camera's
    // timeSource window now, exactly as the gate-off timer would, without a
    // real wait. Exposed unconditionally - closing a window by hand is always
    // meaningful, even with the gate on (that path just also gets its own
    // close from each "gate" line).
    closeTimeSourceWindows: () => {
      for (const cam of cameras.values()) {
        closeTimeSourceWindow(cam);
      }
    },
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
