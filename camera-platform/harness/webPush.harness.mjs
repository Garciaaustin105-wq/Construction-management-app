// harness/webPush.harness.mjs
//
// agent/web-push.mjs's RFC compliance, checked against sources the module
// itself never sees:
//
// - RFC 8291 Appendix A's worked example, reproduced byte for byte by
//   injecting its fixed keys and salt into encryptPayload().
// - A receiver-side "aes128gcm" decrypt written here, independently, from
//   RFC 8188 section 2 -- not by importing anything from web-push.mjs's
//   encryption path -- so the round-trip check is a real cross-check and
//   not the same code agreeing with itself.
// - A VAPID JWT verifier written here from RFC 8292 section 2, checked
//   against node:crypto's own ECDSA verify with dsaEncoding: 'ieee-p1363'.
//
// The failures feared, in order: a wrong intermediate value anywhere in the
// HKDF chain (caught by Appendix A, which gives every intermediate, not
// just the final bytes); an encrypt/decrypt pair that only looks correct
// because both sides share the same bug (caught by writing decrypt from the
// RFC text, not from web-push.mjs); a subscription or oversize payload that
// is silently accepted instead of refused; a push service response code
// mapped to the wrong outcome; and a secret -- the subscription's auth
// value or any private key -- surfacing in a thrown error message.
//
// Three checks below are mutation checks: they build a deliberately wrong
// variant by hand (a swapped HKDF info string, a padding delimiter that
// isn't 0x02, a DER-encoded JWT signature instead of ieee-p1363) and assert
// that the independent decrypt()/verifyVapidJwt() in this file actually
// rejects it. That is what proves the earlier round-trip and verify checks
// are discriminating, rather than passing no matter what either side does.

import {
  createECDH, createHmac, createCipheriv, createDecipheriv,
  createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes, randomBytes,
} from 'node:crypto';
import {
  encryptPayload, generateP256KeyPair, generateVapidKeys, signVapidJwt,
  buildVapidAuthorizationHeader, buildPushRequest, sendPush, validateSubscription,
  toBase64Url, RECORD_SIZE, MAX_PLAINTEXT_BYTES, MAX_VAPID_EXPIRY_SECONDS,
} from '../agent/web-push.mjs';
import { check, eq, close, throws, report } from './_assert.mjs';

console.log('webPush');

// ---------------------------------------------------------- local helpers --
// Deliberately not imported from web-push.mjs -- see the file header.

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}
function hkdfExpandOneBlock(prk, info, length) {
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);
}
function b64u(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * The receiver side of RFC 8291/8188: given a message body and the
 * subscriber's own private key and auth secret, recovers the plaintext, or
 * throws. Enforces the two MUSTs RFC 8188 section 2 names explicitly: the
 * last (only) record's padding delimiter must be 0x02, and a record with no
 * non-zero octet at all is invalid.
 */
function decryptAes128Gcm(body, { uaPrivateKey, authSecret }) {
  if (!Buffer.isBuffer(body) || body.length < 86) {
    throw new Error('body is too short to hold an aes128gcm header');
  }
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  if (21 + idlen > body.length) throw new Error('keyid runs past the end of the body');
  const asPublicKey = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  if (record.length === 0 || record.length > rs) {
    throw new Error('the record is empty or longer than the declared record size');
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const uaPublicKey = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublicKey);

  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0]), uaPublicKey, asPublicKey]);
  const ikm = hkdfExpandOneBlock(prkKey, keyInfo, 32);
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpandOneBlock(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'ascii'), Buffer.from([0])]), 16);
  const nonce = hkdfExpandOneBlock(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce', 'ascii'), Buffer.from([0])]), 12);

  if (record.length < 16) throw new Error('record shorter than the AEAD tag');
  const tag = record.subarray(record.length - 16);
  const ciphertext = record.subarray(0, record.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const withDelimiter = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  let i = withDelimiter.length - 1;
  while (i >= 0 && withDelimiter[i] === 0x00) i--;
  if (i < 0) throw new Error('record has no non-zero padding delimiter octet');
  if (withDelimiter[i] !== 0x02) {
    throw new Error(`the only record's padding delimiter must be 0x02, got 0x${withDelimiter[i].toString(16)} (RFC 8188 section 2)`);
  }
  return withDelimiter.subarray(0, i);
}

/**
 * A hand-rolled RFC 8291 encrypt with every step overridable, used only to
 * build the deliberately-wrong bodies the mutation checks feed to
 * decryptAes128Gcm above. Never used to test web-push.mjs's own output.
 */
function handEncrypt({ plaintext, uaPublicKey, authSecret, asKeys, salt, delimiter = 0x02, keyInfo }) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(asKeys.privateKey);
  const ecdhSecret = ecdh.computeSecret(uaPublicKey);
  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const info = keyInfo ?? Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0]), uaPublicKey, asKeys.publicKey]);
  const ikm = hkdfExpandOneBlock(prkKey, info, 32);
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpandOneBlock(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'ascii'), Buffer.from([0])]), 16);
  const nonce = hkdfExpandOneBlock(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce', 'ascii'), Buffer.from([0])]), 12);
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asKeys.publicKey.length]), asKeys.publicKey]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([delimiter])])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, ciphertext]);
}

