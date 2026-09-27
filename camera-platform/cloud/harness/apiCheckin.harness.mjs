// cloud/harness/apiCheckin.harness.mjs — cloud/api/checkin.mjs's `POST /checkin`
// handler.
//
// FEARED: a refusal response or log line that echoes the payload, the
// signature or a public key back out (cloud/CLOUD-API-SPEC.md: "An error
// body is { ok: false, reason } and never includes a payload, a signature,
// a key or a stack trace"); a status code that does not match the table; a
// concurrent double-accept.
//
// This harness signs for real, the same way
// cloud/harness/checkinVerify.harness.mjs does: node:crypto generates a real
// Ed25519 key pair, deviceCheckin's buildCheckin() builds a real payload,
// checkinDigest() is signed for real.
//
// cloud/api/memoryStore.mjs's createMemoryStore() is itself a stub today
// ("createMemoryStore: not built"), so every check below is expected to FAIL
// for that reason (or for cloud/api/checkin.mjs's own "handler: not built")
// until both are built — "Harnesses import the memory store for the handler
// tests, so they will fail 'not built' until it exists. That is fine."
// createMemoryStore() is called INSIDE each check's own body, never at
// module top level, so that throw is caught by `check` as one failing
// check, not an uncaught crash of the whole harness.

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { check, eq, same, report } from "../../harness/_assert.mjs";
import { buildCheckin, checkinDigest } from "../dist/contracts/deviceCheckin.js";
import { handler, MAX_BODY_BYTES, CHECKIN_STATUS_BY_REASON } from "../api/checkin.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";

console.log("api checkin");

const NOW_UTC = "2026-09-27T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_UTC);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function realVerifySignature(digestHex, signatureB64, publicKeyPemArg) {
  try {
    return cryptoVerify(null, Buffer.from(digestHex, "utf8"), publicKeyPemArg, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

const BASE_FACTS = {
  version: "release-secret-marker-999",
  uptimeSec: 3600,
  cameras: [],
  drives: [],
  footageHeld: { hours: 12.5, basis: "segments", refusedReason: null },
  detector: { capacityFps: 8, minConfidence: 0.5, motionGateEnabled: true },
  knownObjects: { active: 3, lapsed: 1 },
  lastSealedUtc: "2026-09-26T23:50:00.000Z",
};

function makePayload({ deviceId = "dev-1", seq = 1, sentAtUtc = NOW_UTC } = {}) {
  return buildCheckin(BASE_FACTS, { deviceId, nowUtc: sentAtUtc, seq });
}

function signWith(payload, key = privateKey) {
  return cryptoSign(null, Buffer.from(checkinDigest(payload), "utf8"), key).toString("base64");
}

function envelopeFor(payload, key = privateKey) {
  return { payload, signature: signWith(payload, key) };
}

function eventFor(envelope, { isBase64Encoded = false } = {}) {
  const text = JSON.stringify(envelope);
  return {
    body: isBase64Encoded ? Buffer.from(text, "utf8").toString("base64") : text,
    isBase64Encoded,
  };
}

const claimedDevice = (deviceId = "dev-1", overrides = {}) => ({
  deviceId,
  state: "claimed",
  publicKeyPem,
  code: null,
  codeExpiresMs: null,
  installerId: "inst-1",
  siteId: "site-1",
  ...overrides,
});

function baseDeps(overrides = {}) {
  const logs = [];
  const deps = {
    store: createMemoryStore({ devices: [claimedDevice()] }),
    nowMs: () => NOW_MS,
    verifySignature: realVerifySignature,
    principalOf: () => null,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

function assertNoLeak(response, logs) {
  const body = parseBody(response);
  same(Object.keys(body).sort(), ["ok", "reason"], "a refusal body must carry only ok and reason");
  const bodyText = response.body;
  if (bodyText.includes(publicKeyPem)) throw new Error("a refusal body must never contain the device's public key");
  if (bodyText.includes("release-secret-marker-999")) throw new Error("a refusal body must never contain health data");
  for (const entry of logs) {
    same(Object.keys(entry).sort(), ["deviceId", "reason"], "a log entry must carry only reason and deviceId");
    const entryText = JSON.stringify(entry);
    if (entryText.includes(publicKeyPem)) throw new Error("a log line must never contain a public key");
    if (entryText.includes("release-secret-marker-999")) throw new Error("a log line must never contain health data");
  }
}

// ---- body-level refusals, before verifyCheckin ever runs ----

await check(`too_large: a body over ${MAX_BODY_BYTES} bytes gives ${CHECKIN_STATUS_BY_REASON.too_large}`, async () => {
  const { deps, logs } = baseDeps();
  const event = { body: "x".repeat(MAX_BODY_BYTES + 1) };
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.too_large);
  same(parseBody(r), { ok: false, reason: "too_large" });
  assertNoLeak(r, logs);
  same(logs, [{ reason: "too_large", deviceId: null }]);
});

await check("malformed: a body that is not valid JSON at all gives 400", async () => {
  const { deps, logs } = baseDeps();
  const event = { body: "{ this is not json" };
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.malformed);
  same(parseBody(r), { ok: false, reason: "malformed" });
  same(logs, [{ reason: "malformed", deviceId: null }]);
});

await check("malformed: valid JSON that is not shaped like an envelope gives 400", async () => {
  const { deps, logs } = baseDeps();
  const event = { body: JSON.stringify({ nope: true }) };
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.malformed);
  same(parseBody(r), { ok: false, reason: "malformed" });
  same(logs, [{ reason: "malformed", deviceId: null }]);
});

// ---- every verifyCheckin reason gives its status code ----

await check("unsupported_version gives 400", async () => {
  const { deps, logs } = baseDeps();
  const payload = makePayload();
  const event = eventFor(envelopeFor({ ...payload, checkinVersion: 2 }));
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.unsupported_version);
  same(parseBody(r), { ok: false, reason: "unsupported_version" });
  assertNoLeak(r, logs);
  same(logs, [{ reason: "unsupported_version", deviceId: "dev-1" }]);
});

