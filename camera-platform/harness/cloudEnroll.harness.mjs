/**
 * harness/cloudEnroll.harness.mjs -- agent/cloud-enroll.mjs, the box's own
 * half of cloud/CLOUD-LOOP-SPEC.md section C ("The box: `camctl enroll` and
 * a real `camctl checkin`").
 *
 * This harness never imports anything from cloud/ (build brief: "Do not
 * touch cloud/ at all") -- every check below either exercises
 * agent/cloud-enroll.mjs directly with a fake fetch and a fake identity
 * (the same shape harness/checkin.harness.mjs already uses for
 * agent/checkin.mjs), or, where the wire format itself must be pinned,
 * verifies a signature independently with node:crypto against
 * canonicalJson(payload) -- exactly the text cloud/contracts/enroll.ts
 * verifies, without depending on that file to do it.
 *
 * The failures feared, in order (build rule 19, "test the failure you fear,
 * not the happy path"): an enrolment actually leaving the box over
 * http://; the device's public OR private key ending up in
 * cloud-enrollment.json; a claim code slipping into a console.log/error/warn
 * call anywhere other than the one place camctl.mjs prints it (not this
 * file); a network or server-side failure escaping as a thrown exception
 * instead of a named outcome; and a signed envelope that this box would send
 * failing to verify under a genuine, independent Ed25519 check.
 */
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, eq, same, throws, report } from "./_assert.mjs";
import { canonicalJson } from "../dist/deviceCheckin.js";
import { buildEnrollPayload, enroll, CLOUD_ENROLLMENT_FILE } from "../agent/cloud-enroll.mjs";

console.log("cloud enroll");

/** cloud/contracts/enroll.ts's own NONCE_PATTERN, spelled out again here
 *  rather than imported -- this harness must never depend on cloud/, and
 *  the spec (cloud/CLOUD-LOOP-SPEC.md section A) fixes this shape in text:
 *  16 to 64 characters of [A-Za-z0-9_-]. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const root = await mkdtemp(join(tmpdir(), "camplat-cloud-enroll-"));
let dirCounter = 0;
async function freshStateDir() {
  const dir = join(root, `state-${dirCounter++}`);
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  return dir;
}
/** A stateDir path that is never created -- used to force a write failure
 *  without touching anything outside this harness's own temp root. */
function missingStateDir() {
  return join(root, `missing-${dirCounter++}`);
}

/** A real Ed25519 identity, generated here and never written to disk --
 *  mirrors harness/checkin.harness.mjs's own fakeIdentity(). */
function fakeIdentity(deviceId = "device-test-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    deviceId,
    publicKeyPem,
    loadOrCreateIdentity: async () => ({ deviceId, publicKeyPem, createdAtUtc: "2026-09-01T00:00:00.000Z" }),
    signWithIdentity: async (_stateDir, message) => cryptoSign(null, message, privateKey),
  };
}

/** `body === null` gives an empty response body text (the "no body at all"
 *  case); otherwise the body is JSON-stringified, exactly what a real HTTP
 *  client hands `enroll()` via `response.text()`. */
function fakeFetch(status, body = null, { calls = [] } = {}) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { status, text: async () => (body === null ? "" : JSON.stringify(body)) };
  };
}

const ENROLL_URL = "https://cloud.example.test/enroll";

/* ── buildEnrollPayload: the pure contract shape ───────────────────────── */

check("buildEnrollPayload builds exactly the contract shape, with a nonce matching the cloud's NONCE_PATTERN", () => {
  const now = () => new Date("2026-09-28T00:00:00.000Z");
  const payload = buildEnrollPayload({ deviceId: "dev-1", publicKeyPem: "PEM-TEXT-STANDS-IN", now });
  same(Object.keys(payload).sort(), ["deviceId", "nonce", "publicKeyPem", "sentAtUtc"]);
  eq(payload.deviceId, "dev-1");
  eq(payload.publicKeyPem, "PEM-TEXT-STANDS-IN");
  eq(payload.sentAtUtc, "2026-09-28T00:00:00.000Z");
  eq(NONCE_PATTERN.test(payload.nonce), true, `nonce ${JSON.stringify(payload.nonce)} must match [A-Za-z0-9_-]{16,64}`);
});