/** An EC public KeyObject built from the same raw (publicKey Buffer) shape web-push.mjs uses, for an independent verify. */
function ecPublicKeyObject(publicKey) {
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: toBase64Url(publicKey.subarray(1, 33)), y: toBase64Url(publicKey.subarray(33, 65)) },
    format: 'jwk',
  });
}
function ecPrivateKeyObject(publicKey, privateKey) {
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: toBase64Url(publicKey.subarray(1, 33)), y: toBase64Url(publicKey.subarray(33, 65)), d: toBase64Url(privateKey) },
    format: 'jwk',
  });
}

/**
 * Verifies a VAPID JWT against RFC 8292 section 2, independently of
 * signVapidJwt: parses the three parts by hand, checks alg/typ, verifies
 * the ES256 signature as ieee-p1363 (never DER), and checks aud/exp/sub.
 * @returns {{aud: string, exp: number, sub: string}} the checked claims
 */
function verifyVapidJwt(jwt, { publicKey, audience, now = new Date(), maxAgeSeconds = MAX_VAPID_EXPIRY_SECONDS }) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3) throw new Error('a JWT must have three base64url parts');
  const [h64, b64, s64] = parts;
  const header = JSON.parse(Buffer.from(h64, 'base64url').toString('utf8'));
  if (header.alg !== 'ES256') throw new Error(`unexpected alg: ${header.alg}`);
  if (header.typ !== 'JWT') throw new Error(`unexpected typ: ${header.typ}`);
  const claims = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  const signature = Buffer.from(s64, 'base64url');
  if (signature.length !== 64) throw new Error(`an ES256/ieee-p1363 signature is 64 bytes, got ${signature.length}`);
  const ok = verifyBytes('sha256', Buffer.from(`${h64}.${b64}`, 'ascii'), { key: ecPublicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' }, signature);
  if (!ok) throw new Error('the JWT signature does not verify');
  if (claims.aud !== audience) throw new Error(`aud mismatch: expected ${audience}, got ${claims.aud}`);
  if (!Number.isInteger(claims.exp)) throw new Error('exp is missing or not an integer');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSeconds) throw new Error('the token has already expired');
  if (claims.exp - nowSeconds > maxAgeSeconds + 5) throw new Error('exp is more than the allowed lifetime ahead (RFC 8292 section 2)');
  return claims;
}

function freshSubscription() {
  const ua = generateP256KeyPair();
  return {
    ua,
    subscription: {
      endpoint: 'https://push.example.net/subscription-1',
      keys: { p256dh: toBase64Url(ua.publicKey), auth: toBase64Url(randomBytes(16)) },
    },
  };
}

// ============================================================ RFC 8291 ===
// Appendix A's fixed inputs and every intermediate value it publishes, so a
// wrong step anywhere in the chain fails at the step where it is wrong.

const RFC8291 = {
  plaintext: b64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPublic: b64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  asPrivate: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  uaPublic: b64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  uaPrivate: b64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  salt: b64u('DGv6ra1nlYgDCS1FRnbzlw'),
  authSecret: b64u('BTBZMqHH6r4Tts7J_aSIgg'),
  fullBody: b64u('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'),
};

// Every intermediate value Appendix A publishes by name, so a wrong step
// anywhere in the HKDF chain is caught at the step where it is wrong, not
// inferred after the fact from the final ciphertext happening to match.
const RFC8291_INTERMEDIATE = {
  ecdhSecret: b64u('kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs'),
  prkKey: b64u('Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k'),
  ikm: b64u('S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg'),
  prk: b64u('09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc'),
  cek: b64u('oIhVW04MRdy2XN9CiKLxTg'),
  nonce: b64u('4h_95klXJ5E_qnoN'),
};

