// cloud/harness/claimCode.harness.mjs — cloud/contracts/claimCode.ts
//
// FEARED: a claim code that round-trips wrong for some value combination, or
// a single mistyped symbol that the checksum fails to catch.

import { check, eq, same, report, throws } from "../../harness/_assert.mjs";
import { CLAIM_ALPHABET, formatClaimCode, parseClaimCode, claimStep } from "../dist/cloud/contracts/claimCode.js";

console.log("claim code");

// ---- Hand-computed reference implementation, independent of the code under
// test (build rule: compute expected check symbols by hand, never by calling
// the code under test). Mirrors CLOUD-SLICE1-SPEC.md section 1 exactly.
const DATA_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET = DATA_ALPHABET + "*~$=U";

function checkValueFor(values) {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += values[i] * (i + 1);
  return sum % 37;
}

function expectedFormat(values) {
  const data = values.map((v) => DATA_ALPHABET[v]).join("");
  const check = CHECK_ALPHABET[checkValueFor(values)];
  return `${data.slice(0, 4)}-${data.slice(4, 8)}-${check}`;
}

// Deterministic PRNG (mulberry32) so "1,000 generated codes" is reproducible.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValues(rng) {
  return Array.from({ length: 8 }, () => Math.floor(rng() * 32));
}

check("CLAIM_ALPHABET is Crockford base32 minus I, L, O, U, and formatClaimCode uses it", () => {
  eq(CLAIM_ALPHABET, DATA_ALPHABET);
  eq(CLAIM_ALPHABET.length, 32);
  for (const bad of ["I", "L", "O", "U"]) {
    if (CLAIM_ALPHABET.includes(bad)) throw new Error(`CLAIM_ALPHABET must not contain ${bad}`);
  }
  // Folded into this same check (rather than a standalone one) on purpose:
  // CLAIM_ALPHABET alone is a real, already-written constant, not a stub, so
  // a check that only touched it would keep passing even while every
  // function below is unbuilt. This line calls the stub, so the whole check
  // still fails until formatClaimCode is real.
  eq(formatClaimCode([0, 1, 2, 3, 4, 5, 6, 7]), expectedFormat([0, 1, 2, 3, 4, 5, 6, 7]));
});

check("formatClaimCode throws on caller bugs, not a value", () => {
  // Sanity first: a well-formed call must succeed with the right value, so
  // this check cannot pass vacuously just because every call happens to throw.
  eq(formatClaimCode([0, 1, 2, 3, 4, 5, 6, 7]), expectedFormat([0, 1, 2, 3, 4, 5, 6, 7]));
  throws(() => formatClaimCode([]), "wrong length");
  throws(() => formatClaimCode([0, 1, 2, 3, 4, 5, 6]), "too short");
  throws(() => formatClaimCode([0, 1, 2, 3, 4, 5, 6, 32]), "value out of range");
  throws(() => formatClaimCode([0, 1, 2, 3, 4, 5, 6, -1]), "negative value");
  throws(() => formatClaimCode([0, 1, 2, 3, 4, 5, 6, 1.5]), "non-integer value");
  throws(() => formatClaimCode("not-an-array"), "not an array");
});

check("formatClaimCode matches the hand-computed reference for known values", () => {
  const cases = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [31, 31, 31, 31, 31, 31, 31, 31],
    [1, 2, 3, 4, 5, 6, 7, 8],
    [17, 3, 29, 0, 8, 14, 22, 5],
  ];
  for (const values of cases) {
    eq(formatClaimCode(values), expectedFormat(values), `formatClaimCode(${JSON.stringify(values)})`);
  }
});

check("format then parse round-trips for 1,000 generated codes", () => {
  const rng = mulberry32(20260927);
  for (let i = 0; i < 1000; i++) {
    const values = randomValues(rng);
    const code = formatClaimCode(values);
    eq(code, expectedFormat(values), `code #${i}`);
    const parsed = parseClaimCode(code);
    same(parsed, { ok: true, code }, `round-trip #${i} for ${JSON.stringify(values)}`);
  }
});

