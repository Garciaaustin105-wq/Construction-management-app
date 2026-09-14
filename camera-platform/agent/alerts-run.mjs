/**
 * The alerts check: `camctl alerts`, run by a systemd timer as its own process
 * (a wedged recorder cannot report its own wedge). Reads health.json and the
 * previous alerts.json, runs contracts/alerts.ts, writes alerts.json.
 *
 * THE FEARED FAILURES: a half-written or corrupt file crashing the check, so
 * alerts silently stop updating; one bad record in alerts.json throwing away
 * every raised alert; the recorder restarted every minute while it stays stale.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { evaluateAlerts } from "../dist/alerts.js";

const STATES = ["raised", "clear", "unknown"];

/** Written by the alerts check, acted on by camplat-recorder-restart.path (root). */
export const RESTART_REQUEST = "restart-recorder.request";

/**
 * health.json as the alerts contract wants it.
 * - The file is missing (err.code "ENOENT"): null.
 * - It reads and JSON.parse succeeds: the parsed value, whatever it is.
 * - Any other failure (unreadable, not JSON): { unreadable: err.message }.
 * Never throws.
 */
export async function readHealth(file) {
  try {
    const txt = await readFile(file, "utf8");
    try {
      return JSON.parse(txt);
    } catch (err) {
      return { unreadable: err.message };
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    return { unreadable: err.message };
  }
}

/**
 * True only when r is a non-null, non-array object where key, id, subject,
 * since and value are strings, state is one of STATES, and badStreak and
 * goodStreak are integers >= 0 (Number.isInteger).
 */
export function isAlertRecord(r) {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
  const requiredStringProps = ["key", "id", "subject", "since", "value"];
  for (const prop of requiredStringProps) {
    if (!Object.prototype.hasOwnProperty.call(r, prop) || typeof r[prop] !== "string") {
      return false;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(r, "state") || typeof r.state !== "string" || !STATES.includes(r.state)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(r, "badStreak") || !Object.prototype.hasOwnProperty.call(r, "goodStreak")) {
    return false;
  }
  if (typeof r.badStreak !== "number" || typeof r.goodStreak !== "number" || !Number.isInteger(r.badStreak) || !Number.isInteger(r.goodStreak) || r.badStreak < 0 || r.goodStreak < 0) {
    return false;
  }
  return true;
}

/**
 * The previous alerts, keeping every valid record. Returns { records, discarded },
 * discarded being a list of reasons (strings). Never throws.
 * - The file is missing (err.code "ENOENT"): { records: [], discarded: [] }.
 * - Any other read failure: records [], discarded ["alerts.json could not be read: " + err.message].
 * - JSON.parse fails: records [], discarded ["alerts.json is not JSON: " + err.message].
 * - The parsed value is not a non-null object with an array `alerts`:
 *   records [], discarded ["alerts.json has no alerts list"].
 * - Otherwise records = the entries passing isAlertRecord, in order, and for each
 *   entry that fails, discarded gets "alerts.json entry " + i + " is not an alert record"
 *   (i its index in the array).
 */
export async function readPreviousAlerts(file) {
  const discarded = [];
  const records = [];
  let txt;
  try {
    txt = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { records: [], discarded: [] };
    }
    discarded.push("alerts.json could not be read: " + err.message);
    return { records: [], discarded };
  }
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch (err) {
    discarded.push("alerts.json is not JSON: " + err.message);
    return { records: [], discarded };
  }
  if (!(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Array.isArray(parsed.alerts))) {
    discarded.push("alerts.json has no alerts list");
    return { records: [], discarded };
  }
  const alertsArray = parsed.alerts;
  for (let i = 0; i < alertsArray.length; i++) {
    const entry = alertsArray[i];
    if (isAlertRecord(entry)) {
      records.push(entry);
    } else {
      discarded.push(`alerts.json entry ${i} is not an alert record`);
    }
  }
  return { records, discarded };
}

/**
 * One check. checkedUtc = now().toISOString().
 * health = await readHealth(path.join(stateDir, "health.json"));
 * previous = await readPreviousAlerts(path.join(stateDir, "alerts.json"));
 * { alerts, transitions } = evaluateAlerts(health, previous.records, checkedUtc, thresholds).
 * Writes JSON.stringify({ checkedUtc, alerts }, null, 2) to alerts.json + ".tmp", then renames
 * it over alerts.json (a reader never sees half a file). Write errors propagate.
 * Returns { checkedUtc, alerts, transitions, discarded: previous.discarded }.
 */
export async function runAlertsCheck({ stateDir, thresholds, now = () => new Date() }) {
  const checkedUtc = now().toISOString();
  const health = await readHealth(path.join(stateDir, "health.json"));
  const previous = await readPreviousAlerts(path.join(stateDir, "alerts.json"));
  const { alerts, transitions } = evaluateAlerts(health, previous.records, checkedUtc, thresholds);
  const tempPath = path.join(stateDir, "alerts.json.tmp");
  const finalPath = path.join(stateDir, "alerts.json");
  await writeFile(tempPath, JSON.stringify({ checkedUtc, alerts }, null, 2), "utf8");
  await rename(tempPath, finalPath);
  return { checkedUtc, alerts, transitions, discarded: previous.discarded };
}

/**
 * Option A of the watchdog (HEALTH-ALERTS-DESIGN.md): restart only on the
 * transition INTO raised for recorder_stale. True when some transition has
 * id "recorder_stale" and to "raised". An alert that stays raised has no
 * transition, so a restart that does not help is not repeated every minute.
 */
export function shouldRestartRecorder(transitions) {
  if (!Array.isArray(transitions)) return false;
  for (const t of transitions) {
    if (typeof t === "object" && t !== null) {
      if (Object.prototype.hasOwnProperty.call(t, "id") && t.id === "recorder_stale" &&
          Object.prototype.hasOwnProperty.call(t, "to") && t.to === "raised") {
        return true;
      }
    }
  }
  return false;
}

/**
 * One journal line for a transition: JSON.stringify of
 * { level, msg: "alert " + t.to, key: t.key, from: t.from, to: t.to, value: t.value, atUtc: t.atUtc },
 * level "warn" when t.to is "raised" or "unknown", else "info".
 */
export function transitionLogLine(t) {
  const level = t.to === "raised" || t.to === "unknown" ? "warn" : "info";
  return JSON.stringify({ level, msg: "alert " + t.to, key: t.key, from: t.from, to: t.to, value: t.value, atUtc: t.atUtc });
}

export { STATES };