await check('RFC 8291 Appendix A inputs decode to the lengths the RFC states', () => {
  eq(RFC8291.asPublic.length, 65, 'as_public');
  eq(RFC8291.uaPublic.length, 65, 'ua_public');
  eq(RFC8291.salt.length, 16, 'salt');
  eq(RFC8291.authSecret.length, 16, 'auth_secret');
  eq(RFC8291.plaintext.toString('utf8'), 'When I grow up, I want to be a watermelon', 'plaintext');
});

await check('encryptPayload reproduces RFC 8291 Appendix A / Section 5 byte for byte', () => {
  const body = encryptPayload({
    plaintext: RFC8291.plaintext,
    uaPublicKey: RFC8291.uaPublic,
    authSecret: RFC8291.authSecret,
    ephemeralKeys: { publicKey: RFC8291.asPublic, privateKey: RFC8291.asPrivate },
    salt: RFC8291.salt,
  });
  eq(body.length, RFC8291.fullBody.length, 'body length (86-byte header + 41 plaintext + 1 delimiter + 16 tag = 144)');
  eq(Buffer.compare(body, RFC8291.fullBody), 0, 'the full body, byte for byte, against RFC 8291 Section 5');
  // The header alone: salt || rs (4096, big-endian) || idlen (65) || as_public.
  eq(Buffer.compare(body.subarray(0, 16), RFC8291.salt), 0, 'header salt');
  eq(body.readUInt32BE(16), 4096, 'header rs');
  eq(body.readUInt8(20), 65, 'header idlen');
  eq(Buffer.compare(body.subarray(21, 86), RFC8291.asPublic), 0, 'header keyid (as_public)');
});

await check('every named intermediate value in RFC 8291 Appendix A is independently reproduced, step by step', () => {
  // Computed here from the RFC's own Section 3.4 pseudocode, using only this
  // file's local helpers -- not encryptPayload -- since encryptPayload does
  // not (and should not) expose its internal state. Matching the RFC's final
  // 144-byte body (previous check) plus matching every named step here, both
  // against the RFC text directly rather than against each other, is what
  // rules out a compensating pair of mistakes that only look right together.
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(RFC8291.asPrivate);
  const ecdhSecret = ecdh.computeSecret(RFC8291.uaPublic);
  eq(Buffer.compare(ecdhSecret, RFC8291_INTERMEDIATE.ecdhSecret), 0, 'ecdh_secret');

  const prkKey = hmacSha256(RFC8291.authSecret, ecdhSecret);
  eq(Buffer.compare(prkKey, RFC8291_INTERMEDIATE.prkKey), 0, 'PRK_key');

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0x00]), RFC8291.uaPublic, RFC8291.asPublic]);
  const ikm = hkdfExpandOneBlock(prkKey, keyInfo, 32);
  eq(Buffer.compare(ikm, RFC8291_INTERMEDIATE.ikm), 0, 'IKM');

  const prk = hmacSha256(RFC8291.salt, ikm);
  eq(Buffer.compare(prk, RFC8291_INTERMEDIATE.prk), 0, 'PRK');

  const cekInfo = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'ascii'), Buffer.from([0x00])]);
  const cek = hkdfExpandOneBlock(prk, cekInfo, 16);
  eq(Buffer.compare(cek, RFC8291_INTERMEDIATE.cek), 0, 'CEK');

  const nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce', 'ascii'), Buffer.from([0x00])]);
  const nonce = hkdfExpandOneBlock(prk, nonceInfo, 12);
  eq(Buffer.compare(nonce, RFC8291_INTERMEDIATE.nonce), 0, 'NONCE');
});

