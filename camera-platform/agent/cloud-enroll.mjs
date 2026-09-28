// agent/cloud-enroll.mjs
//
// The box's own half of "cloud loop, locally" (cloud/CLOUD-LOOP-SPEC.md
// section C, "The box: `camctl enroll` and a real `camctl checkin`"). This
// file does the I/O that cloud/contracts/enroll.ts deliberately does not:
// it asks agent/device-identity.mjs for this box's identity, builds and
// signs an enrolment envelope, POSTs it, and -- only on a well-formed
// success -- writes what the box itself now knows (a claim code, or that it
// is already claimed) to disk. Everything about WHAT the envelope may
// contain is decided by cloud/contracts/enroll.ts's EnrollPayload shape,
// mirrored here field by field, exactly the discipline
// contracts/deviceCheckin.ts's own top comment documents for a check-in.
//
// THE PRIVATE KEY NEVER PASSES THROUGH THIS FILE: `identity.loadOrCreateIdentity`
// (agent/device-identity.mjs) returns only the public half, and
// `identity.signWithIdentity` returns only a signature -- see that file's own
// top comment. Nothing here ever reads, logs, or writes the private key, and
// cloud-enrollment.json (CLOUD_ENROLLMENT_FILE below) never carries even the
// PUBLIC key: its shape is exactly `{ url, deviceId, claimed, claimCode,
// expiresUtc, atUtc }`, spelled out field by field below, never a spread of
// whatever the cloud happened to answer with.
//
// HTTPS ONLY, EXACTLY LIKE agent/checkin.mjs's sendCheckin: `http://` is
// refused before anything is built or sent, never merely discouraged.
//
// Every network or server-side outcome here is a VALUE, never a throw (build
// rule 10: refuse rather than guess) -- see `enroll()`'s own doc comment for
// the full outcome union. A thrown error out of `enroll()` means a
// programmer error (no `fetchFn` available) or a genuinely untrusted local
// identity file (agent/device-identity.mjs's own refusal, which names only
// what is wrong and tells the operator how to fix it) -- never a network
// hiccup or a cloud-side 4xx/5xx.

import { open, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "../dist/deviceCheckin.js";

/** This box's own persisted record of the last enrolment outcome. Holds
 *  exactly the fields cloud/CLOUD-LOOP-SPEC.md section C names -- never a
 *  key, public or private. */
export const CLOUD_ENROLLMENT_FILE = "cloud-enrollment.json";
/** How long an enrolment POST may take before it is treated as failed --
 *  the same value agent/checkin.mjs's CHECKIN_TIMEOUT_MS uses, for the same
 *  reason (one number to remember, not two that could quietly drift). */
export const ENROLL_TIMEOUT_MS = 10_000;

/** The canonical claim code, `XXXX-XXXX-C` (cloud/contracts/claimCode.ts):
 *  eight Crockford base32 data symbols, then a check symbol from the same
 *  alphabet plus `*~$=U`. Shape only -- the cloud owns the checksum. */
export const CLAIM_CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z*~$=U]$/;

/**
 * The agent/device-identity.mjs interface this file depends on. Imported
 * lazily, inside getRealIdentity() rather than at module load, for the same
 * reason agent/checkin.mjs's own getRealIdentity() does it: importing this
 * file (and running its own harness, which always injects a fake `identity`)
 * must never fail just because agent/device-identity.mjs has not landed, or
 * is mid-edit, in this checkout.
 */
async function getRealIdentity() {
  const mod = await import("./device-identity.mjs");
  if (typeof mod.loadOrCreateIdentity !== "function" || typeof mod.signWithIdentity !== "function") {
    throw new Error(
      "agent/device-identity.mjs does not export loadOrCreateIdentity/signWithIdentity as documented in agent/cloud-enroll.mjs",
    );
  }
  return { loadOrCreateIdentity: mod.loadOrCreateIdentity, signWithIdentity: mod.signWithIdentity };
}

