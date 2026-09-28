// cloud/harness/apiEnroll.harness.mjs — cloud/api/enroll.mjs's `POST /enroll`
// handler.
//
// FEARED: a claim code that ends up in a log line, however deep the branch
// (cloud/CLOUD-LOOP-SPEC.md section B: "The claim code is never logged.");
// a stored public key silently replaced on a key_mismatch; two concurrent
// enrolments of a brand-new box both winning; a reissue that hands back the
// SAME code instead of a fresh one.
//
// This harness signs for real, the same way cloud/harness/enroll.harness.mjs
// and cloud/harness/apiCheckin.harness.mjs do: node:crypto generates real
// Ed25519 key pairs, and this device's deviceId is computed by a real,
// independent re-implementation of agent/device-identity.mjs's own
// derivation (base32(sha256(SPKI DER)[0:16])) -- the SAME derivation
// cloud/api/enroll.mjs's handler must use internally (see its own top
// comment), so a mismatch between this harness and a wrong handler
// implementation would actually be caught, not agreed with.
//
// cloud/api/memoryStore.mjs's createMemoryStore() and
// cloud/contracts/enroll.ts's verifyEnrollment() are themselves stubs today,
// so every check below is expected to FAIL for "not built" (either one, or
// cloud/api/enroll.mjs's own "handler: not built") until all three exist —
// "Harnesses import the memory store for the handler tests, so they will
// fail 'not built' until it exists. That is fine." createMemoryStore() is
// called INSIDE each check's own body, never at module top level, so that
// throw is caught by `check` as one failing check, not an uncaught crash of
// the whole harness.

import { generateKeyPairSync, createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { check, eq, same, report } from "../../harness/_assert.mjs";
import { formatClaimCode } from "../dist/cloud/contracts/claimCode.js";
import { canonicalJson } from "../dist/contracts/deviceCheckin.js";
import { handler, CLAIM_CODE_TTL_MS } from "../api/enroll.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";

console.log("api enroll");

// ---- Real Ed25519 keys ----

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

// ---- A real, independent re-implementation of agent/device-identity.mjs's
// own deviceId derivation -- see cloud/harness/enroll.harness.mjs's own top
// comment for why this is hand-written here rather than imported.
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
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  const hash = createHash("sha256").update(der).digest();
  return base32Encode(hash.subarray(0, 16));
}

const deviceId = realDeviceIdFor(publicKeyPem);