await check('the RFC 8291 body decrypts, with this harness\'s own decrypt(), to the RFC\'s plaintext', () => {
  const body = encryptPayload({
    plaintext: RFC8291.plaintext,
    uaPublicKey: RFC8291.uaPublic,
    authSecret: RFC8291.authSecret,
    ephemeralKeys: { publicKey: RFC8291.asPublic, privateKey: RFC8291.asPrivate },
    salt: RFC8291.salt,
  });
  const plaintext = decryptAes128Gcm(body, { uaPrivateKey: RFC8291.uaPrivate, authSecret: RFC8291.authSecret });
  eq(plaintext.toString('utf8'), 'When I grow up, I want to be a watermelon');
  // And the RFC's own published body (not re-derived here) decrypts too.
  eq(decryptAes128Gcm(RFC8291.fullBody, { uaPrivateKey: RFC8291.uaPrivate, authSecret: RFC8291.authSecret }).toString('utf8'),
    'When I grow up, I want to be a watermelon');
});

// ================================================== round trip, at random ==

await check('encrypt/decrypt round-trips random payloads, random keys, random lengths', () => {
  for (let i = 0; i < 40; i++) {
    const ua = generateP256KeyPair();
    const authSecret = randomBytes(16);
    const len = i === 0 ? 0 : i === 1 ? MAX_PLAINTEXT_BYTES : Math.floor(Math.random() * MAX_PLAINTEXT_BYTES);
    const plaintext = randomBytes(len);
    const body = encryptPayload({ plaintext, uaPublicKey: ua.publicKey, authSecret });
    const recovered = decryptAes128Gcm(body, { uaPrivateKey: ua.privateKey, authSecret });
    eq(Buffer.compare(recovered, plaintext), 0, `round trip #${i}, ${len} bytes`);
  }
});

await check('the wrong auth secret fails to decrypt (the AEAD tag catches it)', () => {
  const ua = generateP256KeyPair();
  const authSecret = randomBytes(16);
  const body = encryptPayload({ plaintext: Buffer.from('a private message'), uaPublicKey: ua.publicKey, authSecret });
  throws(() => decryptAes128Gcm(body, { uaPrivateKey: ua.privateKey, authSecret: randomBytes(16) }), 'wrong auth secret');
});

await check('the wrong receiver private key fails to decrypt', () => {
  const ua = generateP256KeyPair();
  const otherUa = generateP256KeyPair();
  const authSecret = randomBytes(16);
  const body = encryptPayload({ plaintext: Buffer.from('a private message'), uaPublicKey: ua.publicKey, authSecret });
  throws(() => decryptAes128Gcm(body, { uaPrivateKey: otherUa.privateKey, authSecret }), 'wrong receiver key');
});

// ============================================================ VAPID JWT ===

await check('a VAPID JWT verifies, with the right header, aud, exp and sub', () => {
  const vapidKeys = generateVapidKeys();
  const now = new Date('2026-01-01T00:00:00Z');
  const jwt = signVapidJwt({ audience: 'https://push.example.net', contact: 'mailto:staff@example.com', vapidKeys, now: () => now });
  const claims = verifyVapidJwt(jwt, { publicKey: vapidKeys.publicKey, audience: 'https://push.example.net', now });
  eq(claims.sub, 'mailto:staff@example.com');
  eq(claims.exp, Math.floor(now.getTime() / 1000) + 12 * 3600, 'default expiry is 12 hours ahead');
});

await check('an https: contact is accepted, not just mailto:', () => {
  const vapidKeys = generateVapidKeys();
  const jwt = signVapidJwt({ audience: 'https://push.example.net', contact: 'https://example.com/contact', vapidKeys });
  const claims = verifyVapidJwt(jwt, { publicKey: vapidKeys.publicKey, audience: 'https://push.example.net' });
  eq(claims.sub, 'https://example.com/contact');
});

await check('signVapidJwt refuses without a contact', () => {
  const vapidKeys = generateVapidKeys();
  throws(() => signVapidJwt({ audience: 'https://push.example.net', vapidKeys }), 'no contact');
  throws(() => signVapidJwt({ audience: 'https://push.example.net', contact: '', vapidKeys }), 'empty contact');
  throws(() => signVapidJwt({ audience: 'https://push.example.net', contact: 'not-a-uri', vapidKeys }), 'contact with no mailto:/https: scheme');
  throws(() => signVapidJwt({ audience: 'https://push.example.net', contact: 'tel:+15555550100', vapidKeys }), 'a tel: contact is not mailto:/https:');
});

