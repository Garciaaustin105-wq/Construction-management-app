// agent/web-push.mjs
//
// The standard Web Push sender core: VAPID request signing (RFC 8292) and
// message encryption (RFC 8291, built on the "aes128gcm" content coding of
// RFC 8188). This file turns a push subscription and a plaintext payload
// into an HTTP request, and turns a push service's HTTP response into a
// plain outcome. It knows nothing about cameras, alerts, staff, or who is
// subscribed to what -- the alerts module that will call this decides who
// gets notified and why; this file only speaks the wire protocol.
//
// Decisions worth defending:
//
// - No npm dependency. node:crypto already has P-256 ECDH, ECDSA, HMAC-SHA-256
//   (for HKDF, done by hand per the RFCs' own pseudocode) and AES-128-GCM --
//   everything RFC 8291/8292 need. Pulling in a web-push or jose package for
//   three primitives already in the standard library would be a dependency
//   for a very short list of math.
// - Every value the RFCs leave to the implementation -- the ephemeral ECDH
//   key pair used to encrypt one message, the random salt, "now" -- is a
//   parameter with a generated-if-omitted default, never a hidden call to
//   Math.random or Date.now buried in the algorithm. That is what lets the
//   harness reproduce RFC 8291 Appendix A byte for byte, by injecting the
//   RFC's own fixed keys and salt.
// - The VAPID signing key pair and the per-message ECDH key pair are always
//   two different objects, never the same generateP256KeyPair() call reused.
//   RFC 8292 section 3.2 requires this (a push service may otherwise reject
//   the request); keeping them as separate arguments in this file's public
//   functions makes it structurally hard to pass one where the other belongs.
// - Refuse rather than guess: a subscription whose p256dh or auth decodes to
//   the wrong length, a payload that will not fit in a single aes128gcm
//   record, a VAPID request with no contact, or a token asked to outlive 24
//   hours are all refused before any network call -- never silently
//   truncated, padded, or capped to fit.
// - No thrown error interpolates the auth secret or a private key. Lengths
//   and field names are reported; the bytes themselves never are. This is a
//   rule checked by the harness (it deliberately triggers every refusal path
//   with a marked secret and greps the thrown messages for it), not just a
//   habit.

import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  randomBytes,
} from 'node:crypto';

const CURVE = 'prime256v1'; // P-256, in OpenSSL's naming
const P256_PUBLIC_KEY_BYTES = 65; // 0x04 || X(32) || Y(32), the uncompressed point form (X9.62)
const P256_PRIVATE_KEY_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const GCM_TAG_BYTES = 16;
const PADDING_DELIMITER_BYTES = 1;

/** The aes128gcm "rs" (record size) parameter this module always encrypts with. */
export const RECORD_SIZE = 4096;
/**
 * The most plaintext that fits in one RECORD_SIZE record. RFC 8291 section 4
 * requires "rs" to be strictly GREATER THAN plaintext + delimiter (1) + tag
 * (16) -- rs equal to that sum is not allowed -- so this is rs - 16 - 1 - 1,
 * one less than the naive rs - 17.
 */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - GCM_TAG_BYTES - PADDING_DELIMITER_BYTES - 1;

/** RFC 8292 section 2: "exp" MUST NOT be more than 24 hours from the request. */
export const MAX_VAPID_EXPIRY_SECONDS = 24 * 3600;
/** A conservative default well under the 24-hour ceiling. */
export const DEFAULT_VAPID_EXPIRY_SECONDS = 12 * 3600;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const VALID_URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);

// ---------------------------------------------------------------- helpers --

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Decodes a base64url string strictly. Never echoes `value` in a thrown message -- callers use this for secrets too. */
function decodeBase64Url(value, what) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL_RE.test(value)) {
    throw new Error(`${what} must be a base64url-encoded string`);
  }
  return Buffer.from(value, 'base64url');
}

