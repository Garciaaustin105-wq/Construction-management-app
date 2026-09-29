/**
 * Verifying a box's enrolment envelope on the cloud side (cloud/CLOUD-LOOP-SPEC.md
 * section A, "cloud/contracts/enroll.ts (pure)"). Pure: no fs, no clock of
 * its own (the caller supplies `nowMs`), no network, no `node:crypto` --
 * every crypto step is injected, exactly as `cloud/contracts/checkinVerify.ts`
 * does it for a check-in.
 *
 * The box proves two things at once: that it holds the private key for the
 * public key it presents, and that the `deviceId` it claims is the one that
 * key actually produces (so a box can never enrol under another box's id).
 *
 * It imports `canonicalJson` from `../../contracts/deviceCheckin.ts` -- the
 * SAME function a check-in signs -- so the enrolment envelope and a check-in
 * envelope are always canonicalised the same way. There is no second
 * canonicaliser here, on purpose.
 *
 * See cloud/CLOUD-LOOP-SPEC.md section A for the full contract, and
 * cloud/harness/enroll.harness.mjs for the checks it must pass -- including a
 * real Ed25519 signature, not a faked one.
 */

import { canonicalJson } from "../../contracts/deviceCheckin.js";

/**
 * The pattern a `nonce` must match: 16 to 64 characters, each one of
 * `[A-Za-z0-9_-]`. Exported so `cloud/harness/enroll.harness.mjs` can build
 * both valid and deliberately-out-of-shape nonces against the exact same
 * boundary the contract enforces, rather than a second, hand-copied pattern
 * that could quietly drift.
 */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * What a box posts to `/enroll`, before it is signed. Every field is
 * required; there is no optional field here for a caller to omit and have
 * silently defaulted (a blank is not a zero, build rule 5).
 */
export interface EnrollPayload {
  /** The deviceId the box computes from its own public key (the SAME
   *  derivation `agent/device-identity.mjs`'s `loadOrCreateIdentity` uses) --
   *  never trusted on its own; `verifyEnrollment` recomputes it from
   *  `publicKeyPem` via `ctx.deviceIdOf` and refuses a mismatch. */
  deviceId: string;
  /** The box's Ed25519 public key, PEM (SPKI), text -- the same encoding
   *  `agent/device-identity.mjs` produces and never rotates without a new
   *  identity file. */
  publicKeyPem: string;
  /** ISO-8601. Checked against `ctx.nowMs` within `ctx.maxSkewMs`, the same
   *  shape a check-in's own `sentAtUtc` takes. */
  sentAtUtc: string;
  /** 16 to 64 characters of `[A-Za-z0-9_-]` (`NONCE_PATTERN`). Carried in the
   *  signed payload so two enrolment attempts a box makes back to back never
   *  canonicalise to the exact same signed text. `verifyEnrollment` only
   *  checks the nonce's SHAPE -- it does not itself track nonces it has seen
   *  before; a store-level replay guard, if one is ever needed, is a
   *  decision for the handler and the store, not this pure contract. */
  nonce: string;
}

/** The envelope a box posts: its enrolment payload plus a base64 Ed25519
 *  signature over `canonicalJson(payload)`. Untrusted until `verifyEnrollment`
 *  has checked it -- callers must pass it in as `unknown`. */
export interface EnrollEnvelope {
  payload: EnrollPayload;
  signatureB64: string;
}

/**
 * Everything `verifyEnrollment` needs from the caller: the cloud's own clock
 * reading and skew tolerance, whether enrolment is open at all right now, the
 * one function that derives a deviceId from a public key, and the one
 * function that can actually check a signature (`node:crypto` lives in the
 * caller, not here -- see contracts/deviceCheckin.ts's top comment for why
 * contracts/ stays crypto-free).
 */