check("buildEnrollPayload generates a fresh nonce every call -- two enrolment attempts never sign identical text", () => {
  const a = buildEnrollPayload({ deviceId: "dev-1", publicKeyPem: "PEM" });
  const b = buildEnrollPayload({ deviceId: "dev-1", publicKeyPem: "PEM" });
  if (a.nonce === b.nonce) throw new Error(`two independent calls produced the same nonce: ${a.nonce}`);
});

check("buildEnrollPayload refuses a missing deviceId, publicKeyPem, or nonce rather than guessing (build rule 10)", () => {
  throws(() => buildEnrollPayload({ deviceId: "", publicKeyPem: "PEM" }), "empty deviceId");
  throws(() => buildEnrollPayload({ deviceId: "dev-1", publicKeyPem: "" }), "empty publicKeyPem");
  throws(() => buildEnrollPayload({ deviceId: "dev-1", publicKeyPem: "PEM", nonce: "" }), "empty nonce");
  throws(() => buildEnrollPayload({ publicKeyPem: "PEM" }), "missing deviceId entirely");
});

/* ── enroll(): https-only, exactly like agent/checkin.mjs's sendCheckin ── */

await check("http:// is refused outright, before any network call or any file write", async () => {
  const stateDir = await freshStateDir();
  const calls = [];
  const result = await enroll({ stateDir, url: "http://cloud.example.test/enroll", fetchFn: fakeFetch(200, {}, { calls }), identity: fakeIdentity() });
  eq(result.outcome, "refused_insecure_url");
  eq(calls.length, 0, "fetch must never be called");
  let wrote = true;
  try {
    await readFile(join(stateDir, CLOUD_ENROLLMENT_FILE));
  } catch {
    wrote = false;
  }
  eq(wrote, false, "nothing written when the url is refused");
});

await check("a url that does not even parse gives bad_url, nothing sent", async () => {
  const calls = [];
  const result = await enroll({ stateDir: await freshStateDir(), url: "not a url at all", fetchFn: fakeFetch(200, {}, { calls }), identity: fakeIdentity() });
  eq(result.outcome, "bad_url");
  eq(calls.length, 0, "fetch must never be called");
});

/* ── enroll(): network and server-side failures are outcomes, not throws ── */

await check("a network failure comes back as an outcome, never a throw", async () => {
  const result = await enroll({
    stateDir: await freshStateDir(),
    url: ENROLL_URL,
    fetchFn: async () => { throw new Error("ECONNREFUSED"); },
    identity: fakeIdentity(),
  });
  eq(result.outcome, "network_error");
  eq(result.message.includes("ECONNREFUSED"), true, "the underlying reason is preserved");
});

await check("5xx gives server_error; 4xx gives rejected with the cloud's own reason -- both outcomes, never a throw", async () => {
  for (const status of [500, 503]) {
    const result = await enroll({ stateDir: await freshStateDir(), url: ENROLL_URL, fetchFn: fakeFetch(status), identity: fakeIdentity() });
    eq(result.outcome, "server_error", `status ${status}`);
    eq(result.status, status);
  }
  const rejected = await enroll({
    stateDir: await freshStateDir(),
    url: ENROLL_URL,
    fetchFn: fakeFetch(403, { ok: false, reason: "enrollment_closed" }),
    identity: fakeIdentity(),
  });
  eq(rejected.outcome, "rejected");
  eq(rejected.status, 403);
  eq(rejected.reason, "enrollment_closed");
});

await check("a 2xx body that does not have the promised shape gives bad_response, never a throw or a silent guess", async () => {
  const badBodies = [
    null,
    {},
    { ok: true },
    { ok: true, claimed: false }, // missing claimCode/expiresUtc
    { ok: true, claimed: false, claimCode: "", expiresUtc: "2026-09-29T00:00:00.000Z" }, // empty claimCode
    { ok: true, claimed: false, claimCode: "CODE", expiresUtc: "not-a-date" },
    { ok: true, claimed: true, claimCode: "should-be-null", expiresUtc: null },
    { ok: true, claimed: true, claimCode: null, expiresUtc: "should-be-null" },
  ];
  for (const body of badBodies) {
    const result = await enroll({ stateDir: await freshStateDir(), url: ENROLL_URL, fetchFn: fakeFetch(200, body), identity: fakeIdentity() });
    eq(result.outcome, "bad_response", `body ${JSON.stringify(body)}`);
  }
});

