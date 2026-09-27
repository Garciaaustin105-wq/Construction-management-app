/**
 * Whether the cloud should OFFER a software update to a device
 * (CLOUD-B1-SPEC.md section 6, "updates ride the outbound channel,
 * license-gated"; cloud/CLOUD-SLICE5-SPEC.md). Pure: no fs, no clock, no
 * network -- the caller supplies `nowMs`, every `Release` on file, the
 * device's own update state, and the entitlement result already computed
 * by slice 3 (`contracts/license.ts`'s `entitled(..., "updates")`).
 *
 * The box decides for itself whether to TRUST a release (the trust anchor,
 * agent/verify-release.mjs), and nothing here changes that. This contract
 * only decides whether to OFFER one -- trust is the box's problem, offering
 * is the cloud's.
 *
 * See cloud/CLOUD-SLICE5-SPEC.md for the full contract, and
 * cloud/harness/updateOffer.harness.mjs for the checks it must pass.
 */

import type { EntitledReason, EntitledResult } from "./license.js";

/**
 * One published software release. `version` is the git sha it was built
 * from, always 12 to 40 hex characters -- never a semver string, so
 * comparing two versions is a comparison of two hex strings, not a
 * version-range check.
 */
export interface Release {
  /** The git sha this release was built from, 12 to 40 hex characters. */
  version: string;
  /** Which channel this release ships on. A "beta" device also sees
   *  "stable" releases; a "stable" device never sees "beta" ones. */
  channel: "stable" | "beta";
  /** When this release became available, in epoch ms. A release with
   *  `publishedMs` in the future (relative to the caller's `nowMs`) is not
   *  yet a candidate. */
  publishedMs: number;
  /** When set, a device may only take this release directly from exactly
   *  this version -- an unknown current version (`null`) never satisfies
   *  it. `null` means this release has no such floor and can be taken from
   *  any current version. */
  minFromVersion: string | null;
  /** A withdrawn release is never offered, however new or otherwise
   *  eligible it is. Withdrawal is not the same as never having existed --
   *  a device already ON a withdrawn version is not rolled back by this
   *  contract; it simply is never OFFERED that version again. */
  withdrawn: boolean;
}

/** What the cloud has on file for one device's update state. */
export interface DeviceUpdateState {
  deviceId: string;
  /** The version currently running on the device, or `null` when it is
   *  unknown -- a blank is not a zero, and an unknown current version is
   *  never treated as equal to any particular version string. */
  currentVersion: string | null;
  /** Which channel the device is enrolled on. */
  channel: "stable" | "beta";
}

/** Why `offerUpdate` returned no offer. The entitlement reasons
 *  (`"license_lapsed"`, `"no_license"`, `"policy_undecided"`) are passed
 *  through verbatim from the caller's `entitled(..., "updates")` result --
 *  this contract invents no new reason for a lapsed license, it reuses
 *  slice 3's. */
export type OfferReason =
  | EntitledReason
  | "up_to_date"
  | "needs_intermediate"
  | "no_release"
  | "bad_version";

/** The result of asking whether a device should be offered an update. */
export type OfferResult = { offer: Release } | { offer: null; reason: OfferReason };

/**
 * Decide whether `device` should be offered an update right now. Pure and
 * total; never throws.
 *
 * Contract:
 * - `entitlement` is the caller's already-computed
 *   `entitled(coverage, "updates", policy)` result (slice 3). When
 *   `entitlement.ok` is `false`, return `{ offer: null, reason:
 *   entitlement.reason }` immediately, using the SAME reason value --
 *   a lapsed license means no updates, full stop, whatever releases exist.
 *   No other check below runs in that case.
 * - Otherwise, build the candidate set from `releases`:
 *   - drop any release with `withdrawn === true`;
 *   - drop any release with `publishedMs > nowMs` (not yet published, from
 *     the caller's clock);
 *   - keep a release only when its `channel` matches: a `"stable"` device
 *     keeps only `"stable"` releases; a `"beta"` device keeps both
 *     `"stable"` and `"beta"` releases.
 * - No candidates at all: `{ offer: null, reason: "no_release" }`.
 * - Otherwise pick exactly one candidate, deterministically: the one with
 *   the greatest `publishedMs`; when two or more candidates tie on
 *   `publishedMs`, the one whose `version` is the lexically greatest
 *   string (ordinary string comparison) wins.
 * - Validate the chosen candidate's `version`: it must be 12 to 40
 *   characters, each one a LOWERCASE hex digit (`[0-9a-f]`), as git prints
 *   a sha. Uppercase is refused: `"ABC..."` and `"abc..."` are the same
 *   build, but they compare unequal to the device's own `currentVersion`
 *   (which would re-offer the build it is already running) and sort
 *   differently in the tie-break. A malformed version on the chosen
 *   candidate gives `{ offer: null, reason: "bad_version" }` -- a
 *   defensive check on stored data, never surfaced to the device as a real
 *   offer. There is deliberately NO fallback to an older valid release:
 *   a malformed newest release is a publishing bug to fix, not to route
 *   around.
 * - The chosen candidate's `version` equal to `device.currentVersion`
 *   (a plain string equality; `currentVersion: null` never equals any
 *   version) gives `{ offer: null, reason: "up_to_date" }`.
 * - The chosen candidate's `minFromVersion`, when not `null`, must equal
 *   `device.currentVersion` exactly (again, `null` never matches). When it
 *   does not match -- including when `currentVersion` is unknown --
 *   return `{ offer: null, reason: "needs_intermediate" }`. Never offer a
 *   jump the release itself says it cannot take.
 * - Otherwise return `{ offer: <the chosen candidate> }`.
 */
export function offerUpdate(
  device: DeviceUpdateState,
  releases: Release[],
  entitlement: EntitledResult,
  nowMs: number,
): OfferResult {
  if (!entitlement.ok) {
    return { offer: null, reason: entitlement.reason };
  }

  const candidates = releases.filter(
    (r) =>
      !r.withdrawn &&
      r.publishedMs <= nowMs &&
      (r.channel === "stable" || device.channel === "beta"),
  );

  let chosen: Release | undefined;
  for (const r of candidates) {
    if (
      chosen === undefined ||
      r.publishedMs > chosen.publishedMs ||
      (r.publishedMs === chosen.publishedMs && r.version > chosen.version)
    ) {
      chosen = r;
    }
  }

  if (chosen === undefined) {
    return { offer: null, reason: "no_release" };
  }

  if (!/^[0-9a-f]{12,40}$/.test(chosen.version)) {
    return { offer: null, reason: "bad_version" };
  }

  if (chosen.version === device.currentVersion) {
    return { offer: null, reason: "up_to_date" };
  }

  if (chosen.minFromVersion !== null && chosen.minFromVersion !== device.currentVersion) {
    return { offer: null, reason: "needs_intermediate" };
  }

  return { offer: chosen };
}