function realVerifySignature(message, signatureB64, publicKeyPemArg) {
  try {
    return cryptoVerify(null, Buffer.from(message, "utf8"), publicKeyPemArg, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

const NOW_UTC = "2026-09-27T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_UTC);
const MAX_SKEW_MS = 300000;
const NONCE_A = "abcdefghij012345";
const NONCE_B = "zyxwvutsrq987654";

function makePayload({ theDeviceId = deviceId, thePublicKeyPem = publicKeyPem, sentAtUtc = NOW_UTC, nonce = NONCE_A } = {}) {
  return { deviceId: theDeviceId, publicKeyPem: thePublicKeyPem, sentAtUtc, nonce };
}

function signWith(payload, key = privateKey) {
  return cryptoSign(null, Buffer.from(canonicalJson(payload), "utf8"), key).toString("base64");
}

function envelopeFor(payload, key = privateKey) {
  return { payload, signatureB64: signWith(payload, key) };
}

function eventFor(envelope) {
  return { body: JSON.stringify(envelope) };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

/** Deterministic, queue-based `randomValues` -- each call returns the next
 *  preset 8-value array, so `formatClaimCode`'s output is exactly
 *  predictable from this test's own point of view, and every array is a
 *  valid input (8 integers, each 0..31), never randomly generated and thus
 *  never accidentally out of range. */
function makeRandomValues(...sequences) {
  let i = 0;
  return (n) => {
    eq(n, 8, "handler must always ask randomValues for exactly 8 values");
    const next = sequences[Math.min(i, sequences.length - 1)];
    i++;
    return next;
  };
}

function baseDeps(overrides = {}) {
  const logs = [];
  let currentNowMs = NOW_MS;
  const deps = {
    store: createMemoryStore(),
    nowMs: () => currentNowMs,
    verifySignature: realVerifySignature,
    randomValues: makeRandomValues([1, 2, 3, 4, 5, 6, 7, 8]),
    allowOpenEnrollment: true,
    maxSkewMs: MAX_SKEW_MS,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs, setNow: (ms) => { currentNowMs = ms; } };
}

function assertRefusalShape(response, logs) {
  const body = parseBody(response);
  same(Object.keys(body).sort(), ["ok", "reason"], "a refusal body must carry only ok and reason");
  for (const entry of logs) {
    same(Object.keys(entry).sort(), ["deviceId", "reason"], "a log entry must carry only reason and deviceId");
  }
}

// ---- pre-verification refusals ----

await check("enrollment_closed gives 403", async () => {
  const { deps, logs } = baseDeps({ allowOpenEnrollment: false });
  const r = await handler(eventFor(envelopeFor(makePayload())), deps);
  eq(r.statusCode, 403);
  same(parseBody(r), { ok: false, reason: "enrollment_closed" });
  same(logs, [{ reason: "enrollment_closed", deviceId: null }]);
  assertRefusalShape(r, logs);
});

await check("a body that is not valid JSON at all gives 400 malformed", async () => {
  const { deps, logs } = baseDeps();
  const r = await handler({ body: "{ this is not json" }, deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "malformed" });
  same(logs, [{ reason: "malformed", deviceId: null }]);
});

await check("valid JSON that is not shaped like an envelope gives 400 malformed", async () => {
  const { deps, logs } = baseDeps();
  const r = await handler(eventFor({ nope: true }), deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "malformed" });
  same(logs, [{ reason: "malformed", deviceId: null }]);
});

await check("bad_device_id gives 400", async () => {
  const { deps, logs } = baseDeps();
  const { publicKey: otherKey, privateKey: otherPriv } = generateKeyPairSync("ed25519");
  const otherPem = otherKey.export({ type: "spki", format: "pem" }).toString();
  // Claim this device's deviceId while presenting a different key entirely.
  const payload = makePayload({ theDeviceId: deviceId, thePublicKeyPem: otherPem });
  const r = await handler(eventFor(envelopeFor(payload, otherPriv)), deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "bad_device_id" });
  same(logs, [{ reason: "bad_device_id", deviceId: null }]);
});

await check("clock_skew gives 400", async () => {
  const { deps, logs } = baseDeps();
  const farAway = new Date(NOW_MS + MAX_SKEW_MS * 10).toISOString();
  const r = await handler(eventFor(envelopeFor(makePayload({ sentAtUtc: farAway }))), deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "clock_skew" });
  same(logs, [{ reason: "clock_skew", deviceId: null }]);
});

await check("bad_signature gives 400", async () => {
  const { deps, logs } = baseDeps();
  const payload = makePayload();
  const r = await handler(eventFor({ payload, signatureB64: "not-a-real-signature" }), deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "bad_signature" });
  same(logs, [{ reason: "bad_signature", deviceId: null }]);
});

// ---- new device: a valid claim code with an expiry 24 h out ----

await check("a brand-new device gets a fresh claim code with a 24h expiry, and is stored unclaimed", async () => {
  const { deps, logs } = baseDeps({ randomValues: makeRandomValues([1, 2, 3, 4, 5, 6, 7, 8]) });
  const r = await handler(eventFor(envelopeFor(makePayload())), deps);
  eq(r.statusCode, 200);
  const body = parseBody(r);
  const expectedCode = formatClaimCode([1, 2, 3, 4, 5, 6, 7, 8]);
  const expectedExpiresUtc = new Date(NOW_MS + CLAIM_CODE_TTL_MS).toISOString();
  same(body, { ok: true, claimed: false, claimCode: expectedCode, expiresUtc: expectedExpiresUtc });
  eq(CLAIM_CODE_TTL_MS, 24 * 60 * 60 * 1000, "CLAIM_CODE_TTL_MS must be exactly 24 hours, in milliseconds");

  const stored = await deps.store.getDevice(deviceId);
  eq(stored.state, "unclaimed");
  eq(stored.publicKeyPem, publicKeyPem);
  eq(stored.code, expectedCode);
  eq(stored.codeExpiresMs, NOW_MS + CLAIM_CODE_TTL_MS);
  eq(stored.installerId, null);
  eq(stored.siteId, null);

  same(logs, [{ reason: null, deviceId }]);
  eq(r.headers["content-type"], "application/json");
});

// ---- same key again -> a fresh code ----