/** The base64url text of a Buffer -- the form every RFC 8291/8292 field on the wire uses. */
export function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function leftPad32(buf) {
  if (buf.length === P256_PRIVATE_KEY_BYTES) return buf;
  if (buf.length > P256_PRIVATE_KEY_BYTES) throw new Error('a P-256 private key scalar cannot be more than 32 bytes');
  return Buffer.concat([Buffer.alloc(P256_PRIVATE_KEY_BYTES - buf.length), buf]);
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * HKDF-Expand for the single-block case. Every derivation RFC 8291 and
 * RFC 8188 ask for here is 32 bytes or fewer, so the general multi-block
 * algorithm is unneeded -- this is HKDF's own T(1) = HMAC(PRK, info || 0x01),
 * truncated to `length`, exactly as both RFCs write it out.
 */
function hkdfExpandOneBlock(prk, info, length) {
  if (length > 32) throw new Error('hkdfExpandOneBlock: length beyond one HMAC-SHA-256 block is not supported here');
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);
}

function ecKeyObjectFromRaw(publicKey, privateKey) {
  const x = toBase64Url(publicKey.subarray(1, 33));
  const y = toBase64Url(publicKey.subarray(33, 65));
  if (privateKey) {
    return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x, y, d: toBase64Url(leftPad32(privateKey)) }, format: 'jwk' });
  }
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
}

// ------------------------------------------------------------- key pairs --

/**
 * A fresh P-256 key pair, usable either as a VAPID signing identity or as a
 * message's ephemeral ECDH key -- never both at once for the same message.
 * @returns {{publicKey: Buffer, privateKey: Buffer}} publicKey is the 65-byte
 *   uncompressed point; privateKey is the 32-byte scalar.
 */
export function generateP256KeyPair() {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey(), privateKey: leftPad32(ecdh.getPrivateKey()) };
}

/** An application server's VAPID identity keys. Mechanically generateP256KeyPair(); named separately so it reads as what it is used for. */
export const generateVapidKeys = generateP256KeyPair;

// ------------------------------------------------------- subscription in --

/**
 * Checks a push subscription strictly and returns its decoded keys, or
 * throws. Shared by buildPushRequest, so nothing downstream sees an
 * under-length key or a non-HTTPS endpoint.
 * @returns {{endpoint: string, p256dh: Buffer, auth: Buffer}}
 */
export function validateSubscription(subscription) {
  if (!isPlainObject(subscription)) throw new Error('a push subscription must be an object');
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== 'string' || endpoint === '') {
    throw new Error('subscription.endpoint is required');
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('subscription.endpoint is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('subscription.endpoint must be an https URL');
  }
  if (!isPlainObject(keys)) throw new Error('subscription.keys is required');
  const p256dh = decodeBase64Url(keys.p256dh, 'subscription.keys.p256dh');
  if (p256dh.length !== P256_PUBLIC_KEY_BYTES) {
    throw new Error(`subscription.keys.p256dh must decode to ${P256_PUBLIC_KEY_BYTES} bytes, got ${p256dh.length}`);
  }
  if (p256dh[0] !== 0x04) {
    throw new Error('subscription.keys.p256dh is not an uncompressed EC point (must start with 0x04)');
  }
  const auth = decodeBase64Url(keys.auth, 'subscription.keys.auth');
  if (auth.length !== AUTH_SECRET_BYTES) {
    throw new Error(`subscription.keys.auth must decode to ${AUTH_SECRET_BYTES} bytes, got ${auth.length}`);
  }
  return { endpoint, p256dh, auth };
}

// ------------------------------------------------- RFC 8291 / 8188 crypto --