export interface EnrollCtx {
  /** The cloud's own clock reading, epoch milliseconds. */
  nowMs: number;
  /** The largest `|nowMs - Date.parse(payload.sentAtUtc)|`, in milliseconds,
   *  that is still accepted -- exactly at this value is fine (the boundary
   *  is inclusive on both sides). */
  maxSkewMs: number;
  /** The owner's decision, 2026-09-28 (cloud/CLOUD-LOGIN-SPEC.md section D):
   *  production runs with open enrolment (`allowOpenEnrollment: true`,
   *  everywhere, not just a dev server) rather than waiting on a factory
   *  claim certificate. This is safe because it relies on other guard rails
   *  instead: a claim code expires in 24 h; an unclaimed record expires with
   *  it (`expiresAtS`, a DynamoDB TTL -- cloud/api/store.mjs); `/enroll` is
   *  throttled at API Gateway (the deploy spec); and a claim needs a
   *  logged-in installer (cloud/api/claim.mjs). Only a value of exactly
   *  `true` opens enrolment; anything else (`false`, `undefined`, a truthy
   *  non-`true` value) refuses with `"enrollment_closed"` -- refuse rather
   *  than guess (build rule 10) still applies to anything that is not
   *  exactly `true`. */
  allowOpenEnrollment: boolean;
  /** Derives the deviceId a public key must produce -- the SAME derivation
   *  `agent/device-identity.mjs` uses on the box side (base32 of a sha256 of
   *  the key's SPKI DER, today, but `verifyEnrollment` never assumes the
   *  algorithm; it only compares the result to `payload.deviceId`). Returns
   *  `null` for a `publicKeyPem` that does not even parse as a key. */
  deviceIdOf(publicKeyPem: string): string | null;
  /** Checks a signature over `message` (the canonical JSON text, from
   *  `canonicalJson(payload)`) against `publicKeyPem`. A `verifySignature`
   *  that itself throws while checking a signature is treated the same as
   *  returning `false` -- never a crash out of `verifyEnrollment`. */
  verifySignature(message: string, signatureB64: string, publicKeyPem: string): boolean;
}

/** Why `verifyEnrollment` refused an envelope, in the order the checks run --
 *  the first one that applies is the one returned. */
export type EnrollVerifyReason =
  | "enrollment_closed"
  | "malformed"
  | "bad_device_id"
  | "clock_skew"
  | "bad_signature";

export type EnrollVerifyResult =
  | { ok: true; deviceId: string; publicKeyPem: string }
  | { ok: false; reason: EnrollVerifyReason };

/**
 * Verify a box's enrolment envelope. Pure and total: NEVER throws, whatever
 * `envelope` is -- a refusal is a value (build rule 10), not an exception,
 * for every input this function is given, including `ctx.verifySignature`
 * itself throwing while checking a signature.
 *
 * Contract -- checks run in this exact order, first failure wins:
 *
 * | # | Reason                | Fails when |
 * |---|------------------------|------------|
 * | 1 | `"enrollment_closed"`  | `ctx.allowOpenEnrollment !== true`. Checked FIRST, before the envelope is inspected at all. The owner's decision, 2026-09-28 (cloud/CLOUD-LOGIN-SPEC.md section D): production sets this `true` -- open enrolment, guarded instead by a 24 h claim-code expiry, an `expiresAtS` DynamoDB TTL on every unclaimed record, `/enroll` throttling at API Gateway, and a claim requiring a logged-in installer -- so this check now exists only to keep a malformed or even a perfectly well-formed envelope refused exactly the same way on any deployment that has not (yet, or deliberately) opened enrolment. |
 * | 2 | `"malformed"`          | `envelope` is not an object (including `null`, an array, a primitive); `envelope.signatureB64` is not a non-empty string; `envelope.payload` is not an object; any of `payload.deviceId`, `payload.publicKeyPem`, `payload.sentAtUtc`, `payload.nonce` is missing or not a string; `payload.nonce` does not match `NONCE_PATTERN` (16 to 64 characters of `[A-Za-z0-9_-]`); `payload.sentAtUtc` does not parse (`Number.isNaN(Date.parse(...))`). |
 * | 3 | `"bad_device_id"`      | `ctx.deviceIdOf(payload.publicKeyPem)` is `null` (an unparseable key) or does not exactly equal `payload.deviceId`. A box can never enrol under another box's id, and an unparseable key can never enrol at all. |
 * | 4 | `"clock_skew"`         | `Math.abs(ctx.nowMs - Date.parse(payload.sentAtUtc)) > ctx.maxSkewMs`. The boundary is INCLUSIVE: exactly `ctx.maxSkewMs` either way is accepted, only strictly more is refused. |
 * | 5 | `"bad_signature"`      | `ctx.verifySignature(canonicalJson(payload), envelope.signatureB64, payload.publicKeyPem)` is `false`, or it throws. |
 *
 * The signed message is `canonicalJson(payload)` from
 * `contracts/deviceCheckin.ts` -- the SAME function a check-in signs (Ed25519
 * signs the canonical text itself; there is no separate hash step). This
 * function reuses it directly; it never computes its own canonical form of
 * `payload`.
 *
 * On success, returns `{ ok: true, deviceId, publicKeyPem }` -- the deviceId
 * and public key `verifyEnrollment` itself just finished proving belong
 * together and are held by whoever signed this envelope, not merely echoed
 * from the unverified payload. On any refusal, the result is exactly
 * `{ ok: false, reason }` -- it never carries the payload, the signature or
 * the public key, so a refused enrolment can be logged freely.
 *
 * @param envelope Untrusted input -- caller passes it in as `unknown` because
 *   nothing about its shape is known until the checks above have run.
 * @param ctx See `EnrollCtx`.
 */