await check('signVapidJwt refuses an expiry beyond 24 hours, and a non-positive one', () => {
  const vapidKeys = generateVapidKeys();
  throws(() => signVapidJwt({ audience: 'https://push.example.net', contact: 'mailto:a@example.com', vapidKeys, expiresInSeconds: MAX_VAPID_EXPIRY_SECONDS + 1 }), 'over 24h');
  throws(() => signVapidJwt({ audience: 'https://push.example.net', contact: 'mailto:a@example.com', vapidKeys, expiresInSeconds: 0 }), 'zero');
  throws(() => signVapidJwt({ audience: 'https://push.example.net', contact: 'mailto:a@example.com', vapidKeys, expiresInSeconds: -1 }), 'negative');
  // exactly 24h is allowed
  const jwt = signVapidJwt({ audience: 'https://push.example.net', contact: 'mailto:a@example.com', vapidKeys, expiresInSeconds: MAX_VAPID_EXPIRY_SECONDS });
  verifyVapidJwt(jwt, { publicKey: vapidKeys.publicKey, audience: 'https://push.example.net' });
});

await check('the Authorization header is "vapid t=<jwt>, k=<public key>", and k is the VAPID public key', () => {
  const vapidKeys = generateVapidKeys();
  const header = buildVapidAuthorizationHeader({ audience: 'https://push.example.net', contact: 'mailto:a@example.com', vapidKeys });
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (!m) throw new Error(`header does not match "vapid t=..., k=...": ${header}`);
  eq(Buffer.compare(Buffer.from(m[2], 'base64url'), vapidKeys.publicKey), 0, 'k decodes to the VAPID public key');
  verifyVapidJwt(m[1], { publicKey: vapidKeys.publicKey, audience: 'https://push.example.net' });
});

// ==================================================== bad subscriptions ===

await check('bad subscriptions are refused', () => {
  const ua = generateP256KeyPair();
  const goodP256dh = toBase64Url(ua.publicKey);
  const goodAuth = toBase64Url(randomBytes(16));

  throws(() => validateSubscription(null), 'not an object');
  throws(() => validateSubscription({}), 'no endpoint');
  throws(() => validateSubscription({ endpoint: 'http://push.example.net/x', keys: { p256dh: goodP256dh, auth: goodAuth } }), 'http, not https, endpoint');
  throws(() => validateSubscription({ endpoint: 'ftp://push.example.net/x', keys: { p256dh: goodP256dh, auth: goodAuth } }), 'non-http(s) scheme');
  throws(() => validateSubscription({ endpoint: 'not a url at all', keys: { p256dh: goodP256dh, auth: goodAuth } }), 'unparseable endpoint');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x' }), 'no keys');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: {} }), 'empty keys');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: toBase64Url(Buffer.alloc(64, 4)), auth: goodAuth } }), 'p256dh one byte short (64)');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: toBase64Url(Buffer.alloc(66, 4)), auth: goodAuth } }), 'p256dh one byte long (66)');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: toBase64Url(Buffer.concat([Buffer.from([0x03]), Buffer.alloc(64)])), auth: goodAuth } }), 'p256dh not starting with 0x04 (a compressed point)');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: goodP256dh, auth: toBase64Url(Buffer.alloc(15)) } }), 'auth one byte short (15)');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: goodP256dh, auth: toBase64Url(Buffer.alloc(17)) } }), 'auth one byte long (17)');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: 'not base64url!!', auth: goodAuth } }), 'p256dh has non-base64url characters');
  throws(() => validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: goodP256dh, auth: '' } }), 'empty auth string');

  // A valid subscription is accepted and returns decoded keys.
  const ok = validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: goodP256dh, auth: goodAuth } });
  eq(ok.p256dh.length, 65);
  eq(ok.auth.length, 16);
});

await check('buildPushRequest refuses the same bad subscriptions', () => {
  const vapidKeys = generateVapidKeys();
  const base = { payload: 'hi', vapidKeys, contact: 'mailto:a@example.com', ttlSeconds: 0 };
  throws(() => buildPushRequest({ ...base, subscription: { endpoint: 'http://push.example.net/x', keys: { p256dh: toBase64Url(generateP256KeyPair().publicKey), auth: toBase64Url(randomBytes(16)) } } }), 'http endpoint via buildPushRequest');
});

// ======================================================== oversize payload =