check("lowercase, spaces and missing hyphens are accepted", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const canonical = expectedFormat(values);
  const compact = canonical.replace(/-/g, "");
  same(parseClaimCode(canonical.toLowerCase()), { ok: true, code: canonical });
  same(parseClaimCode(compact), { ok: true, code: canonical });
  same(parseClaimCode(compact.toLowerCase()), { ok: true, code: canonical });
  same(parseClaimCode(`  ${canonical.slice(0, 4)}  ${canonical.slice(5, 9)}  ${canonical.slice(10)}  `), {
    ok: true,
    code: canonical,
  });
  same(parseClaimCode(canonical.split("").join(" ")), { ok: true, code: canonical });
});

check("O and I/L are mapped onto 0 and 1", () => {
  // Position 0 carries value 0 -> symbol "0"; position 1 carries value 1 ->
  // symbol "1". Typing O for the first and I (or L) for the second must
  // still parse to the same canonical code.
  const values = [0, 1, 2, 3, 4, 5, 6, 7];
  const canonical = expectedFormat(values);
  eq(canonical[0], "0", "sanity: position 0 is the 0 symbol");
  eq(canonical[1], "1", "sanity: position 1 is the 1 symbol");
  const withO = "O" + canonical.slice(1);
  const withI = canonical[0] + "I" + canonical.slice(2);
  const withL = canonical[0] + "L" + canonical.slice(2);
  same(parseClaimCode(withO), { ok: true, code: canonical });
  same(parseClaimCode(withI), { ok: true, code: canonical });
  same(parseClaimCode(withL), { ok: true, code: canonical });
  same(parseClaimCode(withO.toLowerCase()), { ok: true, code: canonical });
});

check("not_text: non-string input is refused without throwing", () => {
  for (const bad of [null, undefined, 12345, {}, [], true]) {
    same(parseClaimCode(bad), { ok: false, reason: "not_text" });
  }
});

check("wrong_length: too few or too many symbols after stripping separators", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const canonical = expectedFormat(values);
  same(parseClaimCode(canonical.slice(0, -1)), { ok: false, reason: "wrong_length" });
  same(parseClaimCode(canonical + "0"), { ok: false, reason: "wrong_length" });
  same(parseClaimCode(""), { ok: false, reason: "wrong_length" });
  same(parseClaimCode("----"), { ok: false, reason: "wrong_length" });
});

check("bad_symbol: a character outside the check alphabet (post O/I/L mapping)", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const canonical = expectedFormat(values);
  const withBang = "!" + canonical.slice(1);
  same(parseClaimCode(withBang), { ok: false, reason: "bad_symbol" });
  const withU = "U" + canonical.slice(1); // U is excluded even though it IS in the check alphabet's tail — but not a valid mapped data symbol
  const r = parseClaimCode(withU);
  if (r.ok) throw new Error("U in a data position must not silently parse as valid");
});

check("a single-symbol typo fails bad_check, for every position", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const canonical = expectedFormat(values);
  const flat = canonical.replace(/-/g, ""); // 9 symbols: 8 data + 1 check
  for (let pos = 0; pos < 9; pos++) {
    const alphabet = pos < 8 ? DATA_ALPHABET : CHECK_ALPHABET;
    const original = flat[pos];
    const replacement = alphabet[0] === original ? alphabet[1] : alphabet[0];
    const mutated = flat.slice(0, pos) + replacement + flat.slice(pos + 1);
    const mutatedCanonical = `${mutated.slice(0, 4)}-${mutated.slice(4, 8)}-${mutated.slice(8)}`;
    same(parseClaimCode(mutatedCanonical), { ok: false, reason: "bad_check" }, `typo at position ${pos}`);
  }
});

// ---- claimStep ----

const unclaimed = (code, codeExpiresMs) => ({ state: "unclaimed", code, codeExpiresMs, installerId: null });
const claimed = (installerId = "installer-1") => ({ state: "claimed", code: null, codeExpiresMs: null, installerId });
const revoked = () => ({ state: "revoked", code: null, codeExpiresMs: null, installerId: null });

