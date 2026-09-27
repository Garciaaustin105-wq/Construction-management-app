// cloud/harness/checkinVerify.harness.mjs — cloud/contracts/checkinVerify.ts
//
// FEARED: a refusal that leaks health data or a signature; a signature check
// that is faked rather than real, so a broken verifyCheckin would still look
// like it passed.
//
// This harness signs for real: node:crypto generates a real Ed25519 key
// pair, deviceCheckin's buildCheckin() builds a real payload, checkinDigest()
// is signed for real, and the ctx.verifySignature passed to verifyCheckin is
// a real crypto.verify() call -- not a stub that always returns true.

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { check, eq, same, report } from "../../harness/_assert.mjs";
import { buildCheckin, checkinDigest } from "../dist/contracts/deviceCheckin.js";
import { verifyCheckin, CLOCK_SKEW_LIMIT_MS } from "../dist/cloud/contracts/checkinVerify.js";

console.log("checkin verify");

// ---- Real Ed25519 keys and a real signing path ----

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
const otherPublicKeyPem = otherPublicKey.export({ type: "spki", format: "pem" }).toString();

function realVerifySignature(digestHex, signatureB64, publicKeyPemArg) {
  try {
    return cryptoVerify(null, Buffer.from(digestHex, "utf8"), publicKeyPemArg, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

function throwingVerifySignature() {
  throw new Error("boom: signature backend unavailable");
}

const BASE_FACTS = {
  version: "abc123",
  uptimeSec: 3600,
  cameras: [],
  drives: [],
  footageHeld: { hours: 12.5, basis: "segments", refusedReason: null },
  detector: { capacityFps: 8, minConfidence: 0.5, motionGateEnabled: true },
  knownObjects: { active: 3, lapsed: 1 },
  lastSealedUtc: "2026-09-26T23:50:00.000Z",
};

const NOW_UTC = "2026-09-27T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_UTC);

function makePayload({ deviceId = "dev-1", seq = 1, sentAtUtc = NOW_UTC } = {}) {
  return buildCheckin(BASE_FACTS, { deviceId, nowUtc: sentAtUtc, seq });
}

function signWith(payload, key) {
  const digest = checkinDigest(payload);
  return cryptoSign(null, Buffer.from(digest, "utf8"), key).toString("base64");
}

function envelopeFor(payload, key = privateKey) {
  return { payload, signature: signWith(payload, key) };
}

function baseCtx(overrides = {}) {
  return {
    devices: new Map([["dev-1", { state: "claimed", publicKeyPem }]]),
    lastSeq: new Map(),
    nowMs: NOW_MS,
    verifySignature: realVerifySignature,
    ...overrides,
  };
}

function assertNoLeak(result) {
  if (result.ok) throw new Error("assertNoLeak called on a success result");
  same(Object.keys(result).sort(), ["ok", "reason"], "a refusal must carry only ok and reason");
}

// ---- 1. malformed ----

check("malformed: an envelope that is not { payload, signature }", () => {
  const ctx = baseCtx();
  for (const bad of [
    null,
    undefined,
    42,
    "nope",
    [],
    {},
    { payload: makePayload() }, // missing signature
    { signature: "abc" }, // missing payload
    { payload: makePayload(), signature: 12345 }, // signature not a string
    { payload: null, signature: "abc" },
    { payload: { ...makePayload(), deviceId: 5 }, signature: signWith(makePayload(), privateKey) }, // deviceId not a string
    { payload: { ...makePayload(), seq: "1" }, signature: signWith(makePayload(), privateKey) }, // seq not a number
    { payload: { ...makePayload(), health: null }, signature: signWith(makePayload(), privateKey) }, // health not an object
  ]) {
    const r = verifyCheckin(bad, ctx);
    same(r, { ok: false, reason: "malformed" }, `malformed for ${JSON.stringify(bad)}`);
    assertNoLeak(r);
  }
});

// ---- 2. unsupported_version ----

check("unsupported_version wins even when the device is also unknown", () => {
  const ctx = baseCtx({ devices: new Map() }); // dev-1 not present either
  const payload = makePayload();
  const envelope = envelopeFor({ ...payload, checkinVersion: 2 });
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "unsupported_version" });
  assertNoLeak(r);
});

// ---- 3. unknown_device ----

check("unknown_device: deviceId is not in ctx.devices", () => {
  const ctx = baseCtx();
  const envelope = envelopeFor(makePayload({ deviceId: "dev-ghost" }));
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "unknown_device" });
  assertNoLeak(r);
});