await check('a payload that does not fit in one record is refused; the exact-fit boundary is accepted', () => {
  const { subscription } = freshSubscription();
  const vapidKeys = generateVapidKeys();
  const base = { subscription, vapidKeys, contact: 'mailto:a@example.com', ttlSeconds: 0 };
  throws(() => buildPushRequest({ ...base, payload: Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 1) }), `${MAX_PLAINTEXT_BYTES + 1} bytes, one over the limit`);
  const req = buildPushRequest({ ...base, payload: Buffer.alloc(MAX_PLAINTEXT_BYTES, 1) });
  // RECORD_SIZE bounds the encrypted record (delimiter + tag included), not
  // the 86-byte header on top of it -- so the full body is header + record,
  // and the record itself must be strictly less than RECORD_SIZE.
  const recordLength = req.body.length - 86;
  eq(recordLength < RECORD_SIZE, true, `the record (${recordLength} bytes) is strictly less than RECORD_SIZE, as RFC 8291 section 4 requires`);
  eq(recordLength, MAX_PLAINTEXT_BYTES + 1 /* delimiter */ + 16 /* AEAD tag */, 'record length at the exact-fit boundary');
  // A tiny, empty and TTL/urgency/contact sanity pass too.
  buildPushRequest({ ...base, payload: '' });
  buildPushRequest({ ...base, payload: Buffer.alloc(0) });
});

await check('ttlSeconds and urgency are checked', () => {
  const { subscription } = freshSubscription();
  const vapidKeys = generateVapidKeys();
  const base = { subscription, payload: 'hi', vapidKeys, contact: 'mailto:a@example.com' };
  throws(() => buildPushRequest({ ...base, ttlSeconds: -1 }), 'negative TTL');
  throws(() => buildPushRequest({ ...base, ttlSeconds: 1.5 }), 'non-integer TTL');
  throws(() => buildPushRequest({ ...base, ttlSeconds: undefined }), 'missing TTL');
  throws(() => buildPushRequest({ ...base, ttlSeconds: 0, urgency: 'urgent' }), 'urgency not one of the four RFC 8030 values');
  const req = buildPushRequest({ ...base, ttlSeconds: 300, urgency: 'high' });
  eq(req.headers.TTL, '300');
  eq(req.headers.Urgency, 'high');
  const defaultReq = buildPushRequest({ ...base, ttlSeconds: 0 });
  eq(defaultReq.headers.Urgency, 'normal', 'urgency defaults to normal');
});

await check('the ephemeral encryption key must not be the VAPID signing key', () => {
  const vapidKeys = generateVapidKeys();
  const { subscription } = freshSubscription();
  throws(() => buildPushRequest({
    subscription, payload: 'hi', vapidKeys, contact: 'mailto:a@example.com', ttlSeconds: 0, ephemeralKeys: vapidKeys,
  }), 'ephemeral key equal to the VAPID key (RFC 8292 section 3.2)');
});

// ================================================== response code mapping =

function fakeResponse(status, { retryAfter = null, text = '' } = {}) {
  return { status, headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? retryAfter : null) }, text: async () => text };
}

async function sendWithStatus(status, opts) {
  const { subscription } = freshSubscription();
  const vapidKeys = generateVapidKeys();
  return sendPush({
    subscription, payload: 'hello', vapidKeys, contact: 'mailto:a@example.com', ttlSeconds: 0,
    fetchFn: async () => fakeResponse(status, opts),
  });
}

await check('201 and 202 both mean sent', async () => {
  eq((await sendWithStatus(201)).outcome, 'sent');
  eq((await sendWithStatus(202)).outcome, 'sent');
});

await check('404 and 410 mean the subscription is gone', async () => {
  eq((await sendWithStatus(404)).outcome, 'gone');
  eq((await sendWithStatus(410)).outcome, 'gone');
});

await check('413 means the payload was too large', async () => {
  eq((await sendWithStatus(413)).outcome, 'too_large');
});

await check('429 reports rate_limited, with Retry-After as delta-seconds', async () => {
  const r = await sendWithStatus(429, { retryAfter: '120' });
  eq(r.outcome, 'rate_limited');
  eq(r.retryAfterSeconds, 120);
});

await check('429 reports rate_limited, with Retry-After as an HTTP-date', async () => {
  const future = new Date(Date.now() + 90_000);
  const r = await sendWithStatus(429, { retryAfter: future.toUTCString() });
  eq(r.outcome, 'rate_limited');
  close(r.retryAfterSeconds, 90, 3, 'retryAfterSeconds derived from an HTTP-date');
});

