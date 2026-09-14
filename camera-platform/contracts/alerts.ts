/**
 * Health alerts: what health.json says is wrong, as measurements with
 * thresholds. Pure: no clock, no files. `camctl alerts` reads health.json and
 * the previous alerts.json, calls evaluateAlerts, and writes the result. See
 * HEALTH-ALERTS-DESIGN.md.
 *
 * THE FEARED FAILURES: a missing measurement shown as fine; one slow check
 * raising an incident; a reboot raising every camera; a clock jump raising
 * everything; a raised alert logged again every minute; alerts silently
 * forgotten because the recorder stopped reporting.
 */

export type AlertId =
  | "clock_suspect"
  | "recorder_stale"
  | "retention_unknown"
  | "camera_not_recording"
  | "disk_missing"
  | "disk_filling"
  | "quarantine_large";

/** "bad": the threshold is crossed. "unknown": it could not be measured. */
export type Condition = "bad" | "ok" | "unknown";
export type AlertState = "raised" | "clear" | "unknown";

/** What the recorder writes to health.json (the fields alerts read). */
export interface HealthSnapshot {
  atUtc: string;
  /** When this recorder process started. */
  startedUtc: string;
  cameraIds: string[];
  storeRoots: string[];
  /** Store roots refused at start. */
  refusedRoots: string[];
  disks: { root: string; total?: unknown; used?: unknown; quarantine?: unknown }[];
  /** cameraId -> box-clock time of its last sealed segment, null when none since start. */
  lastSealedUtc: Record<string, string | null>;
  retentionRefused: string | null;
}

export interface AlertThresholds {
  staleAfterMs: number;
  cameraSilentAfterMs: number;
  /** used / total above this is disk_filling (eviction aims for 0.85). */
  diskFullFraction: number;
  quarantineLimitBytes: number;
  clockAheadToleranceMs: number;
  raiseAfterChecks: number;
  clearAfterChecks: number;
}

/** One measurement. key is `${id}:${subject}`; subject is "recorder", a cameraId or a store root. */
export interface Observation {
  key: string;
  id: AlertId;
  subject: string;
  condition: Condition;
  /** What was measured, with its unit, for a person. */
  value: string;
}

export interface AlertRecord {
  key: string;
  id: AlertId;
  subject: string;
  state: AlertState;
  /** When state last changed. */
  since: string;
  badStreak: number;
  goodStreak: number;
  value: string;
}

export interface AlertTransition {
  key: string;
  id: AlertId;
  subject: string;
  from: AlertState;
  to: AlertState;
  atUtc: string;
  value: string;
}

/** A box clock earlier than this is wrong: this software did not exist yet. */
export const CLOCK_FLOOR_UTC = "2026-01-01T00:00:00.000Z";

/**
 * Starting values, not truths: none has field data behind it yet.
 * { staleAfterMs: 90_000, cameraSilentAfterMs: Math.max(3 * segmentSeconds * 1000, 300_000),
 *   diskFullFraction: 0.92, quarantineLimitBytes: 1_000_000_000, clockAheadToleranceMs: 60_000,
 *   raiseAfterChecks: 2, clearAfterChecks: 2 }
 */
export function defaultThresholds(segmentSeconds: number): AlertThresholds {
  return { staleAfterMs: 90_000, cameraSilentAfterMs: Math.max(3 * segmentSeconds * 1000, 300_000), diskFullFraction: 0.92, quarantineLimitBytes: 1_000_000_000, clockAheadToleranceMs: 60_000, raiseAfterChecks: 2, clearAfterChecks: 2 };
}

/**
 * True only when h can be judged at all. ALL of:
 * - h is an object, not null, not an array;
 * - atUtc and startedUtc are strings that Date.parse to a number (not NaN);
 * - cameraIds, storeRoots and refusedRoots are arrays whose every element is a string;
 * - disks is an array whose every element is a non-null, non-array object with a string root;
 * - lastSealedUtc is a non-null, non-array object;
 * - retentionRefused is a string or null.
 */