/**
 * Encrypts one push message as a single aes128gcm record (RFC 8291, on the
 * RFC 8188 content coding). Returns the exact bytes to send as the request
 * body: an 86-octet header followed by the encrypted record.
 *
 * ephemeralKeys and salt are generated fresh if omitted -- they are
 * parameters, not hidden randomness, so RFC 8291 Appendix A's fixed values
 * can be injected to reproduce its worked example exactly.
 *
 * @param {object} args
 * @param {Buffer} args.plaintext
 * @param {Buffer} args.uaPublicKey - the subscription's p256dh, 65 bytes
 * @param {Buffer} args.authSecret - the subscription's auth secret, 16 bytes
 * @param {{publicKey: Buffer, privateKey: Buffer}} [args.ephemeralKeys] - this message's own P-256 pair; MUST NOT be the VAPID signing key
 * @param {Buffer} [args.salt] - 16 random bytes, unique per message
 * @param {number} [args.recordSize] - the aes128gcm "rs" parameter
 * @returns {Buffer}
 */
export function encryptPayload({
  plaintext,
  uaPublicKey,
  authSecret,
  ephemeralKeys = generateP256KeyPair(),
  salt = randomBytes(16),
  recordSize = RECORD_SIZE,
}) {
  if (!Buffer.isBuffer(plaintext)) throw new Error('plaintext must be a Buffer');
  if (!Buffer.isBuffer(uaPublicKey) || uaPublicKey.length !== P256_PUBLIC_KEY_BYTES) {
    throw new Error(`uaPublicKey must be a ${P256_PUBLIC_KEY_BYTES}-byte Buffer`);
  }
  if (!Buffer.isBuffer(authSecret) || authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`authSecret must be a ${AUTH_SECRET_BYTES}-byte Buffer`);
  }
  if (!Number.isInteger(recordSize) || recordSize < 18) {
    throw new Error('recordSize must be an integer of at least 18 octets (RFC 8188 section 2.1)');
  }
  if (!Buffer.isBuffer(salt) || salt.length !== 16) {
    throw new Error('salt must be a 16-byte Buffer');
  }
  if (!isPlainObject(ephemeralKeys) || !Buffer.isBuffer(ephemeralKeys.publicKey) || ephemeralKeys.publicKey.length !== P256_PUBLIC_KEY_BYTES
    || !Buffer.isBuffer(ephemeralKeys.privateKey)) {
    throw new Error('ephemeralKeys.publicKey (65 bytes) and ephemeralKeys.privateKey are required');
  }
  // RFC 8291 section 4: "rs" MUST be strictly greater than plaintext + the
  // padding delimiter (1 octet) + the AEAD tag (16 octets) -- rs equal to
  // that sum is not allowed, hence the "- 1" (maxPlaintext is the largest
  // value still strictly less than recordSize once delimiter and tag are added).
  const maxPlaintext = recordSize - GCM_TAG_BYTES - PADDING_DELIMITER_BYTES - 1;
  if (plaintext.length > maxPlaintext) {
    throw new Error(`payload of ${plaintext.length} bytes does not fit in a single ${recordSize}-byte record (max ${maxPlaintext} bytes)`);
  }
  const asPublicKey = ephemeralKeys.publicKey;

  // RFC 8291 section 3.1: the shared secret from this message's ECDH pair
  // and the subscription's public key.
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(leftPad32(ephemeralKeys.privateKey));
  const ecdhSecret = ecdh.computeSecret(uaPublicKey);

  // RFC 8291 section 3.3: combine the ECDH and authentication secrets into
  // the input keying material RFC 8188 asks for.
  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0x00]), uaPublicKey, asPublicKey]);
  const ikm = hkdfExpandOneBlock(prkKey, keyInfo, 32);

  // RFC 8188 sections 2.2 and 2.3: the content-encryption key and nonce.
  const prk = hmacSha256(salt, ikm);
  const cekInfo = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'ascii'), Buffer.from([0x00])]);
  const cek = hkdfExpandOneBlock(prk, cekInfo, 16);
  const nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce', 'ascii'), Buffer.from([0x00])]);
  // A push message is always a single record (RFC 8291 section 4), so the
  // record sequence number is always zero and there is nothing to XOR in.
  const nonce = hkdfExpandOneBlock(prk, nonceInfo, 12);

  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(recordSize, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublicKey.length]), asPublicKey]);

  // RFC 8188 section 2: a single, last record uses padding delimiter 0x02
  // and needs no filler padding beyond it.
  const recordPlaintext = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: GCM_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(recordPlaintext), cipher.final(), cipher.getAuthTag()]);

  return Buffer.concat([header, ciphertext]);
}