await check('429 with no Retry-After still reports rate_limited, with a null retry time', async () => {
  const r = await sendWithStatus(429);
  eq(r.outcome, 'rate_limited');
  eq(r.retryAfterSeconds, null);
});

await check('other statuses are reported as failed, naming the status and body', async () => {
  const r = await sendWithStatus(500, { text: 'internal error' });
  eq(r.outcome, 'failed');
  eq(r.status, 500);
  eq(r.message.includes('500'), true, 'status named in the message');
  eq(r.message.includes('internal error'), true, 'body text included');
});

await check('sendPush surfaces a fetch/network failure as a rejection, not a status', async () => {
  const { subscription } = freshSubscription();
  const vapidKeys = generateVapidKeys();
  let threw = null;
  try {
    await sendPush({
      subscription, payload: 'hello', vapidKeys, contact: 'mailto:a@example.com', ttlSeconds: 0,
      fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    });
  } catch (err) { threw = err; }
  if (!threw) throw new Error('expected sendPush to reject');
  eq(threw.message.includes('ECONNREFUSED'), true, 'the underlying reason is preserved');
});

// ============================================ no secret in any refusal ===

await check('no thrown message anywhere leaks the auth secret or a private key', () => {
  const markAuth = randomBytes(16);
  const markAuthB64 = toBase64Url(markAuth);
  const markPriv = randomBytes(32);
  const markPrivB64 = toBase64Url(markPriv);
  const ua = generateP256KeyPair();
  const decoyEphemeral = generateP256KeyPair();

  const cases = [
    ['bad p256dh length, alongside a marked auth secret', () =>
      validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: toBase64Url(Buffer.alloc(10, 1)), auth: markAuthB64 } })],
    ['auth one byte short, given as the marked secret truncated', () =>
      validateSubscription({ endpoint: 'https://push.example.net/x', keys: { p256dh: toBase64Url(ua.publicKey), auth: toBase64Url(markAuth.subarray(0, 15)) } })],
    ['encryptPayload, oversize payload, with a marked ephemeral private key', () =>
      encryptPayload({ plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES + 5, 1), uaPublicKey: ua.publicKey, authSecret: markAuth, ephemeralKeys: { publicKey: decoyEphemeral.publicKey, privateKey: markPriv } })],
    ['signVapidJwt, no contact, with a marked private key', () =>
      signVapidJwt({ audience: 'https://push.example.net', vapidKeys: { publicKey: decoyEphemeral.publicKey, privateKey: markPriv } })],
    ['signVapidJwt, expiry too long, with a marked private key', () =>
      signVapidJwt({ audience: 'https://push.example.net', contact: 'mailto:a@example.com', expiresInSeconds: MAX_VAPID_EXPIRY_SECONDS + 1, vapidKeys: { publicKey: decoyEphemeral.publicKey, privateKey: markPriv } })],
  ];

  for (const [label, fn] of cases) {
    let threw = null;
    try { fn(); } catch (err) { threw = err; }
    if (!threw) throw new Error(`${label}: expected it to throw`);
    if (threw.message.includes(markAuthB64)) throw new Error(`${label}: thrown message leaked the auth secret: ${threw.message}`);
    if (threw.message.includes(markPrivB64)) throw new Error(`${label}: thrown message leaked the private key: ${threw.message}`);
  }
});

// ===================================================== mutation checks ===
// Each check below builds a deliberately wrong variant by hand and confirms
// that this file's independent decrypt()/verify() rejects it -- proof that
// the earlier checks are actually sensitive to these details.

await check('mutation: swapping ua_public/as_public in the HKDF info string breaks decryption', () => {
  const ua = generateP256KeyPair();
  const asKeys = generateP256KeyPair();
  const authSecret = randomBytes(16);
  const salt = randomBytes(16);
  const plaintext = Buffer.from('mutation probe for the HKDF info string', 'utf8');

  const wrongInfo = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0]), asKeys.publicKey, ua.publicKey]); // as||ua, not ua||as
  const brokenBody = handEncrypt({ plaintext, uaPublicKey: ua.publicKey, authSecret, asKeys, salt, keyInfo: wrongInfo });
  throws(() => decryptAes128Gcm(brokenBody, { uaPrivateKey: ua.privateKey, authSecret }), 'body built with the wrong HKDF info string order');

  // The real function, given the identical inputs, does not produce this body, and its own output decrypts correctly.
  const realBody = encryptPayload({ plaintext, uaPublicKey: ua.publicKey, authSecret, ephemeralKeys: asKeys, salt });
  eq(Buffer.compare(realBody, brokenBody) === 0, false, 'the correct implementation must not match the broken one');
  eq(decryptAes128Gcm(realBody, { uaPrivateKey: ua.privateKey, authSecret }).toString('utf8'), plaintext.toString('utf8'));
});

