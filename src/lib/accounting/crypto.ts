// Symmetric encryption for accounting provider OAuth tokens at rest.
// ----------------------------------------------------------------------------
// The payments pivot (2026-08-17): the platform never touches customer money.
// Each org connects its OWN bookkeeping provider (QuickBooks, Xero, …) via
// OAuth2, and we persist that provider's access/refresh tokens in
// `accounting_connections`. Tokens are sensitive (a refresh token can live ~5
// years for QBO), so they are encrypted at rest with AES-256-GCM keyed by
// ACCOUNTING_TOKEN_ENCRYPTION_KEY. The DB stores only ciphertext + iv + tag.
//
// The key is a 32-byte value, provided as base64 (recommended) or hex. If the
// key is unset or the wrong length, encrypt/decrypt throw — never silently fall
// back to plaintext. SQL/RLS/auth/security stay Claude-direct per
// [[lowvoltage-local-model-delegation]].

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV is the GCM standard

function getKey(): Buffer {
  const raw = process.env.ACCOUNTING_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("ACCOUNTING_TOKEN_ENCRYPTION_KEY is not set");
  // Accept base64 or hex; whichever decodes to exactly 32 bytes wins.
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  const hex = Buffer.from(raw, "hex");
  if (hex.length === 32) return hex;
  throw new Error(
    "ACCOUNTING_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64- or hex-encoded)"
  );
}

/** Encrypt a UTF-8 string → "base64(iv).base64(ciphertext).base64(tag)". */
export function encrypt(plaintext: string): string {
  if (!plaintext) throw new Error("encrypt() received empty plaintext");
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(".");
}

/** Decrypt a value produced by encrypt() back to the original UTF-8 string. */
export function decrypt(payload: string): string {
  if (!payload) throw new Error("decrypt() received empty payload");
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Malformed ciphertext (expected iv.ct.tag)");
  const key = getKey();
  const iv = Buffer.from(parts[0], "base64");
  const ct = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

/** Constant-time-ish state signing for OAuth CSRF (HMAC-SHA256 hex). */
export function signState(value: string): string {
  const key = getKey();
  return createHmac("sha256", key).update(value).digest("hex");
}