// ---- 4. not_claimed ----

check("not_claimed wins over a bad signature", () => {
  for (const state of ["unclaimed", "revoked"]) {
    const ctx = baseCtx({ devices: new Map([["dev-1", { state, publicKeyPem }]]) });
    const envelope = { payload: makePayload(), signature: "not-a-real-signature" };
    const r = verifyCheckin(envelope, ctx);
    same(r, { ok: false, reason: "not_claimed" }, `state=${state}`);
    assertNoLeak(r);
  }
});

// ---- 5. bad_signature ----

check("bad_signature: a garbled signature is refused, not thrown", () => {
  const ctx = baseCtx();
  const payload = makePayload();
  const envelope = { payload, signature: "not-base64-or-not-a-match!!" };
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "bad_signature" });
  assertNoLeak(r);
});

check("bad_signature: a real signature from the wrong key is refused", () => {
  const ctx = baseCtx();
  const payload = makePayload();
  const envelope = envelopeFor(payload, generateKeyPairSync("ed25519").privateKey);
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "bad_signature" });
  assertNoLeak(r);
});

check("bad_signature wins over a replay", () => {
  const ctx = baseCtx({ lastSeq: new Map([["dev-1", 5]]) });
  const payload = makePayload({ seq: 5 }); // equal to lastSeq -> would also be a replay
  const envelope = { payload, signature: "garbage" };
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "bad_signature" });
  assertNoLeak(r);
});

check("verifySignature throwing gives bad_signature, not a crash", () => {
  const ctx = baseCtx({ verifySignature: throwingVerifySignature });
  const envelope = envelopeFor(makePayload());
  let r;
  try {
    r = verifyCheckin(envelope, ctx);
  } catch (err) {
    throw new Error(`verifyCheckin must not propagate a throwing verifySignature: ${err.message}`);
  }
  same(r, { ok: false, reason: "bad_signature" });
  assertNoLeak(r);
});

check("a non-function verifySignature is a caller bug (throws); a merely malformed envelope is not", () => {
  const ctx = baseCtx({ verifySignature: "not-a-function" });
  const envelope = envelopeFor(makePayload());
  let threw = false;
  try {
    verifyCheckin(envelope, ctx);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected verifyCheckin to throw for a non-function ctx.verifySignature");
  // By contrast, a merely malformed envelope against a well-formed ctx must
  // return a value, not throw -- this line alone fails while unbuilt, so this
  // check cannot pass vacuously just because every call happens to throw.
  same(verifyCheckin(null, baseCtx()), { ok: false, reason: "malformed" });
});

// ---- 6. replay ----

check("replay at an equal seq", () => {
  const ctx = baseCtx({ lastSeq: new Map([["dev-1", 7]]) });
  const envelope = envelopeFor(makePayload({ seq: 7 }));
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "replay" });
  assertNoLeak(r);
});

check("replay at a lower seq", () => {
  const ctx = baseCtx({ lastSeq: new Map([["dev-1", 7]]) });
  const envelope = envelopeFor(makePayload({ seq: 3 }));
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "replay" });
});

check("a device absent from lastSeq accepts any seq >= 1", () => {
  const ctx = baseCtx({ lastSeq: new Map() });
  const envelope = envelopeFor(makePayload({ seq: 1 }));
  const r = verifyCheckin(envelope, ctx);
  eq(r.ok, true, "seq 1 with no prior lastSeq entry must be accepted");
});

check("replay wins over a clock skew", () => {
  const ctx = baseCtx({ lastSeq: new Map([["dev-1", 9]]) });
  const farAway = new Date(NOW_MS + CLOCK_SKEW_LIMIT_MS * 10).toISOString();
  const envelope = envelopeFor(makePayload({ seq: 9, sentAtUtc: farAway }));
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: false, reason: "replay" });
  assertNoLeak(r);
});