await check('mutation: a missing 0x00 separator in the HKDF info string breaks decryption', () => {
  const ua = generateP256KeyPair();
  const asKeys = generateP256KeyPair();
  const authSecret = randomBytes(16);
  const salt = randomBytes(16);
  const plaintext = Buffer.from('mutation probe for the info separator', 'utf8');
  const wrongInfo = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), ua.publicKey, asKeys.publicKey]); // no 0x00 before ua_public
  const brokenBody = handEncrypt({ plaintext, uaPublicKey: ua.publicKey, authSecret, asKeys, salt, keyInfo: wrongInfo });
  throws(() => decryptAes128Gcm(brokenBody, { uaPrivateKey: ua.privateKey, authSecret }), 'body built with the missing separator octet');
});

await check('mutation: a padding delimiter other than 0x02 on the only record is caught', () => {
  const ua = generateP256KeyPair();
  const asKeys = generateP256KeyPair();
  const authSecret = randomBytes(16);
  const salt = randomBytes(16);
  const plaintext = Buffer.from('mutation probe for the padding delimiter', 'utf8');

  throws(() => decryptAes128Gcm(handEncrypt({ plaintext, uaPublicKey: ua.publicKey, authSecret, asKeys, salt, delimiter: 0x01 }), { uaPrivateKey: ua.privateKey, authSecret }), 'delimiter 0x01 (a non-final-record value) on the only record');
  throws(() => decryptAes128Gcm(handEncrypt({ plaintext, uaPublicKey: ua.publicKey, authSecret, asKeys, salt, delimiter: 0x00 }), { uaPrivateKey: ua.privateKey, authSecret }), 'delimiter 0x00');
  throws(() => decryptAes128Gcm(handEncrypt({ plaintext, uaPublicKey: ua.publicKey, authSecret, asKeys, salt, delimiter: 0x03 }), { uaPrivateKey: ua.privateKey, authSecret }), 'delimiter 0x03');

  const goodBody = handEncrypt({ plaintext, uaPublicKey: ua.publicKey, authSecret, asKeys, salt, delimiter: 0x02 });
  eq(decryptAes128Gcm(goodBody, { uaPrivateKey: ua.privateKey, authSecret }).toString('utf8'), plaintext.toString('utf8'), 'delimiter 0x02 is accepted');
  // And the real encryptPayload always uses 0x02: its own output over the same inputs matches the hand-built good body.
  const realBody = encryptPayload({ plaintext, uaPublicKey: ua.publicKey, authSecret, ephemeralKeys: asKeys, salt });
  eq(Buffer.compare(realBody, goodBody), 0, 'encryptPayload uses the 0x02 delimiter, matching the hand-built body');
});

await check('mutation: a DER-encoded ES256 signature (not ieee-p1363) is rejected by the JWT verifier', () => {
  const vapidKeys = generateVapidKeys();
  const audience = 'https://push.example.net';
  const contact = 'mailto:a@example.com';
  const claims = { aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, sub: contact };
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const body = toBase64Url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signingInput = `${header}.${body}`;
  const key = ecPrivateKeyObject(vapidKeys.publicKey, vapidKeys.privateKey);

  // The wrong encoding: node's default is ASN.1 DER, not the JWS/RFC 7518 fixed-width r||s form.
  const derSignature = signBytes('sha256', Buffer.from(signingInput, 'ascii'), { key });
  eq(derSignature.length === 64, false, 'a DER signature is not 64 bytes, unlike ieee-p1363');
  const derJwt = `${signingInput}.${toBase64Url(derSignature)}`;
  throws(() => verifyVapidJwt(derJwt, { publicKey: vapidKeys.publicKey, audience }), 'DER-encoded signature must not verify as ieee-p1363');

  // The real signVapidJwt uses the correct encoding and does verify.
  const goodJwt = signVapidJwt({ audience, contact, vapidKeys });
  verifyVapidJwt(goodJwt, { publicKey: vapidKeys.publicKey, audience });
});

report('webPush');
