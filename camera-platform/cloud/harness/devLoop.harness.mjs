// cloud/harness/devLoop.harness.mjs — the whole loop, end to end, for real
// (cloud/CLOUD-LOOP-SPEC.md section E, "the loop (devLoop harness)"): a fresh
// box identity enrols against a REAL https listener (cloud/dev/server.mjs,
// run in-process via its own `startServer`), an installer claims it with the
// code that came back, a signed check-in is accepted, and `GET /fleet` shows
// the box "online" with a health summary -- no faked transport, no faked
// crypto anywhere in this file.
//
// FEARED: the loop passing only because something along the way was faked --
// a `verifySignature` that always returns true, a claim code accepted
// unchecked, a `/fleet` that reports "online" without a real check-in ever
// having been accepted. Every step below goes over a REAL TLS socket (a
// throwaway self-signed certificate this file asks `openssl` to generate,
// IP SAN 127.0.0.1, in a fresh temp directory -- never one committed to this
// public repo), and every signature is a REAL Ed25519 signature from a
// freshly generated test box identity, verified by cloud/dev/server.mjs's
// own real `node:crypto` verification -- the same one a real box's
// signature would have to pass.
//
// `openssl` not on PATH is NOT a pass: this harness prints
// "SKIPPED: openssl not found" and exits non-zero (cloud/CLOUD-LOOP-SPEC.md
// section E), never a silent, vacuous success.
//
// Uses NODE_EXTRA_CA_CERTS-free https requests: the throwaway cert's own PEM
// text is passed as `ca` on each `https.request` call below, never through
// an environment variable.

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { canonicalJson, buildCheckin, checkinDigest } from "../dist/contracts/deviceCheckin.js";
import { startServer } from "../dev/server.mjs";
// The box's REAL sender and enroller (not a hand-built envelope): the live
// bench run on 2026-09-28 found the two sides disagreeing on the check-in
// wire format while each side's own tests passed. These need the box's own
// dist/ built too (tsc -p . from camera-platform).
import { sendCheckin } from "../../agent/checkin.mjs";
import { enroll as boxEnroll } from "../../agent/cloud-enroll.mjs";

console.log("dev loop");

// ---- openssl availability: checked BEFORE anything else runs, and before
// any temp directory is even created. Not on PATH -> SKIPPED, exit 1. ----

