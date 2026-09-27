/**
 * License entitlement: whether a device is currently covered by a licence,
 * and what that does or does not gate (CLOUD-B1-SPEC.md section 4;
 * cloud/CLOUD-SLICE3-SPEC.md). Pure: no fs, no clock, no network -- the
 * caller supplies `nowMs` and holds every `License` record.
 *
 * Owner's decision, quoted: "when a license turns off we will not have
 * anything on the cloud and also no updates the camera and the nvr onsite
 * facility will keep working but nothing going to the cloud will work." So
 * recording, local viewing and the on-box AI are ALWAYS entitled, in every
 * state, and only cloud/remote features (and, per policy, push alerts) ever
 * gate on coverage.
 *
 * See cloud/CLOUD-SLICE3-SPEC.md for the full contract
 * each one must satisfy, and cloud/harness/license.harness.mjs for the
 * checks it must pass.
 */

/** A single licence record, exactly as stored. `deviceIds` is what unit the
 *  licence covers -- undecided whether that means one camera or one whole
 *  box (cloud/CLOUD-SLICE3-SPEC.md); this contract only answers "is this
 *  device id covered", never what a device id denotes. */
export interface License {
  id: string;
  installerId: string;
  deviceIds: string[];
  startsMs: number;
  endsMs: number;
  revokedMs: number | null;
}

/** Policy inputs this contract never guesses (build rule 5 -- a blank is
 *  not a zero):
 *  - `pushAlertsNeedLicense`: `null` means undecided, not "no" -- see
 *    `entitled`'s `"policy_undecided"` reason.
 *  - `graceMs`: `null` means no grace period at all, not a zero-length one
 *    (a zero-length grace period is representable as `0` and behaves like
 *    no grace, but `null` and `0` are still different inputs). */
export interface LicensePolicy {
  pushAlertsNeedLicense: boolean | null;
  graceMs: number | null;
}

/** Every problem `checkLicense` can report. */
export type CheckLicenseReason =
  | "ends_before_starts"
  | "empty_devices"
  | "duplicate_device"
  | "bad_time";

/** The result of classifying a device against every licence that names it. */
export type CoverageState = "active" | "grace" | "lapsed" | "none";

/** What covers a device right now, and which licence is responsible. */
export interface Coverage {
  state: CoverageState;
  licenseId: string | null;
  endsMs: number | null;
}

/** A feature that may or may not require coverage to use. */
export type Feature =
  | "recording"
  | "local_view"
  | "on_box_ai"
  | "remote_access"
  | "cloud_dashboard"
  | "updates"
  | "push_alerts";

/** Why `entitled` refused a feature. */
export type EntitledReason = "license_lapsed" | "no_license" | "policy_undecided";

export type EntitledResult = { ok: true } | { ok: false; reason: EntitledReason };

/**
 * List every structural problem with a licence record. Pure and total;
 * never throws (build rule 10 -- a malformed record is a value to report,
 * not a crash). Reports EVERY problem that applies, not just the first
 * (build rule 11 -- report measurements, do not render a single verdict).
 *
 * Contract:
 * - `"bad_time"`: `startsMs` or `endsMs` is not a finite integer, or
 *   `revokedMs` is neither `null` nor a finite integer.
 * - `"ends_before_starts"`: `endsMs <= startsMs`. Only checked when both
 *   `startsMs` and `endsMs` are themselves finite integers -- comparing a
 *   non-finite time would only manufacture a second, meaningless problem on
 *   top of `"bad_time"`.
 * - `"empty_devices"`: `deviceIds.length === 0`.
 * - `"duplicate_device"`: the same id appears more than once in
 *   `deviceIds`.
 * - Problems are independent: a single licence can report several at once
 *   (e.g. both `"bad_time"` and `"empty_devices"`), and the array lists
 *   them in this fixed order: `"bad_time"`, `"ends_before_starts"`,
 *   `"empty_devices"`, `"duplicate_device"`. An empty array means no
 *   problem was found.
 */
export function checkLicense(l: License): CheckLicenseReason[] {
  // implementation
  const reasons: CheckLicenseReason[] = [];
  const startsFiniteInt = Number.isFinite(l.startsMs) && Number.isInteger(l.startsMs);
  const endsFiniteInt = Number.isFinite(l.endsMs) && Number.isInteger(l.endsMs);
  const revokedFiniteInt = l.revokedMs === null || (Number.isFinite(l.revokedMs) && Number.isInteger(l.revokedMs));
  if (!startsFiniteInt || !endsFiniteInt || !revokedFiniteInt) {
    reasons.push("bad_time");
  }
  if (startsFiniteInt && endsFiniteInt && l.endsMs <= l.startsMs) {
    reasons.push("ends_before_starts");
  }
  if (l.deviceIds.length === 0) {
    reasons.push("empty_devices");
  }
  const seen = new Set<string>();
  let duplicateFound = false;
  for (const id of l.deviceIds) {
    if (seen.has(id)) {
      duplicateFound = true;
      break;
    }
    seen.add(id);
  }
  if (duplicateFound) {
    reasons.push("duplicate_device");
  }
  return reasons;
}

