// cloud/harness/license.harness.mjs — cloud/contracts/license.ts
//
// FEARED: a lapsed licence silently blocking recording, local viewing or
// the on-box AI (the owner's rule those must never gate); a revoked licence
// being scored as active because an expiry/grace check ran before the
// revoke check; and an off-by-one at the endsMs/endsMs+graceMs boundaries
// that scores one extra tick of "grace" or "active" that a customer never
// paid for.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { checkLicense, coverage, entitled } from "../dist/cloud/contracts/license.js";

console.log("license");

// ---- Fixtures. Every expected value below is written out literally per
// build rule (compute expected values by hand, never by calling the code
// under test) -- there is no shared reference implementation here to keep
// a bug in it from being echoed by the check that is supposed to catch it.

function license(overrides = {}) {
  return {
    id: "L1",
    installerId: "inst-1",
    deviceIds: ["dev-1"],
    startsMs: 0,
    endsMs: 1000,
    revokedMs: null,
    ...overrides,
  };
}

const noGrace = { pushAlertsNeedLicense: null, graceMs: null };
const grace500 = { pushAlertsNeedLicense: null, graceMs: 500 };

// ---- checkLicense ----

check("checkLicense: a well-formed licence has no problems", () => {
  same(checkLicense(license()), []);
});

check("checkLicense: ends_before_starts, both when equal and when reversed", () => {
  same(checkLicense(license({ startsMs: 1000, endsMs: 1000 })), ["ends_before_starts"]);
  same(checkLicense(license({ startsMs: 1000, endsMs: 500 })), ["ends_before_starts"]);
});

check("checkLicense: empty_devices", () => {
  same(checkLicense(license({ deviceIds: [] })), ["empty_devices"]);
});

check("checkLicense: duplicate_device", () => {
  same(checkLicense(license({ deviceIds: ["dev-1", "dev-2", "dev-1"] })), ["duplicate_device"]);
});

check("checkLicense: bad_time covers non-integer, non-finite and a bad revokedMs", () => {
  same(checkLicense(license({ startsMs: 1.5 })), ["bad_time"]);
  same(checkLicense(license({ endsMs: Infinity })), ["bad_time"]);
  same(checkLicense(license({ startsMs: NaN })), ["bad_time"]);
  same(checkLicense(license({ revokedMs: 12.5 })), ["bad_time"]);
  // revokedMs: null is NOT a problem -- a licence that was never revoked.
  same(checkLicense(license({ revokedMs: null })), []);
});

check("checkLicense: multiple problems are all reported, in the fixed order", () => {
  same(checkLicense(license({ startsMs: NaN, endsMs: 1000, deviceIds: [] })), ["bad_time", "empty_devices"]);
  same(
    checkLicense(license({ startsMs: 1000, endsMs: 500, deviceIds: ["dev-1", "dev-1"] })),
    ["ends_before_starts", "duplicate_device"],
  );
});

check("checkLicense: ends_before_starts is not reported when the times are themselves bad_time", () => {
  // startsMs is non-finite, so comparing it against endsMs would only
  // manufacture a second, meaningless problem on top of bad_time.
  same(checkLicense(license({ startsMs: NaN, endsMs: 500, deviceIds: [] })), ["bad_time", "empty_devices"]);
});

// ---- coverage ----

check("coverage: none when no licence names the device", () => {
  same(coverage([license({ deviceIds: ["some-other-device"] })], "dev-1", 500, noGrace), {
    state: "none",
    licenseId: null,
    endsMs: null,
  });
  same(coverage([], "dev-1", 500, noGrace), { state: "none", licenseId: null, endsMs: null });
});

check("coverage: active when started and not yet ended", () => {
  const L = license({ startsMs: 0, endsMs: 1000 });
  same(coverage([L], "dev-1", 500, noGrace), { state: "active", licenseId: "L1", endsMs: 1000 });
  same(coverage([L], "dev-1", 0, noGrace), { state: "active", licenseId: "L1", endsMs: 1000 }, "start instant included");
});