check("claimStep refuses claim from every state but unclaimed", () => {
  const action = { type: "claim", code: "ABCD-1234-5", installerId: "x" };
  same(claimStep(claimed(), action, 0), { ok: false, reason: "wrong_state" });
  same(claimStep(revoked(), action, 0), { ok: false, reason: "wrong_state" });
});

check("claimStep refuses revoke from every state but claimed", () => {
  same(claimStep(unclaimed("ABCD-1234-5", 1000), { type: "revoke" }, 0), { ok: false, reason: "wrong_state" });
  same(claimStep(revoked(), { type: "revoke" }, 0), { ok: false, reason: "wrong_state" });
});

check("revoke from claimed succeeds: a NEW object, state revoked, the installer kept for the record, the input untouched", () => {
  // Found in review 2026-09-27: only revoke's refusals were tested.
  const before = claimed("installer-9");
  const snapshot = JSON.stringify(before);
  const r = claimStep(before, { type: "revoke" }, 0);
  eq(r.ok, true, "allowed from claimed");
  same(r.device, { state: "revoked", code: null, codeExpiresMs: null, installerId: "installer-9" }, "the revoked device");
  eq(r.device === before, false, "a new object");
  eq(JSON.stringify(before), snapshot, "the input is not mutated");
});

check("claimStep refuses reissue from claimed", () => {
  const action = { type: "reissue", code: "WXYZ-6789-0", codeExpiresMs: 5000 };
  same(claimStep(claimed(), action, 0), { ok: false, reason: "wrong_state" });
});

check("claimStep refuses a claim with no code on file", () => {
  const device = unclaimed(null, null);
  same(claimStep(device, { type: "claim", code: "ABCD-1234-5", installerId: "x" }, 0), {
    ok: false,
    reason: "no_code",
  });
});

check("claimStep refuses an expired code, including at nowMs == codeExpiresMs", () => {
  const device = unclaimed("ABCD-1234-5", 1000);
  const action = { type: "claim", code: "ABCD-1234-5", installerId: "x" };
  same(claimStep(device, action, 1000), { ok: false, reason: "code_expired" });
  same(claimStep(device, action, 1001), { ok: false, reason: "code_expired" });
  const before = JSON.stringify(device);
  const r = claimStep(device, action, 999);
  eq(r.ok, true, "999ms before expiry must succeed");
  eq(JSON.stringify(device), before, "device must not be mutated");
});

check("claimStep refuses a mismatched code without leaking which part was wrong", () => {
  const device = unclaimed("ABCD-1234-5", 999999);
  same(claimStep(device, { type: "claim", code: "WXYZ-6789-0", installerId: "x" }, 0), {
    ok: false,
    reason: "code_mismatch",
  });
});

check("a claim is single-use: code and codeExpiresMs are cleared on success", () => {
  const device = unclaimed("ABCD-1234-5", 999999);
  const before = JSON.stringify(device);
  const r = claimStep(device, { type: "claim", code: "ABCD-1234-5", installerId: "field-tech" }, 0);
  eq(r.ok, true);
  same(r.device, { state: "claimed", code: null, codeExpiresMs: null, installerId: "field-tech" });
  eq(JSON.stringify(device), before, "input device must not be mutated");
  if (r.device === device) throw new Error("claimStep must return a new object, not the input");
});

check("reissue clears the installer and moves unclaimed/revoked devices to unclaimed", () => {
  for (const device of [unclaimed(null, null), revoked()]) {
    const before = JSON.stringify(device);
    const r = claimStep(device, { type: "reissue", code: "WXYZ-6789-0", codeExpiresMs: 555555 }, 0);
    eq(r.ok, true);
    same(r.device, { state: "unclaimed", code: "WXYZ-6789-0", codeExpiresMs: 555555, installerId: null });
    eq(JSON.stringify(device), before, "input device must not be mutated");
  }
});

check("claimStep refuses an unrecognized action type", () => {
  same(claimStep(unclaimed("ABCD-1234-5", 999999), { type: "nope" }, 0), { ok: false, reason: "bad_action" });
});

report("claim code");