/**
 * Classify a device's coverage across every licence that names it. Pure and
 * total; never throws.
 *
 * Contract:
 * - A licence "matches" when `deviceId` appears in its `deviceIds`.
 *   Licences that do not match `deviceId` are ignored entirely.
 * - A licence for which `checkLicense(l)` reports ANY problem is never
 *   trusted: it is skipped exactly as though it did not name the device
 *   (build rule 10 -- an `endsMs: Infinity` or a backwards window must not
 *   read as "active" or "grace"). The caller lists broken records with
 *   `checkLicense`; coverage only ever scores well-formed ones.
 * - If no licence matches, the result is `{ state: "none", licenseId: null,
 *   endsMs: null }`.
 * - Otherwise, each matching licence is classified on its own:
 *   - if `revokedMs !== null`, it is `"lapsed"` -- revocation always beats
 *     an otherwise-active or in-grace window (build rule 11: report what
 *     happened, and a revoke happened);
 *   - else if `startsMs <= nowMs < endsMs`, it is `"active"`;
 *   - else if `policy.graceMs !== null` and
 *     `endsMs < nowMs < endsMs + policy.graceMs` (both boundaries strict),
 *     it is `"grace"` -- so `nowMs === endsMs` and
 *     `nowMs === endsMs + policy.graceMs` are both `"lapsed"`, never
 *     `"grace"`;
 *   - otherwise (not yet started, ended with no applicable grace, or past
 *     the grace window) it is `"lapsed"`.
 * - The overall result is the BEST classification across all matching
 *   licences, best-to-worst: `"active"`, then `"grace"`, then `"lapsed"`.
 *   Among licences tied on that best state, the one with the latest
 *   `endsMs` wins; its `id` and `endsMs` are returned.
 */
export function coverage(
  licenses: License[],
  deviceId: string,
  nowMs: number,
  policy: LicensePolicy,
): Coverage {
  const rankMap: Record<CoverageState, number> = { active: 3, grace: 2, lapsed: 1, none: 0 };
  let bestState: CoverageState = "none";
  let bestEndsMs: number | null = null;
  let bestId: string | null = null;

  for (const lic of licenses) {
    if (!lic.deviceIds.includes(deviceId) || checkLicense(lic).length > 0) continue;
    let state: CoverageState;
    if (lic.revokedMs !== null) {
      state = "lapsed";
    } else if (lic.startsMs <= nowMs && nowMs < lic.endsMs) {
      state = "active";
    } else if (policy.graceMs !== null && lic.endsMs < nowMs && nowMs < lic.endsMs + policy.graceMs) {
      state = "grace";
    } else {
      state = "lapsed";
    }

    const stateRank = rankMap[state];
    const bestRank = rankMap[bestState];
    if (stateRank > bestRank) {
      bestState = state;
      bestEndsMs = lic.endsMs;
      bestId = lic.id;
    } else if (stateRank === bestRank && stateRank !== 0) {
      if (bestEndsMs === null || lic.endsMs > bestEndsMs) {
        bestEndsMs = lic.endsMs;
        bestId = lic.id;
      }
    }
  }

  if (bestState === "none") {
    return { state: "none", licenseId: null, endsMs: null };
  }
  return { state: bestState, licenseId: bestId, endsMs: bestEndsMs };
}

/**
 * Decide whether a coverage result entitles use of one feature right now.
 * Pure and total; never throws.
 *
 * Contract:
 * - `"recording"`, `"local_view"` and `"on_box_ai"` are `{ ok: true }`
 *   regardless of `cov.state` -- the owner's rule that a lapsed licence
 *   never touches what already happens on-site.
 * - `"remote_access"`, `"cloud_dashboard"` and `"updates"`:
 *   - `{ ok: true }` when `cov.state` is `"active"` or `"grace"`;
 *   - `{ ok: false, reason: "no_license" }` when `cov.state` is `"none"`;
 *   - `{ ok: false, reason: "license_lapsed" }` when `cov.state` is
 *     `"lapsed"`.
 * - `"push_alerts"` reads `policy.pushAlertsNeedLicense`:
 *   - `null` is always `{ ok: false, reason: "policy_undecided" }`, in
 *     EVERY coverage state -- a blank policy is never silently "allowed"
 *     or "blocked" (build rule 5);
 *   - `false` is always `{ ok: true }`, in every coverage state;
 *   - `true` follows exactly the `"remote_access"` rule above.
 */
export function entitled(cov: Coverage, feature: Feature, policy: LicensePolicy): EntitledResult {
  switch (feature) {
    case "recording":
    case "local_view":
    case "on_box_ai":
      return { ok: true };
    case "remote_access":
    case "cloud_dashboard":
    case "updates":
      if (cov.state === "active" || cov.state === "grace") {
        return { ok: true };
      } else if (cov.state === "none") {
        return { ok: false, reason: "no_license" };
      } else {
        return { ok: false, reason: "license_lapsed" };
      }
    case "push_alerts":
      if (policy.pushAlertsNeedLicense === null) {
        return { ok: false, reason: "policy_undecided" };
      } else if (policy.pushAlertsNeedLicense === false) {
        return { ok: true };
      } else {
        if (cov.state === "active" || cov.state === "grace") {
          return { ok: true };
        } else if (cov.state === "none") {
          return { ok: false, reason: "no_license" };
        } else {
          return { ok: false, reason: "license_lapsed" };
        }
      }
  }
}