await check("enrolling again with the same key gives a FRESH code, not the same one", async () => {
  const { deps, logs, setNow } = baseDeps({
    randomValues: makeRandomValues([1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, 1]),
  });

  const r1 = await handler(eventFor(envelopeFor(makePayload({ nonce: NONCE_A }))), deps);
  eq(r1.statusCode, 200);
  const firstCode = parseBody(r1).claimCode;

  setNow(NOW_MS + 3600000); // an hour later, so the recomputed expiry actually differs too
  // The box signs its CURRENT time; reusing the first payload's sentAtUtc an
  // hour later is (correctly) refused as clock_skew, which is not this test.
  const r2 = await handler(eventFor(envelopeFor(makePayload({ nonce: NONCE_B, sentAtUtc: new Date(NOW_MS + 3600000).toISOString() }))), deps);
  eq(r2.statusCode, 200);
  const body2 = parseBody(r2);
  const secondCode = body2.claimCode;

  eq(secondCode === firstCode, false, "a reissued code must differ from the first one");
  eq(secondCode, formatClaimCode([8, 7, 6, 5, 4, 3, 2, 1]));
  eq(body2.expiresUtc, new Date(NOW_MS + 3600000 + CLAIM_CODE_TTL_MS).toISOString(), "the reissued expiry is recomputed from the CURRENT now, not the original");

  const stored = await deps.store.getDevice(deviceId);
  eq(stored.state, "unclaimed");
  eq(stored.code, secondCode);
  eq(stored.codeExpiresMs, NOW_MS + 3600000 + CLAIM_CODE_TTL_MS);

  same(logs, [{ reason: null, deviceId }, { reason: null, deviceId }]);
});

await check("re-enrolling a REVOKED device also yields a fresh, unexpired code", async () => {
  const revokedDevice = {
    deviceId,
    state: "revoked",
    publicKeyPem,
    code: null,
    codeExpiresMs: null,
    installerId: "inst-old",
    siteId: "site-old",
  };
  const { deps } = baseDeps({
    store: createMemoryStore({ devices: [revokedDevice] }),
    randomValues: makeRandomValues([2, 2, 2, 2, 2, 2, 2, 2]),
  });
  const r = await handler(eventFor(envelopeFor(makePayload())), deps);
  eq(r.statusCode, 200);
  const body = parseBody(r);
  eq(body.claimed, false);
  eq(body.claimCode, formatClaimCode([2, 2, 2, 2, 2, 2, 2, 2]));

  const stored = await deps.store.getDevice(deviceId);
  eq(stored.state, "unclaimed", "a reissue always moves a revoked device back to unclaimed");
  eq(stored.installerId, null, "reissue clears any previous installerId");
  eq(stored.siteId, null, "an unclaimed device's siteId is always null (store.mjs), never the old site");
});

// ---- Added 2026-09-27 from the cloud-loop review ----