export function isReadableHealth(h: unknown): h is HealthSnapshot {
  if (typeof h !== "object" || h === null) return false;
  if (Array.isArray(h)) return false;
  const o = h as Record<string, unknown>;
  const atUtc = o.atUtc;
  if (typeof atUtc !== "string" || Number.isNaN(Date.parse(atUtc))) return false;
  const startedUtc = o.startedUtc;
  if (typeof startedUtc !== "string" || Number.isNaN(Date.parse(startedUtc))) return false;
  const cameraIds = o.cameraIds;
  if (!Array.isArray(cameraIds) || !cameraIds.every((x) => typeof x === "string")) return false;
  const storeRoots = o.storeRoots;
  if (!Array.isArray(storeRoots) || !storeRoots.every((x) => typeof x === "string")) return false;
  const refusedRoots = o.refusedRoots;
  if (!Array.isArray(refusedRoots) || !refusedRoots.every((x) => typeof x === "string")) return false;
  const disks = o.disks;
  if (!Array.isArray(disks)) return false;
  for (const d of disks) {
    if (typeof d !== "object" || d === null || Array.isArray(d)) return false;
    const doo = d as Record<string, unknown>;
    const root = doo.root;
    if (typeof root !== "string") return false;
  }
  const lastSealedUtc = o.lastSealedUtc;
  if (typeof lastSealedUtc !== "object" || lastSealedUtc === null || Array.isArray(lastSealedUtc)) return false;
  const retentionRefused = o.retentionRefused;
  if (retentionRefused !== null && typeof retentionRefused !== "string") return false;
  return true;
}

const secondsText = (ms: number): string => `${Math.round(ms / 1000)} s`;

/**
 * One camera_not_recording observation per h.cameraIds entry, in that order.
 * subject = the cameraId, key = "camera_not_recording:" + cameraId.
 * - last = h.lastSealedUtc[cameraId]; lastMs = Date.parse(last) when last is a string, else NaN.
 * - If lastMs is finite and nowMs - lastMs <= th.cameraSilentAfterMs: "ok",
 *   value secondsText(nowMs - lastMs) + " since the last sealed segment".
 * - Else sinceStartMs = nowMs - Date.parse(h.startedUtc). If sinceStartMs <= th.cameraSilentAfterMs:
 *   "unknown", value "recorder started " + secondsText(sinceStartMs) + " ago".
 *   (A camera cannot be judged silent before it has had the whole silent window.)
 * - Else "bad", value: when lastMs is finite, secondsText(nowMs - lastMs) + " since the last sealed segment";
 *   else "no segment sealed in the " + secondsText(sinceStartMs) + " since the recorder started".
 */
export function cameraObservations(h: HealthSnapshot, nowMs: number, th: AlertThresholds): Observation[] {
  const observations: Observation[] = [];
  for (const cameraId of h.cameraIds) {
    const key = `camera_not_recording:${cameraId}`;
    const subject = cameraId;
    const last = h.lastSealedUtc[cameraId];
    const lastMs = typeof last === "string" ? Date.parse(last) : NaN;
    let condition: Condition;
    let value: string;
    if (Number.isFinite(lastMs) && nowMs - lastMs <= th.cameraSilentAfterMs) {
      condition = "ok";
      value = `${secondsText(nowMs - lastMs)} since the last sealed segment`;
    } else {
      const sinceStartMs = nowMs - Date.parse(h.startedUtc);
      if (sinceStartMs <= th.cameraSilentAfterMs) {
        condition = "unknown";
        value = `recorder started ${secondsText(sinceStartMs)} ago`;
      } else {
        condition = "bad";
        if (Number.isFinite(lastMs)) {
          value = `${secondsText(nowMs - lastMs)} since the last sealed segment`;
        } else {
          value = `no segment sealed in the ${secondsText(sinceStartMs)} since the recorder started`;
        }
      }
    }
    observations.push({ key, id: "camera_not_recording", subject, condition, value });
  }
  return observations;
}

