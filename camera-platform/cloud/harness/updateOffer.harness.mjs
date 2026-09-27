// cloud/harness/updateOffer.harness.mjs — cloud/contracts/updateOffer.ts
//
// FEARED: a lapsed license still getting an offer because the entitlement
// short-circuit was skipped or reordered; a withdrawn or not-yet-published
// release slipping into the candidate set; a beta device's pick leaking to
// a stable device (or vice versa); a device silently jumping a release that
// named a minFromVersion floor it never actually sat on; and a nondeterministic
// tie-break that would pick a different release on a re-run of the same input.

import { check, same, report } from "../../harness/_assert.mjs";
import { offerUpdate } from "../dist/cloud/contracts/updateOffer.js";

console.log("updateOffer");

// ---- Fixtures. Every expected value below is written out literally per
// build rule (compute expected values by hand, never by calling the code
// under test).

function release(overrides = {}) {
  return {
    version: "aaaaaaaaaaaa", // 12 hex chars, the minimum valid length
    channel: "stable",
    publishedMs: 1000,
    minFromVersion: null,
    withdrawn: false,
    ...overrides,
  };
}

function device(overrides = {}) {
  return { deviceId: "dev-1", currentVersion: null, channel: "stable", ...overrides };
}

const entOk = { ok: true };
const entLapsed = { ok: false, reason: "license_lapsed" };
const entNoLicense = { ok: false, reason: "no_license" };
const entPolicyUndecided = { ok: false, reason: "policy_undecided" };

// ---- entitlement short-circuit ----

check("offerUpdate: a lapsed license never offers, whatever releases exist", () => {
  const releases = [
    release({ version: "bbbbbbbbbbbb", publishedMs: 2000 }),
    release({ version: "cccccccccccc", publishedMs: 3000 }),
  ];
  same(offerUpdate(device(), releases, entLapsed, 5000), { offer: null, reason: "license_lapsed" });
});

check("offerUpdate: every non-ok entitlement reason passes through unchanged", () => {
  const releases = [release({ version: "bbbbbbbbbbbb", publishedMs: 2000 })];
  same(offerUpdate(device(), releases, entNoLicense, 5000), { offer: null, reason: "no_license" });
  same(offerUpdate(device(), releases, entPolicyUndecided, 5000), { offer: null, reason: "policy_undecided" });
});

// ---- candidate filtering: withdrawn and future releases skipped ----

check("offerUpdate: withdrawn and future releases are skipped", () => {
  const withdrawn = release({ version: "bbbbbbbbbbbb", publishedMs: 5000, withdrawn: true });
  const future = release({ version: "cccccccccccc", publishedMs: 9000 }); // nowMs is 5000, below this
  const valid = release({ version: "dddddddddddd", publishedMs: 3000 });
  const result = offerUpdate(device({ currentVersion: "aaaaaaaaaaaa" }), [withdrawn, future, valid], entOk, 5000);
  same(result, { offer: valid });
});

// ---- channel gating ----

check("offerUpdate: a beta device sees stable and beta, a stable device only stable", () => {
  const stableRelease = release({ version: "eeeeeeeeeeee", channel: "stable", publishedMs: 1000 });
  const betaRelease = release({ version: "ffffffffffff", channel: "beta", publishedMs: 2000 });

  // Stable device: beta release is invisible to it, so the only candidate
  // is the stable one.
  const stableResult = offerUpdate(
    device({ channel: "stable", currentVersion: null }),
    [stableRelease, betaRelease],
    entOk,
    5000,
  );
  same(stableResult, { offer: stableRelease }, "stable device");

  // Beta device: both are candidates; the beta one has the later
  // publishedMs (2000 > 1000) so it is the chosen one.
  const betaResult = offerUpdate(
    device({ channel: "beta", currentVersion: null }),
    [stableRelease, betaRelease],
    entOk,
    5000,
  );
  same(betaResult, { offer: betaRelease }, "beta device");
});

// ---- needs_intermediate ----

check("offerUpdate: needs_intermediate, including an unknown current version", () => {
  const gated = release({ version: "111111111111", publishedMs: 4000, minFromVersion: "222222222222" });

  const wrongCurrent = offerUpdate(device({ currentVersion: "333333333333" }), [gated], entOk, 5000);
  same(wrongCurrent, { offer: null, reason: "needs_intermediate" }, "wrong current version");

  const unknownCurrent = offerUpdate(device({ currentVersion: null }), [gated], entOk, 5000);
  same(unknownCurrent, { offer: null, reason: "needs_intermediate" }, "unknown current version");
});

// ---- deterministic tie-break ----

check("offerUpdate: the tie-break on publishedMs is deterministic by lexically-greatest version", () => {
  const tieA = release({ version: "aaaaaaaaaaaa", publishedMs: 3000 });
  const tieB = release({ version: "bbbbbbbbbbbb", publishedMs: 3000 }); // "b" > "a" lexically

  same(offerUpdate(device({ currentVersion: null }), [tieA, tieB], entOk, 5000), { offer: tieB }, "A then B in input");
  same(offerUpdate(device({ currentVersion: null }), [tieB, tieA], entOk, 5000), { offer: tieB }, "B then A in input -- order must not matter");
});