await check("an identity that refuses to load (agent/device-identity.mjs's own refusal shape) gives compose_failed, not a throw, and nothing is sent", async () => {
  const calls = [];
  const brokenIdentity = {
    loadOrCreateIdentity: async () => {
      const err = new Error("device-identity.json refused: the file is not valid JSON");
      err.code = "DEVICE_IDENTITY_REFUSED";
      throw err;
    },
    signWithIdentity: async () => { throw new Error("unreachable -- loadOrCreateIdentity should have already thrown"); },
  };
  const result = await enroll({ stateDir: await freshStateDir(), url: ENROLL_URL, fetchFn: fakeFetch(200, {}, { calls }), identity: brokenIdentity });
  eq(result.outcome, "compose_failed");
  eq(calls.length, 0, "nothing sent when the envelope could not even be built");
});

await check("a state directory that cannot be written to gives write_failed, not a throw -- the cloud already accepted this box", async () => {
  const result = await enroll({
    stateDir: missingStateDir(),
    url: ENROLL_URL,
    fetchFn: fakeFetch(200, { ok: true, claimed: false, claimCode: "1234-5678-K", expiresUtc: "2026-09-29T00:00:00.000Z" }),
    identity: fakeIdentity(),
  });
  eq(result.outcome, "write_failed");
});

/* ── enroll(): the happy paths, and what they actually send and write ──── */

await check("a fresh claim code: 'enrolled' is returned, cloud-enrollment.json holds exactly the promised fields, and the envelope actually sent verifies under an independent node:crypto check", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity("device-abc");
  const calls = [];
  const now = () => new Date("2026-09-28T00:00:00.000Z");
  const responseBody = { ok: true, claimed: false, claimCode: "ABCD-EFGH-A", expiresUtc: "2026-09-29T00:00:00.000Z" };

  const result = await enroll({ stateDir, url: ENROLL_URL, fetchFn: fakeFetch(200, responseBody, { calls }), identity: id, now });
  same(result, { outcome: "enrolled", deviceId: "device-abc", claimCode: "ABCD-EFGH-A", expiresUtc: "2026-09-29T00:00:00.000Z" });

  eq(calls.length, 1, "exactly one POST");
  eq(calls[0].opts.method, "POST");
  const sentBody = JSON.parse(calls[0].opts.body);
  same(Object.keys(sentBody).sort(), ["payload", "signatureB64"], "the envelope carries only payload and signatureB64");
  same(Object.keys(sentBody.payload).sort(), ["deviceId", "nonce", "publicKeyPem", "sentAtUtc"]);
  eq(sentBody.payload.deviceId, "device-abc");
  eq(sentBody.payload.publicKeyPem, id.publicKeyPem);
  eq(NONCE_PATTERN.test(sentBody.payload.nonce), true, "the sent nonce must match the cloud's NONCE_PATTERN");

  // THE FEARED ONE for the wire format: independently verify, with
  // node:crypto alone, that the signature actually sent covers
  // canonicalJson(payload) -- the exact text cloud/contracts/enroll.ts's
  // verifyEnrollment checks -- without importing anything from cloud/.
  const verifies = cryptoVerify(
    null,
    Buffer.from(canonicalJson(sentBody.payload), "utf8"),
    id.publicKeyPem,
    Buffer.from(sentBody.signatureB64, "base64"),
  );
  eq(verifies, true, "the signature sent must verify against canonicalJson(payload) under real Ed25519");
  // And a tampered payload must NOT verify, so this check is not vacuous.
  const tampered = { ...sentBody.payload, deviceId: "device-someone-else" };
  eq(
    cryptoVerify(null, Buffer.from(canonicalJson(tampered), "utf8"), id.publicKeyPem, Buffer.from(sentBody.signatureB64, "base64")),
    false,
    "a tampered payload must fail verification",
  );

  const written = JSON.parse(await readFile(join(stateDir, CLOUD_ENROLLMENT_FILE), "utf8"));
  same(written, {
    url: ENROLL_URL,
    deviceId: "device-abc",
    claimed: false,
    claimCode: "ABCD-EFGH-A",
    expiresUtc: "2026-09-29T00:00:00.000Z",
    atUtc: "2026-09-28T00:00:00.000Z",
  });
});