/**
 * For each root of h.storeRoots, in order, three observations in this order
 * (subject = root, key = id + ":" + root). disk = h.disks.find((d) => d.root === root).
 * 1. disk_missing: h.refusedRoots includes root -> "bad", "refused at start";
 *    else no disk -> "bad", "not measured: the drive did not answer"; else "ok", "mounted".
 * 2. disk_filling: when disk exists and disk.total is a finite number > 0 and disk.used is a
 *    finite number >= 0: frac = used / total, value (frac * 100).toFixed(1) + "% used",
 *    "bad" when frac > th.diskFullFraction else "ok". Otherwise "unknown", "not measured".
 * 3. quarantine_large: when disk exists and disk.quarantine is a non-null object whose bytes is a
 *    finite number >= 0: value (bytes / 1e6).toFixed(1) + " MB in quarantine",
 *    "bad" when bytes > th.quarantineLimitBytes else "ok". Otherwise "unknown", "not measured".
 */
export function diskObservations(h: HealthSnapshot, th: AlertThresholds): Observation[] {
  const observations: Observation[] = [];
  for (const root of h.storeRoots) {
    const disk = h.disks.find((d) => d.root === root);
    // disk_missing
    const keyMissing = `disk_missing:${root}`;
    let conditionMissing: Condition;
    let valueMissing: string;
    if (h.refusedRoots.includes(root)) {
      conditionMissing = "bad";
      valueMissing = "refused at start";
    } else if (!disk) {
      conditionMissing = "bad";
      valueMissing = "not measured: the drive did not answer";
    } else {
      conditionMissing = "ok";
      valueMissing = "mounted";
    }
    observations.push({ key: keyMissing, id: "disk_missing", subject: root, condition: conditionMissing, value: valueMissing });
    // disk_filling
    const keyFilling = `disk_filling:${root}`;
    let conditionFilling: Condition;
    let valueFilling: string;
    if (disk && typeof disk.total === "number" && Number.isFinite(disk.total) && disk.total > 0 &&
        typeof disk.used === "number" && Number.isFinite(disk.used) && disk.used >= 0) {
      const frac = disk.used / disk.total;
      conditionFilling = frac > th.diskFullFraction ? "bad" : "ok";
      valueFilling = `${(frac * 100).toFixed(1)}% used`;
    } else {
      conditionFilling = "unknown";
      valueFilling = "not measured";
    }
    observations.push({ key: keyFilling, id: "disk_filling", subject: root, condition: conditionFilling, value: valueFilling });
    // quarantine_large
    const keyQuarantine = `quarantine_large:${root}`;
    let conditionQuarantine: Condition;
    let valueQuarantine: string;
    const q = disk?.quarantine;
    const bytes = typeof q === "object" && q !== null && "bytes" in q ? q.bytes : undefined;
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
      conditionQuarantine = bytes > th.quarantineLimitBytes ? "bad" : "ok";
      valueQuarantine = `${(bytes / 1e6).toFixed(1)} MB in quarantine`;
    } else {
      conditionQuarantine = "unknown";
      valueQuarantine = "not measured";
    }
    observations.push({ key: keyQuarantine, id: "quarantine_large", subject: root, condition: conditionQuarantine, value: valueQuarantine });
  }
  return observations;
}