// ------------------------------------------------------- RFC 8292 (VAPID) --

function assertContact(contact) {
  if (typeof contact !== 'string' || !/^(mailto:|https:)/i.test(contact)) {
    throw new Error('a VAPID contact is required: a mailto: or https: URI naming who to contact about this application server (RFC 8292 section 2.1)');
  }
}

/**
 * Signs a VAPID JWT (RFC 8292 section 2) for one push service origin.
 * Refuses to run without a contact, and refuses to sign a token that would
 * outlive MAX_VAPID_EXPIRY_SECONDS.
 * @param {object} args
 * @param {string} args.audience - the push endpoint's origin
 * @param {string} args.contact - a mailto: or https: URI; required
 * @param {{publicKey: Buffer, privateKey: Buffer}} args.vapidKeys
 * @param {number} [args.expiresInSeconds]
 * @param {() => Date} [args.now]
 * @returns {string} the signed JWT ("header.body.signature", all base64url)
 */
export function signVapidJwt({ audience, contact, vapidKeys, expiresInSeconds = DEFAULT_VAPID_EXPIRY_SECONDS, now = () => new Date() }) {
  assertContact(contact);
  if (typeof audience !== 'string' || audience === '') {
    throw new Error('a VAPID audience (the push endpoint\'s origin) is required');
  }
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error('expiresInSeconds must be a positive number of seconds');
  }
  if (expiresInSeconds > MAX_VAPID_EXPIRY_SECONDS) {
    throw new Error(`a VAPID token cannot last more than ${MAX_VAPID_EXPIRY_SECONDS} seconds (24 hours, RFC 8292 section 2)`);
  }
  if (!isPlainObject(vapidKeys) || !Buffer.isBuffer(vapidKeys.publicKey) || !Buffer.isBuffer(vapidKeys.privateKey)) {
    throw new Error('vapidKeys.publicKey and vapidKeys.privateKey (Buffers) are required');
  }
  const nowSeconds = Math.floor(now().getTime() / 1000);
  const exp = nowSeconds + Math.floor(expiresInSeconds);
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const body = toBase64Url(Buffer.from(JSON.stringify({ aud: audience, exp, sub: contact }), 'utf8'));
  const signingInput = `${header}.${body}`;
  const key = ecKeyObjectFromRaw(vapidKeys.publicKey, vapidKeys.privateKey);
  // RFC 7518 ES256 is the fixed-width r||s form, not ASN.1/DER -- that is
  // what dsaEncoding: 'ieee-p1363' selects.
  const signature = signBytes('sha256', Buffer.from(signingInput, 'ascii'), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${toBase64Url(signature)}`;
}

/** The `Authorization: vapid t=<jwt>, k=<publicKey>` header value (RFC 8292 section 3). */
export function buildVapidAuthorizationHeader({ audience, contact, vapidKeys, expiresInSeconds, now }) {
  const jwt = signVapidJwt({ audience, contact, vapidKeys, expiresInSeconds, now });
  return `vapid t=${jwt}, k=${toBase64Url(vapidKeys.publicKey)}`;
}

// ------------------------------------------------------------ the request --

/**
 * Assembles the HTTP request for one push message. Does not send it --
 * sendPush does that with this function's output.
 * @param {object} args
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} args.subscription
 * @param {Buffer|string} args.payload
 * @param {{publicKey: Buffer, privateKey: Buffer}} args.vapidKeys - this application server's identity; never the message's ephemeral key
 * @param {string} args.contact - a mailto: or https: URI; required
 * @param {number} args.ttlSeconds - the TTL header (RFC 8030 section 5.2); required, a non-negative integer
 * @param {'very-low'|'low'|'normal'|'high'} [args.urgency] - default "normal" (RFC 8030 section 5.3)
 * @param {() => Date} [args.now]
 * @param {{publicKey: Buffer, privateKey: Buffer}} [args.ephemeralKeys] - injected for the harness; generated if omitted
 * @param {Buffer} [args.salt] - injected for the harness; generated if omitted
 * @param {number} [args.expiresInSeconds] - the VAPID token's lifetime
 * @returns {{url: string, method: 'POST', headers: Record<string,string>, body: Buffer}}
 */
export function buildPushRequest({
  subscription,
  payload,
  vapidKeys,
  contact,
  ttlSeconds,
  urgency = 'normal',
  now = () => new Date(),
  ephemeralKeys,
  salt,
  expiresInSeconds,
}) {
  const sub = validateSubscription(subscription);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
    throw new Error('ttlSeconds must be a non-negative integer (RFC 8030 section 5.2, the TTL header)');
  }
  if (!VALID_URGENCIES.has(urgency)) {
    throw new Error(`urgency must be one of ${[...VALID_URGENCIES].join(', ')} (RFC 8030 section 5.3)`);
  }
  const plaintext = Buffer.isBuffer(payload) ? payload
    : typeof payload === 'string' ? Buffer.from(payload, 'utf8')
      : (() => { throw new Error('payload must be a Buffer or a string'); })();

  const resolvedEphemeralKeys = ephemeralKeys ?? generateP256KeyPair();
  // RFC 8292 section 3.2: the key exchange key and the VAPID signing key
  // MUST be different keys. Catching a caller passing the same pair for
  // both here is cheaper than waiting for the push service to reject it.
  if (isPlainObject(vapidKeys) && Buffer.isBuffer(vapidKeys.publicKey)
    && Buffer.compare(resolvedEphemeralKeys.publicKey, vapidKeys.publicKey) === 0) {
    throw new Error('the ephemeral encryption key must not be the same key as the VAPID signing key (RFC 8292 section 3.2)');
  }
  const body = encryptPayload({ plaintext, uaPublicKey: sub.p256dh, authSecret: sub.auth, ephemeralKeys: resolvedEphemeralKeys, salt });
  const audience = new URL(sub.endpoint).origin;
  const authorization = buildVapidAuthorizationHeader({ audience, contact, vapidKeys, expiresInSeconds, now });

  return {
    url: sub.endpoint,
    method: 'POST',
    headers: {
      TTL: String(ttlSeconds),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Urgency: urgency,
      Authorization: authorization,
    },
    body,
  };
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

/**
 * Sends one push message and interprets the push service's response.
 * Takes everything buildPushRequest takes, plus fetchFn.
 * @param {object} args
 * @param {typeof fetch} [args.fetchFn] - injected for the harness; defaults to the global fetch
 * @returns {Promise<{outcome: 'sent'|'gone'|'too_large'|'rate_limited'|'failed', status: number, message?: string, retryAfterSeconds?: number|null}>}
 */
export async function sendPush(args) {
  const { fetchFn = globalThis.fetch } = args ?? {};
  if (typeof fetchFn !== 'function') {
    throw new Error('no fetch is available; pass fetchFn (this Node has no global fetch)');
  }
  const request = buildPushRequest(args);
  let response;
  try {
    response = await fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body });
  } catch (err) {
    throw new Error(`could not reach the push service: ${err.message}`);
  }
  const status = response.status;
  if (status === 201 || status === 202) {
    return { outcome: 'sent', status };
  }
  if (status === 404 || status === 410) {
    return { outcome: 'gone', status, message: 'the push service no longer has this subscription; the caller must delete it' };
  }
  if (status === 413) {
    return { outcome: 'too_large', status, message: 'the push service rejected the payload as too large' };
  }
  if (status === 429) {
    const header = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null;
    return { outcome: 'rate_limited', status, retryAfterSeconds: parseRetryAfter(header), message: 'the push service is rate-limiting this application server' };
  }
  let detail = '';
  try {
    if (typeof response.text === 'function') detail = await response.text();
  } catch {
    // the body could not be read; report the status alone
  }
  return { outcome: 'failed', status, message: `push service returned ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
}
