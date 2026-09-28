// cloud/harness/enroll.harness.mjs — cloud/contracts/enroll.ts's `verifyEnrollment`
//
// FEARED: a refusal that leaks the payload or the signature; a signature
// check that is faked rather than real, so a broken verifyEnrollment would
// still look like it passed; a box enrolling under a deviceId its own key
// does not actually produce.
//
// This harness signs for real: node:crypto generates real Ed25519 key
// pairs, canonicalJson(payload) (contracts/deviceCheckin.ts) is signed for
// real, and `deviceIdOf` below is a real, independent re-implementation of
// agent/device-identity.mjs's own derivation (base32(sha256(SPKI DER)[0:16]))
// -- not a stub that always agrees with whatever the code under test does.
//
// cloud/contracts/enroll.ts's verifyEnrollment() is itself a stub today
// ("verifyEnrollment: not built"), so every check below is expected to FAIL
// for that reason until it is built. That is fine -- see
// cloud/harness/apiCheckin.harness.mjs's own top comment for why.

import { generateKeyPairSync, createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { check, eq, same, report } from "../../harness/_assert.mjs";
import { canonicalJson } from "../dist/contracts/deviceCheckin.js";
import { verifyEnrollment, NONCE_PATTERN } from "../dist/cloud/contracts/enroll.js";

console.log("enroll contract");

// ---- Real Ed25519 keys and a real signing path ----

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = generateKeyPairSync("ed25519");
const otherPublicKeyPem = otherPublicKey.export({ type: "spki", format: "pem" }).toString();

// ---- A real, independent re-implementation of agent/device-identity.mjs's
// own deviceId derivation (base32(sha256(SPKI DER)[0:16])) -- hand-written
// here, not imported from agent/device-identity.mjs (which does not export
// it, and which this cloud-side harness must not depend on for fs/state
// reasons), so this is a genuine second implementation of the same
// algorithm, not the code under test agreeing with itself.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function realDeviceIdFor(pem) {
  // PEM framing/line-wrapping is not part of the key, only the DER bytes
  // are hashed -- createPublicKey().export({ format: "der" }) is used ONLY
  // to strip that framing; the hashing and base32 encoding above is the
  // hand-written part this check actually exercises, independent of
  // agent/device-identity.mjs's own (unexported) implementation.
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  const hash = createHash("sha256").update(der).digest();
  return base32Encode(hash.subarray(0, 16));
}

const deviceId = realDeviceIdFor(publicKeyPem);
const otherDeviceId = realDeviceIdFor(otherPublicKeyPem);

