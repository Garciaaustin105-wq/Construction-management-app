/**
 * Verifying a signed check-in envelope on the cloud side
 * (CLOUD-B1-SPEC.md section 6, "how an NVR talks to the cloud";
 * cloud/CLOUD-SLICE1-SPEC.md section 2). Pure: no fs, no clock of its own
 * (the caller supplies `nowMs`), no network. It imports `CheckinPayload`,
 * `CHECKIN_SCHEMA_VERSION` and `checkinDigest` from the box's own
 * `../../contracts/deviceCheckin.ts` so the box and the cloud can never
 * disagree about what was signed.
 *
 * See cloud/CLOUD-SLICE1-SPEC.md section 2 for
 * the full contract, and cloud/harness/checkinVerify.harness.mjs for the
 * checks it must pass -- including a real Ed25519 signature, not a faked
 * one.
 */

import { CHECKIN_SCHEMA_VERSION, checkinDigest, type CheckinPayload } from "../../contracts/deviceCheckin.js";

/** How far a check-in's `sentAtUtc` may drift from the cloud's own clock
 *  before it is refused, in milliseconds (5 minutes). */
export const CLOCK_SKEW_LIMIT_MS = 300000;

/** What the cloud has on file for one device -- just enough to verify a
 *  check-in against, never camera addresses or credentials. */
export interface CheckinDeviceRecord {
  state: "unclaimed" | "claimed" | "revoked";
  publicKeyPem: string;
}

/** The envelope a device posts: its check-in payload plus a base64 Ed25519
 *  signature over `checkinDigest(payload)`. Untrusted until `verifyCheckin`
 *  has checked it -- callers must pass it in as `unknown`. */
export interface CheckinEnvelope {
  payload: CheckinPayload;
  signature: string;
}

/**
 * Everything `verifyCheckin` needs from the caller: the device directory,
 * the last accepted sequence number per device (for replay rejection), the
 * cloud's own clock reading, and the one function that can actually check a
 * signature (`node:crypto` lives in the caller, not here -- see
 * deviceCheckin.ts's top comment for why contracts/ stays crypto-free).
 */
export interface VerifyCheckinCtx {
  devices: Map<string, CheckinDeviceRecord>;
  lastSeq: Map<string, number>;
  nowMs: number;
  /**
   * Checks a signature. Must be a function -- passing a non-function is a
   * CALLER BUG and `verifyCheckin` throws rather than guessing (build rule
   * 10). A `verifySignature` that itself throws while checking a signature
   * is not a caller bug: it is treated the same as returning `false`.
   */
  verifySignature: (digestHex: string, signatureB64: string, publicKeyPem: string) => boolean;
}

/** Why `verifyCheckin` refused an envelope, in the order the checks run --
 *  the first one that applies is the one returned. */
export type VerifyCheckinReason =
  | "malformed"
  | "unsupported_version"
  | "unknown_device"
  | "not_claimed"
  | "bad_signature"
  | "replay"
  | "clock_skew";

export type VerifyCheckinResult = { ok: true; payload: CheckinPayload } | { ok: false; reason: VerifyCheckinReason };