check("coverage: exactly at endsMs is lapsed, with no grace configured", () => {
  const L = license({ startsMs: 0, endsMs: 1000 });
  same(coverage([L], "dev-1", 1000, noGrace), { state: "lapsed", licenseId: "L1", endsMs: 1000 });
});

check("coverage: strictly after endsMs and before endsMs + graceMs is grace", () => {
  const L = license({ startsMs: 0, endsMs: 1000 });
  same(coverage([L], "dev-1", 1001, grace500), { state: "grace", licenseId: "L1", endsMs: 1000 });
  same(coverage([L], "dev-1", 1499, grace500), { state: "grace", licenseId: "L1", endsMs: 1000 });
});

check("coverage: exactly at endsMs is lapsed even when a grace period is configured", () => {
  const L = license({ startsMs: 0, endsMs: 1000 });
  same(coverage([L], "dev-1", 1000, grace500), { state: "lapsed", licenseId: "L1", endsMs: 1000 });
});

check("coverage: exactly at endsMs + graceMs is lapsed, not grace", () => {
  const L = license({ startsMs: 0, endsMs: 1000 });
  same(coverage([L], "dev-1", 1500, grace500), { state: "lapsed", licenseId: "L1", endsMs: 1000 });
});

check("coverage: not yet started is lapsed, not active", () => {
  const L = license({ startsMs: 1000, endsMs: 2000 });
  same(coverage([L], "dev-1", 999, noGrace), { state: "lapsed", licenseId: "L1", endsMs: 2000 });
});

check("coverage: revoked beats an otherwise-active window", () => {
  const L = license({ startsMs: 0, endsMs: 1000, revokedMs: 1 });
  same(coverage([L], "dev-1", 500, noGrace), { state: "lapsed", licenseId: "L1", endsMs: 1000 });
});

check("coverage: revoked beats an otherwise-in-grace window", () => {
  const L = license({ startsMs: 0, endsMs: 1000, revokedMs: 1 });
  same(coverage([L], "dev-1", 1200, grace500), { state: "lapsed", licenseId: "L1", endsMs: 1000 });
});

check("coverage: the best state across several licences wins -- active beats lapsed", () => {
  const lapsedOne = license({ id: "L-lapsed", startsMs: 0, endsMs: 100, revokedMs: null });
  const activeOne = license({ id: "L-active", startsMs: 0, endsMs: 1000, revokedMs: null });
  same(coverage([lapsedOne, activeOne], "dev-1", 500, noGrace), {
    state: "active",
    licenseId: "L-active",
    endsMs: 1000,
  });
  // order in the input array must not matter
  same(coverage([activeOne, lapsedOne], "dev-1", 500, noGrace), {
    state: "active",
    licenseId: "L-active",
    endsMs: 1000,
  });
});

check("coverage: the best state across several licences wins -- grace beats lapsed", () => {
  const longLapsed = license({ id: "L-lapsed", startsMs: 0, endsMs: 100, revokedMs: null });
  const inGrace = license({ id: "L-grace", startsMs: 0, endsMs: 1000, revokedMs: null });
  same(coverage([longLapsed, inGrace], "dev-1", 1200, grace500), {
    state: "grace",
    licenseId: "L-grace",
    endsMs: 1000,
  });
});

check("coverage: among licences tied on state, the latest endsMs wins", () => {
  const shorter = license({ id: "L-short", startsMs: 0, endsMs: 1000 });
  const longer = license({ id: "L-long", startsMs: 0, endsMs: 2000 });
  same(coverage([shorter, longer], "dev-1", 500, noGrace), { state: "active", licenseId: "L-long", endsMs: 2000 });
  same(coverage([longer, shorter], "dev-1", 500, noGrace), { state: "active", licenseId: "L-long", endsMs: 2000 });
});

// ---- entitled ----

const covNone = { state: "none", licenseId: null, endsMs: null };
const covActive = { state: "active", licenseId: "L1", endsMs: 1000 };
const covGrace = { state: "grace", licenseId: "L1", endsMs: 1000 };
const covLapsed = { state: "lapsed", licenseId: "L1", endsMs: 1000 };
const allStates = [covNone, covActive, covGrace, covLapsed];