export function verifyEnrollment(envelope: unknown, ctx: EnrollCtx): EnrollVerifyResult {
  // (1) Enrolment is closed unless the caller explicitly opens it. Checked
  // FIRST, before the envelope is inspected at all: the owner's decision,
  // 2026-09-28 (cloud/CLOUD-LOGIN-SPEC.md section D), is that production
  // itself sets allowOpenEnrollment true -- there is no factory claim
  // certificate, and none is coming; open enrolment is guarded instead by a
  // 24 h claim-code expiry, an expiresAtS DynamoDB TTL on every unclaimed
  // record, /enroll throttling at API Gateway, and a claim requiring a
  // logged-in installer. Whenever this flag is NOT true, a malformed
  // envelope and a perfect one are still refused exactly the same way.
  if (ctx.allowOpenEnrollment !== true) return { ok: false, reason: "enrollment_closed" };

  // (2) Shape. Every field is read off by name; nothing about the envelope
  // is trusted until its own check has run.
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return { ok: false, reason: "malformed" };
  }
  const env = envelope as Record<string, unknown>;
  const signatureB64 = env.signatureB64;
  if (typeof signatureB64 !== "string" || signatureB64.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const payloadRaw = env.payload;
  if (typeof payloadRaw !== "object" || payloadRaw === null || Array.isArray(payloadRaw)) {
    return { ok: false, reason: "malformed" };
  }
  const payload = payloadRaw as Record<string, unknown>;
  const claimedDeviceId = payload.deviceId;
  const publicKeyPem = payload.publicKeyPem;
  const sentAtUtc = payload.sentAtUtc;
  const nonce = payload.nonce;
  if (
    typeof claimedDeviceId !== "string" ||
    typeof publicKeyPem !== "string" ||
    typeof sentAtUtc !== "string" ||
    typeof nonce !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (!NONCE_PATTERN.test(nonce)) return { ok: false, reason: "malformed" };
  const sentMs = Date.parse(sentAtUtc);
  if (Number.isNaN(sentMs)) return { ok: false, reason: "malformed" };

  // (3) The claimed deviceId must be exactly what the presented key derives;
  // an unparseable key can never enrol at all. A deviceIdOf that itself
  // throws on junk is treated exactly like one returning null.
  let derivedDeviceId: string | null = null;
  try {
    derivedDeviceId = ctx.deviceIdOf(publicKeyPem);
  } catch {
    derivedDeviceId = null;
  }
  if (derivedDeviceId === null || derivedDeviceId !== claimedDeviceId) {
    return { ok: false, reason: "bad_device_id" };
  }

  // (4) Clock skew, boundary inclusive: exactly ctx.maxSkewMs either way is
  // accepted, only strictly more is refused.
  if (Math.abs(ctx.nowMs - sentMs) > ctx.maxSkewMs) {
    return { ok: false, reason: "clock_skew" };
  }

  // (5) The signed message is canonicalJson(payload) -- the SAME canonical
  // text a check-in signs. A verifySignature that throws is treated exactly
  // like one that returned false; it is never propagated.
  let signatureOk = false;
  try {
    signatureOk = ctx.verifySignature(canonicalJson(payload), signatureB64, publicKeyPem);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  // The deviceId and key this function itself just proved belong together
  // and are held by whoever signed this envelope -- not merely echoed from
  // the unverified payload.
  return { ok: true, deviceId: derivedDeviceId, publicKeyPem };
}
