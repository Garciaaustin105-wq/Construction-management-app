/**
 * The fleet list: per-device online/late/offline status and a redacted
 * health summary, for a cloud dashboard listing every claimed box
 * (CLOUD-B1-SPEC.md section 7; cloud/CLOUD-SLICE1-SPEC.md section 3). Pure:
 * no fs, no clock of its own, no network. Imports `CheckinPayload` from the
 * box's own `../../contracts/deviceCheckin.ts` so this file's idea of
 * "health" can never drift from what a check-in actually carries.
 *
 * See cloud/CLOUD-SLICE1-SPEC.md section 3 for the full
 * contract each one must satisfy, and cloud/harness/fleet.harness.mjs for
 * the checks it must pass.
 *
 * KNOWN SPEC/CONTRACT GAP -- flagged, not guessed around (build rule 10):
 * cloud/CLOUD-SLICE1-SPEC.md section 3 describes `drives.problems` as
 * "a drive with `ok === false` or a non-null `problem` field, whatever
 * deviceCheckin's CheckinDriveFact carries". As of this writing,
 * `CheckinDriveFact` (../../contracts/deviceCheckin.ts) carries only
 * `index` and `fillFraction` -- no `ok` and no `problem` field exists to
 * read. `FleetHealthSummary["drives"]["problems"]` is typed below to match
 * the spec's *shape*, but until CheckinDriveFact actually grows such a
 * field, no implementation of `summarizeHealth` can honestly produce a
 * non-empty `problems` array from real data. Whoever implements this file
 * should report that gap rather than inventing a field name on
 * CheckinDriveFact to read.
 */

import type { CheckinPayload } from "../../contracts/deviceCheckin.js";

/** A device's reachability, purely a function of how long ago its last
 *  accepted check-in was relative to its expected interval. */
export type FleetStatus = "never" | "online" | "late" | "offline";

/**
 * Classify a device's reachability from the age of its last accepted
 * check-in. Pure and total; never throws.
 *
 * Contract:
 * - `"never"` when `lastAcceptedMs` is `null` -- the device has never had an
 *   accepted check-in (a blank is not a zero: this is NOT the same as
 *   `"offline"`, build rule 5).
 * - Otherwise `age = nowMs - lastAcceptedMs`:
 *   - `"online"` when `age <= 2.5 * intervalMs`;
 *   - `"late"` when `2.5 * intervalMs < age <= 10 * intervalMs`;
 *   - `"offline"` when `age > 10 * intervalMs`.
 * - Both boundaries (`2.5x` and `10x`) are inclusive to the more-online
 *   side: exactly `2.5 * intervalMs` is `"online"`, exactly
 *   `10 * intervalMs` is `"late"`.
 * - A negative `age` (the check-in's timestamp is in the future relative to
 *   `nowMs`) counts as `"online"`, not an error.
 */
export function fleetStatus(lastAcceptedMs: number | null, nowMs: number, intervalMs: number): FleetStatus {
  if (lastAcceptedMs === null) return "never";
  const age = nowMs - lastAcceptedMs;
  if (age <= 2.5 * intervalMs) return "online";
  if (age <= 10 * intervalMs) return "late";
  return "offline";
}

/** The measurements-only view of a check-in's health block, redacted for a
 *  fleet dashboard. See the file-level comment above for the one field
 *  (`drives.problems`) this cannot yet fill from real data. */
export interface FleetHealthSummary {
  version: string | null;
  uptimeSec: number;
  cameras: {
    total: number;
    recording: number;
    /** cameraIds whose `lastSealedUtc` is null, or older than 10 minutes
     *  before `nowMs`. */
    silent: string[];
    /** cameraIds whose `lastSealedUtc` is null. A subset of `silent`. */
    neverRecorded: string[];
  };
  drives: {
    total: number;
    /** See the file-level "KNOWN SPEC/CONTRACT GAP" comment above. */
    problems: Array<{ label: string; reason: string | null }>;
  };
  /** Passed through from `health.footageHeld.hours`. Never coerced to `0`
   *  when null (a blank is not a zero, build rule 5). */
  footageHeldHours: number | null;
  lastSealedUtc: string | null;
}