check("entitled: recording, local_view and on_box_ai are ok in every coverage state", () => {
  for (const feature of ["recording", "local_view", "on_box_ai"]) {
    for (const cov of allStates) {
      same(entitled(cov, feature, noGrace), { ok: true }, `${feature} @ ${cov.state}`);
      // and again under a policy that would otherwise gate push alerts,
      // to prove these three features never consult pushAlertsNeedLicense
      same(entitled(cov, feature, { pushAlertsNeedLicense: true, graceMs: null }), { ok: true }, `${feature} @ ${cov.state}, push-gated policy`);
    }
  }
});

check("entitled: remote_access, cloud_dashboard and updates require active or grace", () => {
  for (const feature of ["remote_access", "cloud_dashboard", "updates"]) {
    same(entitled(covActive, feature, noGrace), { ok: true }, `${feature} active`);
    same(entitled(covGrace, feature, noGrace), { ok: true }, `${feature} grace`);
    same(entitled(covNone, feature, noGrace), { ok: false, reason: "no_license" }, `${feature} none`);
    same(entitled(covLapsed, feature, noGrace), { ok: false, reason: "license_lapsed" }, `${feature} lapsed`);
  }
});

check("entitled: a null push policy is policy_undecided in every coverage state", () => {
  for (const cov of allStates) {
    same(entitled(cov, "push_alerts", noGrace), { ok: false, reason: "policy_undecided" }, `push @ ${cov.state}`);
  }
});

check("entitled: pushAlertsNeedLicense=false is always ok", () => {
  const policy = { pushAlertsNeedLicense: false, graceMs: null };
  for (const cov of allStates) {
    same(entitled(cov, "push_alerts", policy), { ok: true }, `push @ ${cov.state}`);
  }
});

check("entitled: pushAlertsNeedLicense=true follows the remote_access rule", () => {
  const policy = { pushAlertsNeedLicense: true, graceMs: null };
  same(entitled(covActive, "push_alerts", policy), { ok: true });
  same(entitled(covGrace, "push_alerts", policy), { ok: true });
  same(entitled(covNone, "push_alerts", policy), { ok: false, reason: "no_license" });
  same(entitled(covLapsed, "push_alerts", policy), { ok: false, reason: "license_lapsed" });
});

// ---- Review findings (2026-09-27): coverage must never score a licence
// that checkLicense calls broken. Written to FAIL against the first build.

check("coverage: a licence with endsMs Infinity is skipped, never active forever", () => {
  const L = license({ endsMs: Infinity });
  same(coverage([L], "dev-1", 10 ** 15, noGrace), covNone);
  same(entitled(coverage([L], "dev-1", 10 ** 15, noGrace), "remote_access", noGrace), { ok: false, reason: "no_license" });
});

check("coverage: a backwards window is skipped, never grace", () => {
  // Without the skip, 500 < 700 < 1000 would score this as grace.
  const L = license({ startsMs: 1000, endsMs: 500 });
  same(coverage([L], "dev-1", 700, grace500), covNone);
});

check("coverage: every checkLicense problem means skipped, and a good licence beside it still counts", () => {
  same(coverage([license({ deviceIds: ["dev-1", "dev-1"] })], "dev-1", 500, noGrace), covNone, "duplicate_device");
  same(coverage([license({ revokedMs: 12.5 })], "dev-1", 500, noGrace), covNone, "bad revokedMs");
  same(coverage([license({ startsMs: 0.5 })], "dev-1", 500, noGrace), covNone, "fractional startsMs");
  const broken = license({ id: "L-broken", endsMs: Infinity });
  const good = license({ id: "L-good", startsMs: 0, endsMs: 1000 });
  same(coverage([broken, good], "dev-1", 2000, noGrace), { state: "lapsed", licenseId: "L-good", endsMs: 1000 });
});

report("license");