/**
 * Every observation for this check. nowMs = Date.parse(nowUtc); readable = isReadableHealth(health).
 * 1. clock_suspect:recorder (subject "recorder"):
 *    nowMs < Date.parse(CLOCK_FLOOR_UTC) -> "bad", "the box clock reads " + nowUtc;
 *    else readable and Date.parse(health.atUtc) > nowMs + th.clockAheadToleranceMs ->
 *    "bad", "the last health report is " + secondsText(atMs - nowMs) + " in the future";
 *    else "ok", "the box clock is plausible".
 * 2. recorder_stale:recorder: clock bad -> "unknown", "the box clock is suspect";
 *    else health === null or undefined -> "unknown", "no health report";
 *    else !readable -> "unknown", "the health report is unreadable";
 *    else age = nowMs - atMs: "bad" when age > th.staleAfterMs else "ok",
 *    value secondsText(age) + " since the last health report".
 * 3. If recorder_stale is not "ok": return [clock, stale] followed by, for every key of
 *    previousKeys other than those two keys, in order, an "unknown" observation with
 *    value "no current health report" (id = the key before its FIRST ":", subject = the
 *    rest). Stale data judges nothing, and nothing already raised is forgotten.
 * 4. Otherwise return [clock, stale, retention, ...cameraObservations(health, nowMs, th),
 *    ...diskObservations(health, th)], where retention is retention_unknown:recorder:
 *    "bad" with value health.retentionRefused when that is a string, else "ok", "retention computed".
 */
export function observe(health: unknown, previousKeys: readonly string[], nowUtc: string, th: AlertThresholds): Observation[] {
  const nowMs = Date.parse(nowUtc);
  const readable = isReadableHealth(health);
  const observations: Observation[] = [];

  // clock
  let clockCondition: Condition;
  let clockValue: string;
  if (nowMs < Date.parse(CLOCK_FLOOR_UTC)) {
    clockCondition = "bad";
    clockValue = "the box clock reads " + nowUtc;
  } else if (readable && Date.parse(health.atUtc) > nowMs + th.clockAheadToleranceMs) {
    clockCondition = "bad";
    clockValue = "the last health report is " + secondsText(Date.parse(health.atUtc) - nowMs) + " in the future";
  } else {
    clockCondition = "ok";
    clockValue = "the box clock is plausible";
  }
  observations.push({ key: "clock_suspect:recorder", id: "clock_suspect", subject: "recorder", condition: clockCondition, value: clockValue });

  // recorder_stale
  let staleCondition: Condition;
  let staleValue: string;
  if (clockCondition === "bad") {
    staleCondition = "unknown";
    staleValue = "the box clock is suspect";
  } else if (health === null || health === undefined) {
    staleCondition = "unknown";
    staleValue = "no health report";
  } else if (!readable) {
    staleCondition = "unknown";
    staleValue = "the health report is unreadable";
  } else {
    const atMs = Date.parse(health.atUtc);
    const ageMs = nowMs - atMs;
    if (ageMs > th.staleAfterMs) {
      staleCondition = "bad";
    } else {
      staleCondition = "ok";
    }
    staleValue = secondsText(ageMs) + " since the last health report";
  }
  observations.push({ key: "recorder_stale:recorder", id: "recorder_stale", subject: "recorder", condition: staleCondition, value: staleValue });

  if (staleCondition !== "ok") {
    for (const key of previousKeys) {
      if (key === "clock_suspect:recorder" || key === "recorder_stale:recorder") continue;
      const colonIdx = key.indexOf(":");
      const idPart = key.slice(0, colonIdx) as AlertId;
      const subjectPart = key.slice(colonIdx + 1);
      observations.push({ key, id: idPart, subject: subjectPart, condition: "unknown", value: "no current health report" });
    }
    return observations;
  }

  let retentionCondition: Condition;
  let retentionValue: string;
  if (readable && typeof health.retentionRefused === "string") {
    retentionCondition = "bad";
    retentionValue = health.retentionRefused;
  } else {
    retentionCondition = "ok";
    retentionValue = "retention computed";
  }
  observations.push({ key: "retention_unknown:recorder", id: "retention_unknown", subject: "recorder", condition: retentionCondition, value: retentionValue });

  observations.push(...cameraObservations(health as HealthSnapshot, nowMs, th));
  observations.push(...diskObservations(health as HealthSnapshot, th));

  return observations;
}