await check("two concurrent re-enrols of a KNOWN unclaimed box give exactly one 200, and its code is the stored one", async () => {
  const known = { deviceId, state: "unclaimed", publicKeyPem, code: "OLD0-OLD0-0", codeExpiresMs: NOW_MS + 1000, installerId: null, siteId: null };
  const { deps } = baseDeps({
    store: createMemoryStore({ devices: [known] }),
    randomValues: makeRandomValues([1, 1, 1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 2]),
  });
  const [r1, r2] = await Promise.all([
    handler(eventFor(envelopeFor(makePayload({ nonce: NONCE_A }))), deps),
    handler(eventFor(envelopeFor(makePayload({ nonce: NONCE_B }))), deps),
  ]);
  same([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  const winner = parseBody(r1.statusCode === 200 ? r1 : r2);
  const loser = parseBody(r1.statusCode === 200 ? r2 : r1);
  same(loser, { ok: false, reason: "wrong_state" });
  eq((await deps.store.getDevice(deviceId)).code, winner.claimCode, "the one code handed out is the one that works");
});

await check("a non-Ed25519 key (RSA) is refused as bad_device_id, even when correctly signed and its id is derived from it", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = makePayload({ theDeviceId: realDeviceIdFor(rsaPem), thePublicKeyPem: rsaPem });
  const { deps } = baseDeps();
  const r = await handler(eventFor(envelopeFor(payload, rsa.privateKey)), deps);
  eq(r.statusCode, 400);
  same(parseBody(r), { ok: false, reason: "bad_device_id" });
  eq(await deps.store.getDevice(realDeviceIdFor(rsaPem)), null, "nothing stored");
});

// ---- claimed -> claimed: true and no code ----

await check("an already-claimed device gets claimed: true and no code, and is left untouched", async () => {
  const claimedRecord = {
    deviceId,
    state: "claimed",
    publicKeyPem,
    code: null,
    codeExpiresMs: null,
    installerId: "inst-1",
    siteId: "site-1",
  };
  const { deps, logs } = baseDeps({ store: createMemoryStore({ devices: [claimedRecord] }) });
  const r = await handler(eventFor(envelopeFor(makePayload())), deps);
  eq(r.statusCode, 200);
  same(parseBody(r), { ok: true, claimed: true, claimCode: null, expiresUtc: null });
  same(logs, [{ reason: null, deviceId }]);

  const stored = await deps.store.getDevice(deviceId);
  same(stored, claimedRecord, "an already-claimed device's record must be left completely untouched");
});

// ---- different key for a known id -> key_mismatch, stored key untouched ----

await check("a different key presented for a known deviceId gives 409 key_mismatch, and the stored key is untouched", async () => {
  const fabricatedRecord = {
    deviceId, // this device's REAL id, but claiming a key that does not actually hash to it
    state: "unclaimed",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nFABRICATED-FOR-THIS-TEST-ONLY\n-----END PUBLIC KEY-----\n",
    code: "PRE-EXST-X",
    codeExpiresMs: NOW_MS + 1000,
    installerId: null,
    siteId: null,
  };
  const { deps, logs } = baseDeps({ store: createMemoryStore({ devices: [fabricatedRecord] }) });
  // The REAL box enrols with its REAL key -- verifyEnrollment accepts this
  // envelope on its own terms (the key really does hash to `deviceId`); the
  // conflict is only between the incoming key and what this handler finds
  // already stored for that same id.
  const r = await handler(eventFor(envelopeFor(makePayload())), deps);
  eq(r.statusCode, 409);
  same(parseBody(r), { ok: false, reason: "key_mismatch" });
  same(logs, [{ reason: "key_mismatch", deviceId }]);

  const stored = await deps.store.getDevice(deviceId);
  same(stored, fabricatedRecord, "a stored key must never be replaced on a key_mismatch");
});

// ---- two concurrent enrols of a new box -> exactly one 200 ----

await check("two concurrent enrolments of a brand-new box give exactly one 200 and one 409 wrong_state", async () => {
  const { deps } = baseDeps();
  const event = eventFor(envelopeFor(makePayload()));
  const [r1, r2] = await Promise.all([handler(event, deps), handler(event, deps)]);
  const statusCodes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
  same(statusCodes, [200, 409], "exactly one concurrent identical enrolment must win");
  const loser = r1.statusCode === 409 ? r1 : r2;
  same(parseBody(loser), { ok: false, reason: "wrong_state" });
});

// ---- the claim code is absent from every log entry, across every branch that ever produces one ----

await check("THE FEARED ONE: the claim code never appears in a log entry, across every branch", async () => {
  const scenarios = [];

  {
    const { deps, logs } = baseDeps({ randomValues: makeRandomValues([3, 1, 4, 1, 5, 9, 2, 6]) });
    const r = await handler(eventFor(envelopeFor(makePayload())), deps);
    const code = parseBody(r).claimCode;
    scenarios.push({ label: "new device", logs, needle: code });
  }
  {
    const revoked = { deviceId, state: "revoked", publicKeyPem, code: null, codeExpiresMs: null, installerId: null, siteId: null };
    const { deps, logs } = baseDeps({
      store: createMemoryStore({ devices: [revoked] }),
      randomValues: makeRandomValues([7, 7, 7, 7, 7, 7, 7, 7]),
    });
    const r = await handler(eventFor(envelopeFor(makePayload())), deps);
    const code = parseBody(r).claimCode;
    scenarios.push({ label: "reissue", logs, needle: code });
  }
  {
    const claimedRecord = { deviceId, state: "claimed", publicKeyPem, code: null, codeExpiresMs: null, installerId: "inst-1", siteId: "site-1" };
    const { deps, logs } = baseDeps({ store: createMemoryStore({ devices: [claimedRecord] }) });
    await handler(eventFor(envelopeFor(makePayload())), deps);
    scenarios.push({ label: "already claimed", logs, needle: null });
  }

  for (const { label, logs, needle } of scenarios) {
    eq(logs.length, 1, `${label}: exactly one log line`);
    same(Object.keys(logs[0]).sort(), ["deviceId", "reason"], `${label}: a log entry must carry only reason and deviceId`);
    if (needle) {
      const text = JSON.stringify(logs[0]);
      eq(text.includes(needle), false, `${label}: log entry ${text} must never contain the claim code ${JSON.stringify(needle)}`);
    }
  }
});

report("api enroll");