/**
 * A fresh nonce in cloud/contracts/enroll.ts's NONCE_PATTERN shape (16 to 64
 * characters of `[A-Za-z0-9_-]`) without importing anything from cloud/ --
 * this file must never depend on cloud/ (cloud/CLOUD-LOOP-SPEC.md section C
 * is built and tested independently of it; only the WIRE SHAPE has to
 * agree). base64url of 16 random bytes is exactly that alphabet already
 * (`-`/`_` in place of base64's `+`/`/`, no padding), and always comes out
 * at 22 characters -- comfortably inside the 16..64 window every time.
 */
function freshNonce() {
  return randomBytes(16).toString("base64url");
}

/**
 * Builds the (unsigned) enrolment payload -- cloud/contracts/enroll.ts's
 * `EnrollPayload` shape, built here in plain JS since agent/ is not
 * TypeScript. Every field is read off its own named argument, never spread
 * from a caller-supplied object, so a stray extra property on whatever
 * called this can never ride along into a signed envelope.
 *
 * `now` and `nonce` are both overridable so a harness gets a fully
 * deterministic payload; production (`enroll()` below) supplies neither and
 * gets the real clock and a fresh random nonce.
 */
export function buildEnrollPayload({ deviceId, publicKeyPem, now = () => new Date(), nonce = freshNonce() } = {}) {
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new TypeError("buildEnrollPayload: deviceId is not a non-empty string");
  }
  if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) {
    throw new TypeError("buildEnrollPayload: publicKeyPem is not a non-empty string");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new TypeError("buildEnrollPayload: nonce is not a non-empty string");
  }
  return {
    deviceId,
    publicKeyPem,
    sentAtUtc: now().toISOString(),
    nonce,
  };
}

/** The whole text flushed to disk before the rename that makes it the file
 *  -- the same idiom agent/checkin.mjs's own writeFileSynced() uses, for the
 *  same reason (a power cut right after a bare rename can leave a
 *  zero-length file on XFS, the appliance's own filesystem). */