// ---- up_to_date ----

check("offerUpdate: up_to_date when the chosen candidate matches the current version", () => {
  const current = release({ version: "444444444444", publishedMs: 4000 });
  const result = offerUpdate(device({ currentVersion: "444444444444" }), [current], entOk, 5000);
  same(result, { offer: null, reason: "up_to_date" });
});

// ---- no_release ----

check("offerUpdate: no_release when nothing survives the candidate filter", () => {
  const withdrawn = release({ version: "555555555555", withdrawn: true, publishedMs: 1000 });
  const future = release({ version: "666666666666", publishedMs: 9000 });
  const wrongChannel = release({ version: "777777777777", channel: "beta", publishedMs: 1000 });
  const result = offerUpdate(
    device({ channel: "stable", currentVersion: null }),
    [withdrawn, future, wrongChannel],
    entOk,
    5000,
  );
  same(result, { offer: null, reason: "no_release" });
});

// ---- bad_version ----

check("offerUpdate: bad_version when the chosen candidate's version is malformed", () => {
  const tooShort = release({ version: "abc", publishedMs: 5000 }); // fewer than 12 hex chars
  const result = offerUpdate(device({ currentVersion: null }), [tooShort], entOk, 5000);
  same(result, { offer: null, reason: "bad_version" });
});

// ---- bad_version: exact length boundaries and the hex-only charset ----
// The only prior bad_version fixture ("abc") is 3 chars -- nowhere near
// either length boundary and not exercising the charset at all. These pin
// the exact 12-40 range and the hex-only character class.

check("offerUpdate: version length boundaries -- 11 bad_version, 12 ok, 40 ok, 41 bad_version", () => {
  const tooShort = release({ version: "a".repeat(11), publishedMs: 5000 }); // 11 hex chars, one below the 12 minimum
  const atMin = release({ version: "b".repeat(12), publishedMs: 5000 }); // 12 hex chars, exactly the minimum
  const atMax = release({ version: "c".repeat(40), publishedMs: 5000 }); // 40 hex chars, exactly the maximum
  const tooLong = release({ version: "d".repeat(41), publishedMs: 5000 }); // 41 hex chars, one past the 40 maximum

  same(offerUpdate(device({ currentVersion: null }), [tooShort], entOk, 5000), { offer: null, reason: "bad_version" }, "11 chars, below minimum");
  same(offerUpdate(device({ currentVersion: null }), [atMin], entOk, 5000), { offer: atMin }, "12 chars, at minimum");
  same(offerUpdate(device({ currentVersion: null }), [atMax], entOk, 5000), { offer: atMax }, "40 chars, at maximum");
  same(offerUpdate(device({ currentVersion: null }), [tooLong], entOk, 5000), { offer: null, reason: "bad_version" }, "41 chars, above maximum");
});

check("offerUpdate: bad_version when the version contains a non-hex letter", () => {
  const nonHex = release({ version: "g".repeat(12), publishedMs: 5000 }); // 12 chars (a valid length), but 'g' is not a hex digit
  const result = offerUpdate(device({ currentVersion: null }), [nonHex], entOk, 5000);
  same(result, { offer: null, reason: "bad_version" });
});

// ---- bad_version: a malformed NEWEST release poisons the offer ----
// CLOUD-SLICE5-SPEC.md / the contract's own JSDoc are explicit: there is
// deliberately NO fallback to an older valid release when the chosen
// (newest) candidate is malformed -- it is a publishing bug to fix, not to
// route around silently.

check("offerUpdate: a malformed NEWEST release poisons the offer, with no fallback to an older valid release", () => {
  const malformedNewest = release({ version: "not-hex-zzzz", publishedMs: 9000 }); // newest by publishedMs, but not valid hex
  const validOlder = release({ version: "aaaaaaaaaaaa", publishedMs: 1000 });
  const result = offerUpdate(device({ currentVersion: null }), [malformedNewest, validOlder], entOk, 10000);
  same(result, { offer: null, reason: "bad_version" });
});

// ---- NEW RULE (contract updated today, code NOT yet changed): uppercase
// hex letters are bad_version. Only lowercase [0-9a-f] is valid, "as git
// prints a sha" -- "ABC..." and "abc..." are the same build but would
// compare unequal to currentVersion and sort differently in the tie-break.
// EXPECTED TO FAIL until the code is updated to match.

check("offerUpdate: NEW RULE -- any uppercase hex letter makes the version bad_version", () => {
  const allUpper = release({ version: "ABCABCABCABC", publishedMs: 5000 }); // 12 chars, all uppercase hex
  const oneUpper = release({ version: "aaaaaaaaaaaA", publishedMs: 5000 }); // 12 chars, one uppercase hex letter

  same(offerUpdate(device({ currentVersion: null }), [allUpper], entOk, 5000), { offer: null, reason: "bad_version" }, "all uppercase");
  same(offerUpdate(device({ currentVersion: null }), [oneUpper], entOk, 5000), { offer: null, reason: "bad_version" }, "one uppercase letter among lowercase");
});

report("updateOffer");