/**
 * Verify a signed check-in envelope against the cloud's device directory and
 * clock. Pure and total: never throws on a bad `envelope` (a refusal is a
 * value, build rule 10), and never throws when `ctx.verifySignature` throws
 * -- that becomes `"bad_signature"`, not a crash. Throwing `ctx.verifySignature`
 * itself being a non-function IS a caller bug and is allowed to throw.
 *
 * Contract -- checks run in this exact order, first failure wins:
 *
 * | # | Reason                  | Fails when |
 * |---|--------------------------|------------|
 * | 1 | `"malformed"`            | `envelope` is not `{ payload, signature }` with `signature` a string and `payload` at least shaped like a `CheckinPayload` (deviceId: non-empty string, seq: number, sentAtUtc: string, checkinVersion: number, health: an object) |
 * | 2 | `"unsupported_version"`  | `payload.checkinVersion !== CHECKIN_SCHEMA_VERSION` |
 * | 3 | `"unknown_device"`       | `payload.deviceId` is not a key of `ctx.devices` |
 * | 4 | `"not_claimed"`          | the device's `state !== "claimed"` |
 * | 5 | `"bad_signature"`        | `ctx.verifySignature(checkinDigest(payload), envelope.signature, device.publicKeyPem)` is `false`, or it throws |
 * | 6 | `"replay"`               | `payload.seq <= ctx.lastSeq.get(payload.deviceId)`; a device with no entry in `lastSeq` accepts any `seq >= 1` |
 * | 7 | `"clock_skew"`           | `Math.abs(Date.parse(payload.sentAtUtc) - ctx.nowMs) > CLOCK_SKEW_LIMIT_MS` |
 *
 * On success, returns `{ ok: true, payload }` (the same payload, unmodified).
 * On any refusal, the result is exactly `{ ok: false, reason }` -- it never
 * carries the payload's health contents or the signature, even for
 * debugging, so a refused check-in can be logged freely.
 */
export function verifyCheckin(envelope: unknown, ctx: VerifyCheckinCtx): VerifyCheckinResult {
  // A non-function `ctx.verifySignature` is a caller bug (build rule 10):
  // throw rather than guess. Every other failure below is a refusal value,
  // never a throw.
  if (typeof ctx.verifySignature !== "function") {
    throw new TypeError("verifyCheckin: ctx.verifySignature is not a function");
  }

  const refuse = (reason: VerifyCheckinReason): VerifyCheckinResult => ({ ok: false, reason });

  // (1) malformed: the envelope must be { payload, signature: string } with a
  // payload at least shaped like a CheckinPayload.
  if (typeof envelope !== "object" || envelope === null) return refuse("malformed");
  const env = envelope as Record<string, unknown>;
  const signatureB64 = env.signature;
  if (typeof signatureB64 !== "string") return refuse("malformed");
  const rawPayload = env.payload;
  if (typeof rawPayload !== "object" || rawPayload === null) return refuse("malformed");
  const p = rawPayload as Record<string, unknown>;
  const deviceId = p.deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0) return refuse("malformed");
  const seq = p.seq;
  if (typeof seq !== "number") return refuse("malformed");
  if (!Number.isSafeInteger(seq)) return refuse("malformed");
  const sentAtUtc = p.sentAtUtc;
  if (typeof sentAtUtc !== "string") return refuse("malformed");
  if (Number.isNaN(Date.parse(sentAtUtc))) return refuse("malformed");
  const checkinVersion = p.checkinVersion;
  if (typeof checkinVersion !== "number") return refuse("malformed");
  if (typeof p.health !== "object" || p.health === null) return refuse("malformed");

  // (2) unsupported_version
  if (checkinVersion !== CHECKIN_SCHEMA_VERSION) return refuse("unsupported_version");

  // (3) unknown_device
  const device = ctx.devices.get(deviceId);
  if (device === undefined) return refuse("unknown_device");

  // (4) not_claimed
  if (device.state !== "claimed") return refuse("not_claimed");

  // (5) bad_signature: a verifySignature that throws is refused, not a crash.
  const payload = rawPayload as CheckinPayload;
  let signatureOk = false;
  try {
    signatureOk = ctx.verifySignature(checkinDigest(payload), signatureB64, device.publicKeyPem);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return refuse("bad_signature");

  // (6) replay: a device with no entry in lastSeq accepts any seq.
  const lastAccepted = ctx.lastSeq.get(deviceId);
  if (lastAccepted === undefined && seq < 1) return refuse("replay");
  if (lastAccepted !== undefined && seq <= lastAccepted) return refuse("replay");

  // (7) clock_skew: exactly at the limit is accepted; past skew is symmetric.
  if (Math.abs(Date.parse(sentAtUtc) - ctx.nowMs) > CLOCK_SKEW_LIMIT_MS) return refuse("clock_skew");

  return { ok: true, payload };
}