await check("unknown_device gives 401", async () => {
  const { deps, logs } = baseDeps();
  const event = eventFor(envelopeFor(makePayload({ deviceId: "dev-ghost" })));
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.unknown_device);
  same(parseBody(r), { ok: false, reason: "unknown_device" });
  assertNoLeak(r, logs);
  same(logs, [{ reason: "unknown_device", deviceId: "dev-ghost" }]);
});

await check("not_claimed gives 403", async () => {
  const { deps, logs } = baseDeps({ store: createMemoryStore({ devices: [claimedDevice("dev-1", { state: "unclaimed" })] }) });
  const event = eventFor(envelopeFor(makePayload()));
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.not_claimed);
  same(parseBody(r), { ok: false, reason: "not_claimed" });
  assertNoLeak(r, logs);
});

await check("bad_signature gives 401", async () => {
  const { deps, logs } = baseDeps();
  const payload = makePayload();
  const event = eventFor({ payload, signature: "not-a-real-signature" });
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.bad_signature);
  same(parseBody(r), { ok: false, reason: "bad_signature" });
  assertNoLeak(r, logs);
});

await check("replay (from verifyCheckin's own lastSeq check) gives 409", async () => {
  const { deps, logs } = baseDeps();
  await deps.store.acceptCheckin("dev-1", 5, makePayload({ seq: 5 }), NOW_MS);
  const event = eventFor(envelopeFor(makePayload({ seq: 5 })));
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.replay);
  same(parseBody(r), { ok: false, reason: "replay" });
  assertNoLeak(r, logs);
});

await check("clock_skew gives 422", async () => {
  const { deps, logs } = baseDeps();
  const farAway = new Date(NOW_MS + 6 * 60 * 1000).toISOString();
  const event = eventFor(envelopeFor(makePayload({ sentAtUtc: farAway })));
  const r = await handler(event, deps);
  eq(r.statusCode, CHECKIN_STATUS_BY_REASON.clock_skew);
  same(parseBody(r), { ok: false, reason: "clock_skew" });
  assertNoLeak(r, logs);
});

// ---- base64 body is accepted ----

await check("a base64-encoded body is decoded and a well-formed check-in is accepted", async () => {
  const { deps, logs } = baseDeps();
  const payload = makePayload({ seq: 1 });
  const event = eventFor(envelopeFor(payload), { isBase64Encoded: true });
  const r = await handler(event, deps);
  eq(r.statusCode, 200);
  same(parseBody(r), { ok: true, seq: 1 });
  same(logs, [{ reason: null, deviceId: "dev-1" }]);
});

// ---- concurrency: two concurrent identical envelopes give one 200 and one 409 ----

await check("two concurrent identical envelopes give exactly one 200 and one 409 replay", async () => {
  const { deps } = baseDeps();
  const event = eventFor(envelopeFor(makePayload({ seq: 1 })));
  const [r1, r2] = await Promise.all([handler(event, deps), handler(event, deps)]);
  const statusCodes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
  same(statusCodes, [200, 409], "exactly one concurrent identical check-in must win");
  const loser = r1.statusCode === 409 ? r1 : r2;
  same(parseBody(loser), { ok: false, reason: "replay" });
});

// ---- no payload, signature or key ever appears in a refusal, across every reason ----

await check("THE FEARED ONE: no refusal body or log line ever carries a payload, a signature or a key, across every reason", async () => {
  const scenarios = [
    ["too_large", { body: "x".repeat(MAX_BODY_BYTES + 1) }],
    ["malformed", { body: "not json" }],
    ["unsupported_version", eventFor(envelopeFor({ ...makePayload(), checkinVersion: 99 }))],
    ["unknown_device", eventFor(envelopeFor(makePayload({ deviceId: "dev-ghost-2" })))],
    ["bad_signature", eventFor({ payload: makePayload(), signature: "garbage-signature-value" })],
  ];
  for (const [expectedReason, event] of scenarios) {
    const { deps, logs } = baseDeps();
    const r = await handler(event, deps);
    same(parseBody(r), { ok: false, reason: expectedReason }, `scenario ${expectedReason}`);
    assertNoLeak(r, logs);
  }
});

report("api checkin");