await check("already claimed: 'already_claimed' is returned and claimCode/expiresUtc are written as null", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity("device-owned");
  const now = () => new Date("2026-09-28T01:00:00.000Z");

  const result = await enroll({
    stateDir,
    url: ENROLL_URL,
    fetchFn: fakeFetch(200, { ok: true, claimed: true, claimCode: null, expiresUtc: null }),
    identity: id,
    now,
  });
  same(result, { outcome: "already_claimed", deviceId: "device-owned" });

  const written = JSON.parse(await readFile(join(stateDir, CLOUD_ENROLLMENT_FILE), "utf8"));
  same(written, {
    url: ENROLL_URL,
    deviceId: "device-owned",
    claimed: true,
    claimCode: null,
    expiresUtc: null,
    atUtc: "2026-09-28T01:00:00.000Z",
  });
});

/* ── THE FEARED ONE: no key material, ever, in the written file ────────── */

await check("THE FEARED ONE: cloud-enrollment.json never carries any key material, public or private", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity("device-secret-check");
  await enroll({
    stateDir,
    url: ENROLL_URL,
    fetchFn: fakeFetch(200, { ok: true, claimed: false, claimCode: "1234-5678-K", expiresUtc: "2026-09-29T00:00:00.000Z" }),
    identity: id,
  });
  const text = await readFile(join(stateDir, CLOUD_ENROLLMENT_FILE), "utf8");
  for (const marker of ["PRIVATE", "BEGIN", "PUBLIC KEY", id.publicKeyPem]) {
    if (text.includes(marker)) throw new Error(`${CLOUD_ENROLLMENT_FILE} must never contain ${JSON.stringify(marker.slice(0, 24))}`);
  }
  same(Object.keys(JSON.parse(text)).sort(), ["atUtc", "claimCode", "claimed", "deviceId", "expiresUtc", "url"]);
});

/* ── THE FEARED ONE: the claim code is printed (by camctl) but never
 * logged anywhere else -- enroll() itself must be silent. ──────────────── */

await check("THE FEARED ONE: enroll() never calls console.log/error/warn -- printing the claim code is camctl's job alone, not this module's", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const calls = [];
  console.log = (...a) => calls.push(["log", ...a]);
  console.error = (...a) => calls.push(["error", ...a]);
  console.warn = (...a) => calls.push(["warn", ...a]);
  try {
    await enroll({
      stateDir: await freshStateDir(),
      url: ENROLL_URL,
      fetchFn: fakeFetch(200, { ok: true, claimed: false, claimCode: "1234-5678-K", expiresUtc: "2026-09-29T00:00:00.000Z" }),
      identity: fakeIdentity(),
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  eq(calls.length, 0, `enroll() must never log anything itself, got ${JSON.stringify(calls)}`);
});

// Added 2026-09-27 from the review: camctl prints the claim code verbatim on
// the installer's terminal, so a code that is not the real XXXX-XXXX-C shape
// (a terminal escape, a path, a long string) is refused, never printed/saved.
await check("a claim code that is not the XXXX-XXXX-C shape is bad_response, and nothing is written", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const claimCode of ["1234-5678-K\u001b[2J", "1234-5678", "1234-5678-KK", "ILOU-0000-0", "../../etc/passwd", "1234-5678-k"]) {
    const stateDir = await freshStateDir();
    const result = await enroll({
      stateDir,
      url: ENROLL_URL,
      fetchFn: fakeFetch(200, { ok: true, claimed: false, claimCode, expiresUtc: "2026-09-29T00:00:00.000Z" }),
      identity: fakeIdentity(),
    });
    eq(result.outcome, "bad_response", JSON.stringify(claimCode));
    eq(existsSync(join(stateDir, "cloud-enrollment.json")), false, `nothing written for ${JSON.stringify(claimCode)}`);
  }
});

report("cloud enroll");
