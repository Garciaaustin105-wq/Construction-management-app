/**
 * NVR-wide AI settings: the plate-reading switch and how long plate reads live.
 * AI-PLAN.md. Pure: the caller passes the time and writes the audit line.
 *
 * Plates are personal data, and some states restrict plate readers. So:
 * - there is ONE switch for the whole NVR, not one per camera, and it starts OFF;
 * - off means no new plate read is stored, from the moment it is off;
 * - reads already stored keep their own retention whether the switch is on or
 *   off (turning it off is not a way to keep them forever, nor to wipe them);
 * - every change of the switch produces an audit entry naming who did it.
 *
 * THE FEARED FAILURES: a plate stored while the switch is off; a switch flip
 * with no audit line; a stored read that never expires.
 */

import { parseUtc } from "./time.js";
import type { Detection } from "./detection.js";

export interface AiSettings {
  platesEnabled: boolean;
  /** Whole days a plate read is kept, 1..365. */
  plateRetentionDays: number;
}

export const DEFAULT_AI_SETTINGS: Readonly<AiSettings> = Object.freeze({
  platesEnabled: false,
  plateRetentionDays: 30,
});

export const MAX_PLATE_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

export type SettingsCheck = { ok: true; settings: AiSettings } | { ok: false; reason: string };

export interface PlateSwitchAudit {
  event: "plates_enabled" | "plates_disabled";
  actor: string;
  atUtc: string;
}

export type PlateSwitchResult =
  | { ok: true; changed: true; settings: AiSettings; audit: PlateSwitchAudit }
  | { ok: true; changed: false; settings: AiSettings }
  | { ok: false; reason: "bad_actor" | "bad_time" | "bad_enabled" };

export type PlateAdmission = { store: true } | { store: false; reason: "plates_off" };

/**
 * Validate settings read from disk or sent by the installer page.
 *
 * 1. `raw` must be a non-null, non-array object: else "not_an_object".
 * 2. platesEnabled must be a boolean: else "bad_plates_enabled".
 * 3. plateRetentionDays must be an integer, 1..MAX_PLATE_RETENTION_DAYS:
 *    else "bad_retention".
 * 4. Return { ok: true, settings } with a NEW object holding exactly
 *    { platesEnabled, plateRetentionDays } in that key order (extra keys dropped).
 */
export function checkAiSettings(raw: unknown): SettingsCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not_an_object" };
  }
  const obj = raw as Record<string, unknown>;
  const platesEnabled = obj.platesEnabled;
  if (typeof platesEnabled !== "boolean") {
    return { ok: false, reason: "bad_plates_enabled" };
  }
  const days = obj.plateRetentionDays;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_PLATE_RETENTION_DAYS
  ) {
    return { ok: false, reason: "bad_retention" };
  }
  return { ok: true, settings: { platesEnabled, plateRetentionDays: days } };
}

/**
 * Flip the plate switch. The caller must already have checked the permission
 * (installer only); this decides the new state and the audit entry.
 *
 * 1. `enabled` must be a boolean: else { ok: false, reason: "bad_enabled" }.
 * 2. `actor` must be a non-empty string: else "bad_actor".
 * 3. `atUtc` must be accepted by parseUtc (catch its throw): else "bad_time".
 * 4. If enabled === current.platesEnabled: { ok: true, changed: false,
 *    settings: a copy of current } (no audit entry for a no-op).
 * 5. Else { ok: true, changed: true, settings: a NEW object
 *    { platesEnabled: enabled, plateRetentionDays: current.plateRetentionDays },
 *    audit: { event: enabled ? "plates_enabled" : "plates_disabled", actor, atUtc } }.
 * Never mutate `current`.
 */
export function setPlateReading(current: AiSettings, enabled: unknown, actor: unknown, atUtc: unknown): PlateSwitchResult {
  if (typeof enabled !== "boolean") {
    return { ok: false, reason: "bad_enabled" };
  }
  if (typeof actor !== "string" || actor === "") {
    return { ok: false, reason: "bad_actor" };
  }
  if (typeof atUtc !== "string") {
    return { ok: false, reason: "bad_time" };
  }
  try {
    parseUtc(atUtc);
  } catch {
    return { ok: false, reason: "bad_time" };
  }
  if (enabled === current.platesEnabled) {
    return { ok: true, changed: false, settings: { ...current } };
  }
  return {
    ok: true,
    changed: true,
    settings: { platesEnabled: enabled, plateRetentionDays: current.plateRetentionDays },
    audit: { event: enabled ? "plates_enabled" : "plates_disabled", actor, atUtc },
  };
}

/**
 * Whether the detector may store this detection.
 *
 * 1. If detection.kind === "plate" and settings.platesEnabled is not exactly
 *    true: { store: false, reason: "plates_off" }.
 * 2. Otherwise { store: true } (people and vehicles do not depend on the switch).
 */
export function admitDetection(settings: AiSettings, detection: Detection): PlateAdmission {
  if (detection.kind === "plate" && settings.platesEnabled !== true) {
    return { store: false, reason: "plates_off" };
  }
  return { store: true };
}

/**
 * Whether a stored plate read has passed its retention. The switch does not
 * matter here: reads stored while it was on expire on schedule after it is off.
 *
 * 1. age = parseUtc(nowUtc) - parseUtc(readUtc).
 * 2. Return age >= settings.plateRetentionDays * DAY_MS.
 */
export function plateReadExpired(settings: AiSettings, readUtc: string, nowUtc: string): boolean {
  const age = parseUtc(nowUtc) - parseUtc(readUtc);
  return age >= settings.plateRetentionDays * DAY_MS;
}