/**
 * Reduce one check-in's full health block down to the measurements a fleet
 * dashboard shows -- never anything that could identify a specific camera
 * beyond its opaque `cameraId`, and never a raw path or address. Pure and
 * total; never throws.
 *
 * Contract:
 * - `cameras.total` is `health.cameras.length`; `cameras.recording` counts
 *   entries (from `CheckinCameraFact`) with `recording === true`.
 * - `cameras.silent` lists `cameraId` for every camera whose
 *   `lastSealedUtc` is `null`, or whose `lastSealedUtc` is more than 10
 *   minutes (600000 ms) before `nowMs`.
 * - `cameras.neverRecorded` lists `cameraId` for every camera whose
 *   `lastSealedUtc` is `null`. Every `neverRecorded` id is therefore also
 *   in `silent`.
 * - `drives.total` is `health.drives.length` (from `CheckinDriveFact`).
 *   `drives.problems` -- see the file-level comment; today it is always
 *   `[]`.
 * - `footageHeldHours` is `health.footageHeld.hours`, passed through
 *   unchanged (including `null`).
 * - `lastSealedUtc` is `health.lastSealedUtc`, passed through unchanged.
 */
export function summarizeHealth(health: CheckinPayload["health"], nowMs: number): FleetHealthSummary {
  const SILENT_AFTER_MS = 600000; // 10 minutes; strictly older than this is silent.
  const silent: string[] = [];
  const neverRecorded: string[] = [];
  let recordingCount = 0;
  for (const camera of health.cameras) {
    if (camera.recording === true) recordingCount += 1;
    if (camera.lastSealedUtc === null) {
      // Never sealed at all: silent, and specifically never-recorded.
      silent.push(camera.cameraId);
      neverRecorded.push(camera.cameraId);
    } else if (nowMs - Date.parse(camera.lastSealedUtc) > SILENT_AFTER_MS) {
      // Sealed, but the newest seal is strictly more than 10 minutes old.
      silent.push(camera.cameraId);
    }
  }
  return {
    version: health.version,
    uptimeSec: health.uptimeSec,
    cameras: {
      total: health.cameras.length,
      recording: recordingCount,
      silent,
      neverRecorded,
    },
    drives: {
      total: health.drives.length,
      // KNOWN SPEC/CONTRACT GAP (file-level comment above): CheckinDriveFact
      // carries no ok/problem field to read, so this is always [] today.
      problems: [],
    },
    footageHeldHours: health.footageHeld.hours,
    lastSealedUtc: health.lastSealedUtc,
  };
}

/** The device fields `fleetRow` needs -- never its public key or claim
 *  code. */
export interface FleetDevice {
  deviceId: string;
  state: "unclaimed" | "claimed" | "revoked";
}

/** The last check-in the cloud accepted from a device, or `null` if it has
 *  never accepted one. */
export interface FleetLastAccepted {
  atMs: number;
  payload: CheckinPayload;
}

/** One row of the fleet list. */
export interface FleetRow {
  deviceId: string;
  state: "unclaimed" | "claimed" | "revoked";
  status: FleetStatus;
  lastSeenUtc: string | null;
  health: FleetHealthSummary | null;
}

/**
 * Build one fleet-list row for a device. Pure and total; never throws.
 *
 * Contract:
 * - `deviceId` and `state` are copied from `device`.
 * - `status` is `fleetStatus(lastAccepted?.atMs ?? null, nowMs, intervalMs)`.
 * - `lastSeenUtc` is `lastAccepted.payload.sentAtUtc` when `lastAccepted` is
 *   not `null`, else `null`.
 * - `health` is `summarizeHealth(lastAccepted.payload.health, nowMs)` when
 *   `lastAccepted` is not `null`, else `null`.
 */
export function fleetRow(
  device: FleetDevice,
  lastAccepted: FleetLastAccepted | null,
  nowMs: number,
  intervalMs: number,
): FleetRow {
  const status = fleetStatus(lastAccepted?.atMs ?? null, nowMs, intervalMs);
  const lastSeenUtc = lastAccepted === null ? null : lastAccepted.payload.sentAtUtc;
  const health = lastAccepted === null ? null : summarizeHealth(lastAccepted.payload.health, nowMs);
  return { deviceId: device.deviceId, state: device.state, status, lastSeenUtc, health };
}