function opensslIsOnPath() {
  const probe = spawnSync("openssl", ["version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

if (!opensslIsOnPath()) {
  console.log("SKIPPED: openssl not found");
  process.exit(1);
}

// ---- a throwaway self-signed cert, IP SAN 127.0.0.1, in a fresh temp dir ----

const tmpDir = await mkdtemp(path.join(tmpdir(), "cloud-loop-"));
const certPath = path.join(tmpDir, "dev-cert.pem");
const keyPath = path.join(tmpDir, "dev-key.pem");

function generateDevCert() {
  const r = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  if (r.status !== 0) {
    const detail = r.stderr ? r.stderr.toString() : (r.error?.message ?? "unknown error");
    throw new Error(`openssl failed to generate the throwaway dev certificate: ${detail}`);
  }
}

// ---- the test box's own identity: a real Ed25519 key pair, and the SAME
// deviceId derivation agent/device-identity.mjs uses (base32(sha256(SPKI
// DER)[0:16]), uppercase, no padding) -- copied here, not imported, since a
// harness proving the cloud and a real box agree on this derivation must
// compute it independently, the same way cloud/harness/enroll.harness.mjs's
// own deviceIdOf fakes do. ----

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
function deriveDeviceId(publicKeyDer) {
  return base32Encode(createHash("sha256").update(publicKeyDer).digest().subarray(0, 16));
}

// ---- a small https client: real TLS, the throwaway cert's own PEM passed
// as `ca` on every call (NODE_EXTRA_CA_CERTS-free), never a hostname/CA
// override baked in anywhere but here. ----

function httpsRequestJson({ baseUrl, method, requestPath, headers = {}, body, caCertPem }) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, baseUrl);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        ca: caCertPem,
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, text, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---- fixed check-in facts for this harness's one test box -- shape only
// matters here, not the values (contracts/deviceCheckin.ts's buildCheckin
// validates and reshapes them). ----

const CHECKIN_FACTS = {
  version: "dev-loop-harness",
  uptimeSec: 42,
  cameras: [],
  drives: [],
  footageHeld: { hours: null, basis: null, refusedReason: null },
  detector: { capacityFps: null, minConfidence: null, motionGateEnabled: null },
  knownObjects: { active: null, lapsed: null },
  lastSealedUtc: null,
};

let server = null;

try {
  generateDevCert();
  const caCertPem = await readFile(certPath, "utf8");

  // ---- a non-loopback --host is refused, before anything is bound ----

  await check("startServer refuses a non-loopback host", async () => {
    let threw = false;
    let refusedServer = null;
    try {
      refusedServer = await startServer({ port: 0, host: "0.0.0.0", cert: certPath, key: keyPath });
    } catch {
      threw = true;
    }
    if (refusedServer) await refusedServer.close();
    eq(threw, true, "startServer must reject a non-loopback --host, never bind to it");
  });

  // ---- the real server this whole loop runs against, on a free port ----

  server = await startServer({ port: 0, host: "127.0.0.1", cert: certPath, key: keyPath });
  eq(typeof server.token, "string", "startServer must hand back a dev bearer token");
  if (server.token.length === 0) throw new Error("the dev bearer token must not be empty");

  const request = (opts) => httpsRequestJson({ baseUrl: server.url, caCertPem, ...opts });

  // ---- the test box's own identity ----

  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeyDer = keyPair.publicKey.export({ type: "spki", format: "der" });
  const deviceId = deriveDeviceId(publicKeyDer);

  function signedEnrollEnvelope() {
    const payload = {
      deviceId,
      publicKeyPem,
      sentAtUtc: new Date().toISOString(),
      nonce: randomBytes(24).toString("base64url"), // 32 chars of [A-Za-z0-9_-]: inside enroll's 16..64 nonce shape
    };
    const signatureB64 = cryptoSign(null, Buffer.from(canonicalJson(payload), "utf8"), keyPair.privateKey).toString(
      "base64",
    );
    return { payload, signatureB64 };
  }

  // ---- GET /fleet without a token is refused, before this device exists at
  // all -- proves the check is on the TOKEN, not on there being nothing yet
  // to list. ----

  await check("GET /fleet without the bearer token is refused with 401 no_principal", async () => {
    const r = await request({ method: "GET", requestPath: "/fleet" });
    eq(r.statusCode, 401);
    same(r.json, { ok: false, reason: "no_principal" });
  });

  // ---- camctl enroll: the box introduces itself and gets a claim code ----

  let claimCode;
  await check("a fresh box identity enrols over real TLS and receives a claim code", async () => {
    const r = await request({ method: "POST", requestPath: "/enroll", body: signedEnrollEnvelope() });
    eq(r.statusCode, 200);
    eq(r.json?.ok, true, `enrol must succeed for a fresh identity with enrolment open, got ${r.text}`);
    eq(r.json?.claimed, false, "a fresh device has nothing claimed yet");
    eq(typeof r.json?.claimCode, "string", true);
    eq(typeof r.json?.expiresUtc, "string", true);
    claimCode = r.json.claimCode;
  });

  // ---- re-enrolling the same box (before it is claimed) gives a FRESH code ----

  await check("re-enrolling the same (still-unclaimed) box gives a fresh claim code", async () => {
    const r = await request({ method: "POST", requestPath: "/enroll", body: signedEnrollEnvelope() });
    eq(r.statusCode, 200);
    eq(r.json?.ok, true);
    eq(typeof r.json?.claimCode, "string", true);
    eq(r.json.claimCode === claimCode, false, "re-enrolling must yield a FRESH code, not the one already issued");
    claimCode = r.json.claimCode; // the earlier code is now stale; the claim below uses the latest one
  });

  // ---- an installer claims the box with the returned code ----

  await check("an installer_tech claims the box with the returned code, using the dev bearer token", async () => {
    const r = await request({
      method: "POST",
      requestPath: "/claim",
      headers: { authorization: `Bearer ${server.token}` },
      body: { code: claimCode },
    });
    eq(r.statusCode, 200);
    same(r.json, { ok: true, deviceId });
  });

  await check("claiming with a bad bearer token is refused with 401, even for a valid code", async () => {
    const r = await request({
      method: "POST",
      requestPath: "/claim",
      headers: { authorization: "Bearer not-the-real-token" },
      body: { code: claimCode },
    });
    eq(r.statusCode, 401);
    same(r.json, { ok: false, reason: "no_principal" });
  });

  // ---- camctl checkin: a real signed check-in is accepted ----

  await check("a real signed check-in from the claimed box is accepted", async () => {
    const payload = buildCheckin(CHECKIN_FACTS, { deviceId, nowUtc: new Date().toISOString(), seq: 1 });
    const signature = cryptoSign(null, Buffer.from(checkinDigest(payload), "utf8"), keyPair.privateKey).toString(
      "base64",
    );
    const r = await request({ method: "POST", requestPath: "/checkin", body: { payload, signature } });
    eq(r.statusCode, 200);
    same(r.json, { ok: true, seq: 1 });
  });

  // ---- GET /fleet now shows the box "online" with a health summary ----

  await check('GET /fleet shows the box "online" with a non-null health summary', async () => {
    const r = await request({
      method: "GET",
      requestPath: "/fleet",
      headers: { authorization: `Bearer ${server.token}` },
    });
    eq(r.statusCode, 200);
    eq(r.json?.ok, true);
    const rows = Array.isArray(r.json?.rows) ? r.json.rows : [];
    const row = rows.find((candidate) => candidate.deviceId === deviceId);
    if (row === undefined) {
      throw new Error(`expected a fleet row for ${deviceId}, got: ${JSON.stringify(rows)}`);
    }
    eq(row.state, "claimed");
    eq(row.status, "online", `expected "online" right after a fresh check-in, got ${JSON.stringify(row)}`);
    if (row.health === null) {
      throw new Error("an online device must carry a non-null health summary");
    }
  });

  // ---- a stale (already-used) seq is refused as a replay ----

  await check("replaying the same check-in seq is refused, not silently re-accepted", async () => {
    const payload = buildCheckin(CHECKIN_FACTS, { deviceId, nowUtc: new Date().toISOString(), seq: 1 });
    const signature = cryptoSign(null, Buffer.from(checkinDigest(payload), "utf8"), keyPair.privateKey).toString(
      "base64",
    );
    const r = await request({ method: "POST", requestPath: "/checkin", body: { payload, signature } });
    eq(r.statusCode, 409);
    same(r.json, { ok: false, reason: "replay" });
  });

  // Added 2026-09-27 from the review: an oversized body used to destroy the
  // socket before any answer, so the client saw a reset instead of a refusal.
  await check("an oversized body gets a clean 413 payload_too_large, never a dropped connection", async () => {
    const r = await request({ method: "POST", requestPath: "/enroll", body: { junk: "x".repeat(3 * 1024 * 1024) } });
    eq(r.statusCode, 413);
    same(r.json, { ok: false, reason: "payload_too_large" });
    const after = await request({ method: "GET", requestPath: "/fleet", headers: { authorization: `Bearer ${server.token}` } });
    eq(after.statusCode, 200, "the server keeps serving afterwards");
  });

  await check("THE BOX'S OWN CODE end to end: agent/cloud-enroll.mjs enrols, a claim, then agent/checkin.mjs's real sendCheckin is ACCEPTED and /fleet shows it online", async () => {
    // fetch-shaped adapter over https.request, trusting only this run's cert.
    const httpsFetch = (url, opts = {}) => new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? "GET", headers: opts.headers ?? {}, ca: caCertPem }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => text, json: async () => JSON.parse(text) });
        });
      });
      req.on("error", reject);
      if (opts.signal) opts.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
      req.end(opts.body);
    });
    const kp = generateKeyPairSync("ed25519");
    const boxDeviceId = deriveDeviceId(kp.publicKey.export({ type: "spki", format: "der" }));
    const boxIdentity = {
      loadOrCreateIdentity: async () => ({ deviceId: boxDeviceId, publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAtUtc: new Date().toISOString() }),
      signWithIdentity: async (_stateDir, message) => cryptoSign(null, Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8"), kp.privateKey),
    };
    const boxState = await mkdtemp(path.join(tmpDir, "box-state-"));

    const e = await boxEnroll({ stateDir: boxState, url: `${server.url}/enroll`, fetchFn: httpsFetch, identity: boxIdentity });
    eq(e.outcome, "enrolled", `box enroll outcome ${JSON.stringify(e.outcome)}`);
    const claim = await request({ method: "POST", requestPath: "/claim", headers: { authorization: `Bearer ${server.token}` }, body: { code: e.claimCode } });
    eq(claim.statusCode, 200, "claim with the box-printed code");

    const c = await sendCheckin({ stateDir: boxState, url: `${server.url}/checkin`, fetchFn: httpsFetch, identity: boxIdentity, appDir: boxState });
    eq(c.outcome, "sent", `the real box check-in must be accepted, got ${JSON.stringify(c)}`);

    const fleet = await request({ method: "GET", requestPath: "/fleet", headers: { authorization: `Bearer ${server.token}` } });
    const row = fleet.json.rows.find((r) => r.deviceId === boxDeviceId);
    eq(row && row.status, "online", "the box shows online after its own check-in");
  });
} finally {
  if (server) {
    await server.close();
  }
  await rm(tmpDir, { recursive: true, force: true });
}

report("dev loop");