// ---- 7. clock_skew ----

check("clock skew at exactly the limit is accepted, and 1 ms more is refused", () => {
  const ctx = baseCtx();
  const atLimit = new Date(NOW_MS + CLOCK_SKEW_LIMIT_MS).toISOString();
  const okEnvelope = envelopeFor(makePayload({ seq: 1, sentAtUtc: atLimit }));
  eq(verifyCheckin(okEnvelope, ctx).ok, true, "exactly at the limit must be accepted");

  const overLimit = new Date(NOW_MS + CLOCK_SKEW_LIMIT_MS + 1).toISOString();
  const badEnvelope = envelopeFor(makePayload({ seq: 2, sentAtUtc: overLimit }));
  const r = verifyCheckin(badEnvelope, ctx);
  same(r, { ok: false, reason: "clock_skew" });
  assertNoLeak(r);
});

check("clock skew in the past is symmetric", () => {
  const ctx = baseCtx();
  const before = new Date(NOW_MS - CLOCK_SKEW_LIMIT_MS - 1).toISOString();
  const envelope = envelopeFor(makePayload({ seq: 1, sentAtUtc: before }));
  same(verifyCheckin(envelope, ctx), { ok: false, reason: "clock_skew" });
});

// ---- success path ----

check("a well-formed, correctly signed, in-order check-in is accepted", () => {
  const ctx = baseCtx();
  const payload = makePayload({ seq: 42 });
  const envelope = envelopeFor(payload);
  const r = verifyCheckin(envelope, ctx);
  same(r, { ok: true, payload });
});

check("a different device's key does not verify this device's signature", () => {
  const ctx = baseCtx({
    devices: new Map([
      ["dev-1", { state: "claimed", publicKeyPem: otherPublicKeyPem }], // wrong key on file
    ]),
  });
  const envelope = envelopeFor(makePayload());
  same(verifyCheckin(envelope, ctx), { ok: false, reason: "bad_signature" });
});

// Found in review 2026-09-27: every comparison with NaN is false in JS, so a
// seq or sentAtUtc that only passed a typeof check silently skipped the
// replay and clock-skew guards - a validly signed envelope could be replayed
// forever, or be "on time" with a garbage clock. The box's own buildCheckin
// never produces these, so each envelope below is built normally, then
// corrupted, then signed for real: the forged case, not a box bug.
function forged(mutate) {
  const payload = makePayload();
  mutate(payload);
  return envelopeFor(payload);
}

check("THE FEARED ONE: a seq of NaN, Infinity, -Infinity or 1.5 is malformed, never replayable", () => {
  for (const bad of [NaN, Infinity, -Infinity, 1.5]) {
    const result = verifyCheckin(forged((p) => { p.seq = bad; }), baseCtx({ lastSeq: new Map([["dev-1", 5]]) }));
    same(result, { ok: false, reason: "malformed" }, `seq ${bad}`);
  }
});

check("THE FEARED ONE: a sentAtUtc that does not parse is malformed, never 'on time'", () => {
  for (const bad of ["not-a-real-timestamp", "", "2026-13-45T99:99:99Z"]) {
    same(verifyCheckin(forged((p) => { p.sentAtUtc = bad; }), baseCtx()), { ok: false, reason: "malformed" }, JSON.stringify(bad));
  }
});

check("a first check-in (no lastSeq) with seq 0 or below is a replay - the documented floor is 1", () => {
  for (const bad of [0, -5]) {
    same(verifyCheckin(forged((p) => { p.seq = bad; }), baseCtx()), { ok: false, reason: "replay" }, `seq ${bad}`);
  }
  eq(verifyCheckin(envelopeFor(makePayload({ seq: 1 })), baseCtx()).ok, true, "seq 1 is the first valid one");
});

check("clock skew at exactly the limit in the PAST is accepted too", () => {
  const sentAtUtc = new Date(NOW_MS - CLOCK_SKEW_LIMIT_MS).toISOString();
  eq(verifyCheckin(envelopeFor(makePayload({ sentAtUtc })), baseCtx()).ok, true, "past-side boundary is inclusive");
});

report("checkin verify");