/**
 * One alert's next record. prev null means never seen: treat it as
 * { state: "unknown", since: nowUtc, badStreak: 0, goodStreak: 0 }.
 * - obs "unknown": badStreak 0, goodStreak 0, state "unknown".
 * - obs "bad": badStreak = prev.badStreak + 1, goodStreak 0; state "raised" when prev.state is
 *   "raised" or badStreak >= th.raiseAfterChecks, else prev.state.
 * - obs "ok": goodStreak = prev.goodStreak + 1, badStreak 0; when prev.state is "raised":
 *   "clear" once goodStreak >= th.clearAfterChecks, else still "raised"; otherwise "clear".
 * - since = nowUtc when state differs from prev.state, else prev.since.
 * - key, id, subject and value come from obs.
 * transition: only when the state changed AND (prev.state or the new state) is "raised":
 * { key, id, subject, from: prev.state, to: state, atUtc: nowUtc, value }. Otherwise null.
 */
export function stepAlert(
  prev: AlertRecord | null,
  obs: Observation,
  nowUtc: string,
  th: AlertThresholds,
): { record: AlertRecord; transition: AlertTransition | null } {
  const prevState: AlertState = prev?.state ?? "unknown";
  const prevBad = prev?.badStreak ?? 0;
  const prevGood = prev?.goodStreak ?? 0;
  const prevSince = prev?.since ?? nowUtc;
  let state: AlertState;
  let badStreak: number;
  let goodStreak: number;
  switch (obs.condition) {
    case "unknown":
      badStreak = 0;
      goodStreak = 0;
      state = "unknown";
      break;
    case "bad":
      badStreak = prevBad + 1;
      goodStreak = 0;
      if (prevState === "raised" || badStreak >= th.raiseAfterChecks) {
        state = "raised";
      } else {
        state = prevState;
      }
      break;
    case "ok":
      badStreak = 0;
      goodStreak = prevGood + 1;
      if (prevState === "raised") {
        state = goodStreak >= th.clearAfterChecks ? "clear" : "raised";
      } else {
        state = "clear";
      }
      break;
    default:
      state = "unknown";
      badStreak = 0;
      goodStreak = 0;
  }
  const since = state !== prevState ? nowUtc : prevSince;
  const record: AlertRecord = {
    key: obs.key,
    id: obs.id,
    subject: obs.subject,
    state,
    since,
    badStreak,
    goodStreak,
    value: obs.value,
  };
  let transition: AlertTransition | null = null;
  if (state !== prevState && (prevState === "raised" || state === "raised")) {
    transition = {
      key: obs.key,
      id: obs.id,
      subject: obs.subject,
      from: prevState,
      to: state,
      atUtc: nowUtc,
      value: obs.value,
    };
  }
  return { record, transition };
}

/**
 * The whole check. observations = observe(health, previous.map((r) => r.key), nowUtc, th).
 * Each observation is stepped against the previous record with the same key (or null).
 * A previous record with no observation is dropped (its camera or root left the config).
 * alerts are sorted by key (plain < comparison); transitions keep observation order.
 */
export function evaluateAlerts(
  health: unknown,
  previous: readonly AlertRecord[],
  nowUtc: string,
  th: AlertThresholds,
): { alerts: AlertRecord[]; transitions: AlertTransition[] } {
  const observations = observe(health, previous.map((r) => r.key), nowUtc, th);
  const prevMap = new Map<string, AlertRecord>();
  for (const r of previous) {
    prevMap.set(r.key, r);
  }
  const alertsMap = new Map<string, AlertRecord>();
  const transitions: AlertTransition[] = [];
  for (const obs of observations) {
    const prev = prevMap.get(obs.key) ?? null;
    const { record, transition } = stepAlert(prev, obs, nowUtc, th);
    alertsMap.set(obs.key, record);
    if (transition) {
      transitions.push(transition);
    }
  }
  const alerts = Array.from(alertsMap.values()).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );
  return { alerts, transitions };
}