async function writeFileSynced(file, text) {
  const fh = await open(file, "w", 0o644);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Atomically writes CLOUD_ENROLLMENT_FILE in `stateDir`. `record` must
 * already be exactly `{ url, deviceId, claimed, claimCode, expiresUtc,
 * atUtc }` -- this function does not filter or validate it further, so every
 * call site (only `enroll()` below) is what actually enforces "never a key,
 * public or private, on this path".
 */
async function writeEnrollmentRecord(stateDir, record) {
  const file = path.join(stateDir, CLOUD_ENROLLMENT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFileSynced(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * `camctl enroll`'s whole flow: load (or create) this box's identity, build
 * and sign an enrolment envelope, POST it to `url`, and -- on a well-formed
 * success only -- persist the result. Never sends anything, and never
 * touches the identity, when `url` is not `https://` (mirrors
 * agent/checkin.mjs's sendCheckin exactly: refused, not merely discouraged).
 *
 * `fetchFn` defaults to the global fetch (agent/checkin.mjs's sendCheckin
 * and agent/web-push.mjs's sendPush both default the same way) -- a harness
 * passes a fake one and never touches the network.
 *
 * @returns {Promise<EnrollOutcome>} outcome is one of:
 *   "bad_url" -- `url` does not parse as a URL at all; nothing sent.
 *   "refused_insecure_url" -- `url` is not `https://`; nothing sent.
 *   "compose_failed" -- loading the identity, building, or signing the
 *     envelope threw (e.g. a refused device-identity.json); nothing sent.
 *   "network_error" -- the POST itself could not be completed.
 *   "server_error" -- the cloud answered 5xx.
 *   "rejected" -- the cloud answered 4xx (`reason` carries its `{ reason }`
 *     body field when the body parsed and had one, else `null`).
 *   "unexpected_status" -- a status outside 200..599 (should not happen,
 *     handled rather than assumed impossible).
 *   "bad_response" -- a 2xx whose body did not have the shape section B
 *     promises (build rule 10: refuse rather than guess at what it meant).
 *   "write_failed" -- the cloud accepted the box but
 *     CLOUD_ENROLLMENT_FILE could not be persisted.
 *   "enrolled" -- a fresh or reissued claim code (`claimCode`, `expiresUtc`,
 *     `deviceId`), also just written to disk.
 *   "already_claimed" -- this box is already claimed (`deviceId`); no code
 *     to report, and none was ever generated for this request.
 */
export async function enroll({
  stateDir,
  url,
  now = () => new Date(),
  fetchFn = globalThis.fetch,
  identity,
  timeoutMs = ENROLL_TIMEOUT_MS,
} = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { outcome: "bad_url", message: "the enrolment address is not a valid URL; nothing sent" };
  }
  if (parsedUrl.protocol !== "https:") {
    return {
      outcome: "refused_insecure_url",
      message: `refusing to enrol over ${parsedUrl.protocol.replace(":", "")}; only https is allowed`,
    };
  }

  let deviceIdentity;
  let envelope;
  try {
    const id = identity ?? (await getRealIdentity());
    deviceIdentity = await id.loadOrCreateIdentity(stateDir);
    const payload = buildEnrollPayload({ deviceId: deviceIdentity.deviceId, publicKeyPem: deviceIdentity.publicKeyPem, now });
    const signatureBytes = await id.signWithIdentity(stateDir, Buffer.from(canonicalJson(payload), "utf8"));
    const signatureB64 = Buffer.isBuffer(signatureBytes)
      ? signatureBytes.toString("base64")
      : Buffer.from(signatureBytes).toString("base64");
    envelope = { payload, signatureB64 };
  } catch (err) {
    return { outcome: "compose_failed", message: `could not build the enrolment envelope: ${err.message}` };
  }

  if (typeof fetchFn !== "function") {
    throw new Error("no fetch is available; pass fetchFn (this Node has no global fetch)");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch (err) {
    return { outcome: "network_error", message: `could not reach ${parsedUrl.hostname}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  let body = null;
  try {
    const text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null; // an unparseable body is handled per status below, never thrown
  }

  if (status >= 500) {
    return { outcome: "server_error", status, message: `the enrolment server returned ${status}` };
  }
  if (status >= 400) {
    const reason = body && typeof body === "object" && typeof body.reason === "string" ? body.reason : null;
    return {
      outcome: "rejected",
      status,
      reason,
      message: `the enrolment server refused this box (${status}${reason ? `: ${reason}` : ""})`,
    };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "unexpected_status", status, message: `the enrolment server returned an unexpected status ${status}` };
  }

  const claimed = body && typeof body === "object" ? body.claimed : undefined;
  if (!body || typeof body !== "object" || body.ok !== true || typeof claimed !== "boolean") {
    return { outcome: "bad_response", status, message: "the enrolment server's response did not have the expected shape" };
  }
  // The code is printed verbatim on the installer's terminal, so only the
  // real XXXX-XXXX-C shape passes (cloud/contracts/claimCode.ts: Crockford
  // base32 data symbols, a check symbol that may also be * ~ $ = U). A
  // terminal escape or any other shape is a bad response, never printed.
  if (claimed === false && (typeof body.claimCode !== "string" || !CLAIM_CODE_SHAPE.test(body.claimCode) || typeof body.expiresUtc !== "string" || Number.isNaN(Date.parse(body.expiresUtc)))) {
    return { outcome: "bad_response", status, message: "a fresh enrolment response is missing a valid claimCode or expiresUtc" };
  }
  if (claimed === true && (body.claimCode !== null || body.expiresUtc !== null)) {
    return { outcome: "bad_response", status, message: "an already-claimed response must carry claimCode: null and expiresUtc: null" };
  }

  const record = {
    url,
    deviceId: deviceIdentity.deviceId,
    claimed,
    claimCode: claimed ? null : body.claimCode,
    expiresUtc: claimed ? null : body.expiresUtc,
    atUtc: now().toISOString(),
  };

  try {
    await writeEnrollmentRecord(stateDir, record);
  } catch (err) {
    return { outcome: "write_failed", message: `could not persist ${CLOUD_ENROLLMENT_FILE}: ${err.message}` };
  }

  return claimed
    ? { outcome: "already_claimed", deviceId: deviceIdentity.deviceId }
    : { outcome: "enrolled", deviceId: deviceIdentity.deviceId, claimCode: record.claimCode, expiresUtc: record.expiresUtc };
}