function realVerifySignature(message, signatureB64, publicKeyPemArg) {
  try {
    return cryptoVerify(null, Buffer.from(message, "utf8"), publicKeyPemArg, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

function throwingVerifySignature() {
  throw new Error("boom: signature backend unavailable");
}

const NOW_UTC = "2026-09-27T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_UTC);
const MAX_SKEW_MS = 300000; // 5 minutes, matching checkinVerify.ts's CLOCK_SKEW_LIMIT_MS convention
const NONCE = "abcdefghij012345"; // 16 chars, well within [A-Za-z0-9_-]

function makePayload({ theDeviceId = deviceId, thePublicKeyPem = publicKeyPem, sentAtUtc = NOW_UTC, nonce = NONCE } = {}) {
  return { deviceId: theDeviceId, publicKeyPem: thePublicKeyPem, sentAtUtc, nonce };
}

function signWith(payload, key = privateKey) {
  return cryptoSign(null, Buffer.from(canonicalJson(payload), "utf8"), key).toString("base64");
}

function envelopeFor(payload, key = privateKey) {
  return { payload, signatureB64: signWith(payload, key) };
}

function baseCtx(overrides = {}) {
  return {
    nowMs: NOW_MS,
    maxSkewMs: MAX_SKEW_MS,
    allowOpenEnrollment: true,
    deviceIdOf: (pem) => {
      try {
        return realDeviceIdFor(pem);
      } catch {
        return null;
      }
    },
    verifySignature: realVerifySignature,
    ...overrides,
  };
}

function assertNoLeak(result) {
  if (result.ok) throw new Error("assertNoLeak called on a success result");
  same(Object.keys(result).sort(), ["ok", "reason"], "a refusal must carry only ok and reason");
}

// ---- 1. enrollment_closed ----

check("enrollment_closed: ctx.allowOpenEnrollment !== true refuses everything, checked first", () => {
  for (const allowOpenEnrollment of [false, undefined, 0, "true", null]) {
    const ctx = baseCtx({ allowOpenEnrollment });
    const envelope = envelopeFor(makePayload());
    const r = verifyEnrollment(envelope, ctx);
    same(r, { ok: false, reason: "enrollment_closed" }, `allowOpenEnrollment=${JSON.stringify(allowOpenEnrollment)}`);
    assertNoLeak(r);
  }
});

check("enrollment_closed wins even over a malformed body", () => {
  const ctx = baseCtx({ allowOpenEnrollment: false });
  for (const bad of [null, undefined, 42, "nope", [], {}, { payload: {} }]) {
    const r = verifyEnrollment(bad, ctx);
    same(r, { ok: false, reason: "enrollment_closed" }, `bad=${JSON.stringify(bad)}`);
  }
});

// ---- 2. malformed ----

check("malformed: an envelope that is not { payload, signatureB64 }", () => {
  const ctx = baseCtx();
  const goodPayload = makePayload();
  const goodSig = signWith(goodPayload);
  for (const bad of [
    null,
    undefined,
    42,
    "nope",
    [],
    {},
    { payload: goodPayload }, // missing signatureB64
    { signatureB64: goodSig }, // missing payload
    { payload: goodPayload, signatureB64: 12345 }, // signatureB64 not a string
    { payload: goodPayload, signatureB64: "" }, // signatureB64 empty
    { payload: null, signatureB64: goodSig },
    { payload: { ...goodPayload, deviceId: 5 }, signatureB64: goodSig }, // deviceId not a string
    { payload: { ...goodPayload, publicKeyPem: 5 }, signatureB64: goodSig }, // publicKeyPem not a string
    { payload: { ...goodPayload, sentAtUtc: 5 }, signatureB64: goodSig }, // sentAtUtc not a string
    { payload: { ...goodPayload, nonce: 5 }, signatureB64: goodSig }, // nonce not a string
  ]) {
    const r = verifyEnrollment(bad, ctx);
    same(r, { ok: false, reason: "malformed" }, `malformed for ${JSON.stringify(bad)}`);
    assertNoLeak(r);
  }
});

check("malformed: sentAtUtc that does not parse", () => {
  const ctx = baseCtx();
  for (const bad of ["not-a-real-timestamp", "", "2026-13-45T99:99:99Z"]) {
    const payload = makePayload({ sentAtUtc: bad });
    const r = verifyEnrollment({ payload, signatureB64: signWith(payload) }, ctx);
    same(r, { ok: false, reason: "malformed" }, JSON.stringify(bad));
  }
});

check("malformed: nonce outside its shape (16 to 64 chars of [A-Za-z0-9_-])", () => {
  const ctx = baseCtx();
  const tooShort = "a".repeat(15);
  const tooLong = "a".repeat(65);
  const badChar = `${"a".repeat(15)}!`; // 16 chars but one is illegal
  for (const nonce of [tooShort, tooLong, badChar, ""]) {
    eq(NONCE_PATTERN.test(nonce), false, `sanity: ${JSON.stringify(nonce)} must not match NONCE_PATTERN`);
    const payload = makePayload({ nonce });
    const r = verifyEnrollment({ payload, signatureB64: signWith(payload) }, ctx);
    same(r, { ok: false, reason: "malformed" }, `nonce ${JSON.stringify(nonce)}`);
  }
});

check("nonce at exactly 16 and exactly 64 chars is within shape (boundary is inclusive)", () => {
  const ctx = baseCtx();
  for (const nonce of ["a".repeat(16), "a".repeat(64)]) {
    eq(NONCE_PATTERN.test(nonce), true, `sanity: ${JSON.stringify(nonce.length)} chars must match NONCE_PATTERN`);
    const payload = makePayload({ nonce });
    const r = verifyEnrollment(envelopeFor(payload), ctx);
    eq(r.ok, true, `nonce of length ${nonce.length} must be accepted end to end`);
  }
});

// ---- 3. bad_device_id ----

check("bad_device_id: a key whose derived deviceId differs from payload.deviceId is refused", () => {
  const ctx = baseCtx();
  // otherPublicKeyPem's real deviceId is otherDeviceId, not deviceId -- claim
  // deviceId (the wrong one) while presenting otherPublicKeyPem.
  const payload = makePayload({ theDeviceId: deviceId, thePublicKeyPem: otherPublicKeyPem });
  const envelope = envelopeFor(payload, otherPrivateKey); // signed correctly for the key it actually presents
  const r = verifyEnrollment(envelope, ctx);
  same(r, { ok: false, reason: "bad_device_id" });
  assertNoLeak(r);
});

check("bad_device_id: ctx.deviceIdOf returning null (an unparseable key) refuses, never crashes", () => {
  const ctx = baseCtx({ deviceIdOf: () => null });
  const payload = makePayload();
  const r = verifyEnrollment(envelopeFor(payload), ctx);
  same(r, { ok: false, reason: "bad_device_id" });
  assertNoLeak(r);
});

check("bad_device_id wins over a clock skew", () => {
  const ctx = baseCtx();
  const farAway = new Date(NOW_MS + MAX_SKEW_MS * 10).toISOString();
  const payload = makePayload({ theDeviceId: deviceId, thePublicKeyPem: otherPublicKeyPem, sentAtUtc: farAway });
  const envelope = envelopeFor(payload, otherPrivateKey);
  const r = verifyEnrollment(envelope, ctx);
  same(r, { ok: false, reason: "bad_device_id" });
});

// ---- 4. clock_skew ----

check("clock skew at exactly the limit is accepted, and 1 ms more is refused", () => {
  const ctx = baseCtx();
  const atLimit = new Date(NOW_MS + MAX_SKEW_MS).toISOString();
  const okPayload = makePayload({ sentAtUtc: atLimit });
  eq(verifyEnrollment(envelopeFor(okPayload), ctx).ok, true, "exactly at the limit must be accepted");

  const overLimit = new Date(NOW_MS + MAX_SKEW_MS + 1).toISOString();
  const badPayload = makePayload({ sentAtUtc: overLimit });
  const r = verifyEnrollment(envelopeFor(badPayload), ctx);
  same(r, { ok: false, reason: "clock_skew" });
  assertNoLeak(r);
});

check("clock skew in the past is symmetric, boundary inclusive", () => {
  const ctx = baseCtx();
  const atLimit = new Date(NOW_MS - MAX_SKEW_MS).toISOString();
  eq(verifyEnrollment(envelopeFor(makePayload({ sentAtUtc: atLimit })), ctx).ok, true, "past-side boundary is inclusive");

  const overLimit = new Date(NOW_MS - MAX_SKEW_MS - 1).toISOString();
  const r = verifyEnrollment(envelopeFor(makePayload({ sentAtUtc: overLimit })), ctx);
  same(r, { ok: false, reason: "clock_skew" });
});

check("clock_skew wins over a bad signature", () => {
  const ctx = baseCtx();
  const farAway = new Date(NOW_MS + MAX_SKEW_MS * 10).toISOString();
  const payload = makePayload({ sentAtUtc: farAway });
  const r = verifyEnrollment({ payload, signatureB64: "not-a-real-signature" }, ctx);
  same(r, { ok: false, reason: "clock_skew" });
});

// ---- 5. bad_signature ----

check("bad_signature: a garbled signature is refused, not thrown", () => {
  const ctx = baseCtx();
  const payload = makePayload();
  const r = verifyEnrollment({ payload, signatureB64: "not-base64-or-not-a-match!!" }, ctx);
  same(r, { ok: false, reason: "bad_signature" });
  assertNoLeak(r);
});

check("bad_signature: a real signature from the wrong key is refused", () => {
  const ctx = baseCtx();
  const payload = makePayload();
  const envelope = envelopeFor(payload, generateKeyPairSync("ed25519").privateKey);
  const r = verifyEnrollment(envelope, ctx);
  same(r, { ok: false, reason: "bad_signature" });
});

check("verifySignature throwing gives bad_signature, not a crash", () => {
  const ctx = baseCtx({ verifySignature: throwingVerifySignature });
  const envelope = envelopeFor(makePayload());
  let r;
  try {
    r = verifyEnrollment(envelope, ctx);
  } catch (err) {
    throw new Error(`verifyEnrollment must not propagate a throwing verifySignature: ${err.message}`);
  }
  same(r, { ok: false, reason: "bad_signature" });
  assertNoLeak(r);
});

// ---- success path ----

check("a well-formed, correctly signed, matching-key enrolment is accepted", () => {
  const ctx = baseCtx();
  const payload = makePayload();
  const r = verifyEnrollment(envelopeFor(payload), ctx);
  same(r, { ok: true, deviceId, publicKeyPem });
});

check("success echoes the VERIFIED deviceId and publicKeyPem, not merely the unverified payload's", () => {
  // Sanity: the payload's own fields already equal the verified ones in the
  // success case above (there is no other way to succeed), so this check
  // instead pins that the result carries exactly those two fields and
  // nothing else.
  const ctx = baseCtx();
  const r = verifyEnrollment(envelopeFor(makePayload()), ctx);
  same(Object.keys(r).sort(), ["deviceId", "ok", "publicKeyPem"].sort());
});

// ---- never throws on junk ----

check("THE FEARED ONE: never throws, whatever envelope is", () => {
  const ctx = baseCtx();
  const junk = [
    null, undefined, 0, 1, -1, NaN, Infinity, "", "hello", true, false,
    [], [1, 2, 3], {}, { payload: 1, signatureB64: 2 },
    { payload: makePayload(), signatureB64: null },
    { payload: { deviceId: null, publicKeyPem: null, sentAtUtc: null, nonce: null }, signatureB64: "x" },
    Symbol("nope"),
    function () {},
  ];
  for (const bad of junk) {
    let r;
    try {
      r = verifyEnrollment(bad, ctx);
    } catch (err) {
      throw new Error(`verifyEnrollment threw on ${String(bad)}: ${err.message}`);
    }
    eq(typeof r, "object", `result for ${String(bad)} must be an object, not a throw`);
    eq(r.ok, false, `junk envelope ${String(bad)} must never be accepted`);
  }
});

check("THE FEARED ONE: enrollment_closed is checked even for non-object junk, before any shape check", () => {
  const ctx = baseCtx({ allowOpenEnrollment: false });
  for (const bad of [null, undefined, 0, "", [], Symbol("nope")]) {
    const r = verifyEnrollment(bad, ctx);
    same(r, { ok: false, reason: "enrollment_closed" }, String(bad));
  }
});

report("enroll contract");
