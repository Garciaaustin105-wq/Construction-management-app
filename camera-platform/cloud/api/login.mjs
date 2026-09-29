/**
 * `POST /login`, `POST /logout`, and `principalFromEvent` -- installer sign-in
 * for the cloud (cloud/CLOUD-LOGIN-SPEC.md, "C. cloud/api/login.mjs"). AWS
 * Lambda / API Gateway HTTP API v2 style: every handler here depends only on
 * injected `deps`, exactly like cloud/api/claim.mjs and cloud/api/fleet.mjs.
 *
 * FEARED (cloud/harness/apiLogin.harness.mjs's own header): a prober telling
 * "no such account" from "wrong password" by the response OR by how long
 * scrypt takes; a lockout that only real accounts get (which itself reveals
 * that the account exists); the right password getting in during a lock; one
 * good login wiping a sprayer's count; a session that outlives a reset, a
 * disable, 12 idle hours or 7 days; a token or password reaching a log line;
 * a store write on every request instead of once per five minutes.
 *
 * The pure rules this file calls (never reimplements) live in
 * cloud/contracts/auth.ts, compiled to cloud/dist/cloud/contracts/auth.js and
 * imported lazily below, the same pattern cloud/api/claim.mjs uses for
 * cloud/contracts/claimCode.ts -- this file is plain ESM and must load even
 * before `tsc` has run once. Hashing a password and minting a session token
 * are I/O, so they live here rather than in the pure contract: `deps.scrypt`
 * and `deps.randomBytes` are injected so a test can count scrypt calls and
 * fake randomness. `agent/auth.mjs` (the box's own reference) cannot be
 * imported from the cloud -- its cookie-parsing rules are copied below
 * (`parseCookies`), not re-implemented differently.
 *
 * See cloud/CLOUD-LOGIN-SPEC.md section C for the full contract, and
 * cloud/harness/apiLogin.harness.mjs for the checks it must pass.
 */

import { randomBytes as nodeRandomBytes, createHash, timingSafeEqual, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const SESSION_COOKIE = "camplat_session";

/** 32 random bytes, base64url, handed to the browser once (CLOUD-LOGIN-SPEC.md
 *  section A "Sessions"). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** `application/json`, case-insensitive, optionally followed by `;` parameters
 *  (a charset, for instance). Anything else refuses the request before any
 *  JSON parsing is attempted -- requiring this exact media type means a
 *  cross-site HTML form (which can only POST
 *  `application/x-www-form-urlencoded` or `multipart/form-data`) can never
 *  submit a login. */
const CONTENT_TYPE_RE = /^application\/json\s*(;.*)?$/i;

/** `node:crypto`'s scrypt, promisified to the signature
 *  `scrypt(password, salt, keylen, options) -> Promise<Buffer>` that
 *  `deps.scrypt` is documented to have (CLOUD-LOGIN-SPEC.md section C) --
 *  the default when a test does not inject its own counting wrapper. */
const defaultScrypt = promisify(scryptCb);

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Cookie header -> `{ name: value }`, first occurrence wins, never throws.
 * Copied from `agent/auth.mjs`'s `parseCookies` rules -- `agent/auth.mjs`
 * itself cannot be imported from the cloud (CLOUD-LOGIN-SPEC.md section C),
 * so this is a deliberate copy, not a reimplementation from scratch, so a
 * cookie header either side sends parses identically.
 */
function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eqAt = part.indexOf("=");
    if (eqAt < 1) continue;
    const name = part.slice(0, eqAt).trim();
    const value = part.slice(eqAt + 1).trim();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/**
 * A fixed, always-valid password record at the given scrypt cost. Used as
 * the stand-in whenever there is no real record to check against (an unknown
 * login, a login that does not normalize) or the stored one is corrupt --
 * so exactly one scrypt call happens either way, at the SAME cost a real
 * check would pay, and an unknown login cannot be told apart from a wrong
 * password by timing (CLOUD-LOGIN-SPEC.md section C step 3). Built from
 * fixed hashes rather than `deps.randomBytes`: this needs to be the same
 * shape every time, never a secret.
 */
function dummyRecordFor(scryptParams) {
  const { N, r, p } = scryptParams;
  const salt = sha256Hex("camplat-cloud:dummy-salt"); // 32 bytes hex = 64 chars
  const key = sha256Hex("camplat-cloud:dummy-key:1") + sha256Hex("camplat-cloud:dummy-key:2"); // 64 bytes hex = 128 chars
  return { algo: "scrypt", N, r, p, salt, key };
}

/** The compiled, pure contract this file calls into -- dynamically imported
 *  (never a static top-level import of a compiled contract; see the module
 *  doc), and cached for free by Node's own ES module loader on repeat calls
 *  within one process. */
async function loadAuthContract() {
  return import("../dist/cloud/contracts/auth.js");
}

/**
 * Hash a fresh password the way the box does: `password.normalize("NFC")`
 * through scrypt at `deps.scryptParams` (default `SCRYPT_PARAMS`), with a
 * freshly random salt (CLOUD-LOGIN-SPEC.md section C). `maxmem` matches
 * `agent/auth.mjs`'s own formula (`256 * N * r + 1024 * 1024`) so a
 * tampered or oversized `N` still cannot pin more memory in a Lambda than
 * the box itself would allow on an appliance.
 *
 * @param {string} password
 * @param {{ scrypt?: Function, scryptParams?: { N: number, r: number, p: number }, randomBytes?: (n: number) => Buffer }} [deps]
 * @returns {Promise<import("../dist/cloud/contracts/auth.js").PasswordRecord>}
 */
export async function hashPassword(password, deps = {}) {
  const auth = await loadAuthContract();
  const scrypt = deps.scrypt ?? defaultScrypt;
  const scryptParams = deps.scryptParams ?? auth.SCRYPT_PARAMS;
  const randomBytesFn = deps.randomBytes ?? nodeRandomBytes;
  const { N, r, p } = scryptParams;
  const salt = randomBytesFn(auth.SALT_BYTES);
  const key = await scrypt(String(password).normalize("NFC"), salt, auth.KEY_BYTES, {
    N,
    r,
    p,
    maxmem: 256 * N * r + 1024 * 1024,
  });
  return { algo: "scrypt", N, r, p, salt: salt.toString("hex"), key: key.toString("hex") };
}

/**
 * Check a password against a stored record, constant-work whether or not
 * the record is real: an absent record (`null`) or one that fails
 * `checkPasswordRecord` is swapped for `dummyRecordFor` at the same scrypt
 * cost, so exactly one scrypt call happens either way and the result can
 * never read "verified" for a record that was not genuinely valid
 * (CLOUD-LOGIN-SPEC.md section C step 3: "a stored record that fails
 * checkPasswordRecord also runs the dummy scrypt and gives the same 401").
 * Compares with `timingSafeEqual`, on the record's own bounded parameters.
 *
 * @param {string} password
 * @param {import("../dist/cloud/contracts/auth.js").PasswordRecord|null} record
 * @param {{ scrypt?: Function, scryptParams?: { N: number, r: number, p: number } }} [deps]
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, record, deps = {}) {
  const auth = await loadAuthContract();
  const scrypt = deps.scrypt ?? defaultScrypt;
  const scryptParams = deps.scryptParams ?? auth.SCRYPT_PARAMS;
  const isValid = record !== null && record !== undefined && auth.checkPasswordRecord(record).length === 0;
  const target = isValid ? record : dummyRecordFor(scryptParams);
  const { N, r, p, salt, key } = target;
  const derived = await scrypt(String(password).normalize("NFC"), Buffer.from(salt, "hex"), auth.KEY_BYTES, {
    N,
    r,
    p,
    maxmem: 256 * N * r + 1024 * 1024,
  });
  const matches = timingSafeEqual(derived, Buffer.from(key, "hex"));
  return isValid && matches;
}

/**
 * @typedef {Object} LoginEvent
 * @property {string} body
 * @property {Record<string,string>} headers  lower-case header names
 * @property {string} sourceIp
 */

/**
 * @typedef {Object} LoginDeps
 * @property {import("./store.mjs").Store} store
 * @property {() => number} nowMs  called once per request
 * @property {(n: number) => Buffer} randomBytes
 * @property {Function} [scrypt]  defaults to `promisify(crypto.scrypt)`
 * @property {{ N: number, r: number, p: number }} [scryptParams]  defaults to `SCRYPT_PARAMS`
 * @property {(entry: { route: string, reason: string|null, userId: string|null }) => void} log
 *   Called exactly once per `loginHandler` request. Never carries a login
 *   name, a password, a token or a token hash.
 */

/**
 * Handle one `POST /login` (CLOUD-LOGIN-SPEC.md section C). In order:
 *
 * 1. The body must be JSON `{ login, password }`, both strings, with a
 *    `content-type` of `application/json` (case-insensitively, optional
 *    `;` parameters) -- anything else is 400 `{ ok: false, reason:
 *    "bad_request" }`, with no scrypt call and nothing recorded.
 * 2. Normalize the login (`normalizeLogin`). The account key is
 *    `"acct:" + normalized`, or `"acct:" + raw.toLowerCase()` (at most 64
 *    characters of it) when the login does not normalize. The source key is
 *    `"src:" + event.sourceIp`.
 *
 *    RECORD FIRST, THEN COUNT. This request's own attempt is recorded on
 *    BOTH keys before anything decides whether it is allowed to run scrypt --
 *    reading a key's failure count before recording is what let 20
 *    simultaneous guesses all pass a 5-guess budget (measured: all 20 ran).
 *    Both keys are then read back, and `loginDecision` runs on each, but only
 *    over the `atMs` of the entries that sort strictly BEFORE this request's
 *    own id -- so of a pile of truly simultaneous attempts, exactly the
 *    budget's worth get counted as "ahead" of any one of them, and exactly
 *    that many get through.
 *
 *    Either key locked is 429 `{ ok: false, reason: "locked", retryAfterS }`
 *    (`Math.ceil` of the larger of the two keys' `retryAfterMs`, an allowed
 *    key contributing 0), with a matching `retry-after` header -- and this
 *    request's own two just-recorded entries are deleted first: a refused
 *    attempt is not a guess, and must not itself lengthen the lock. No
 *    scrypt runs.
 * 3. Load the user for the normalized login (`null` when it does not
 *    normalize or names nobody). `verifyPassword` always runs -- against the
 *    real stored record when there is one, against the fixed dummy record
 *    otherwise -- exactly one scrypt call either way. An unknown login, a
 *    login that does not normalize, a wrong password, and a disabled user
 *    (checked with the REAL record, so its cost matches) all produce the
 *    same byte-identical 401 `{ ok: false, reason: "bad_credentials" }`. The
 *    two entries recorded in step 2 simply stay -- they ARE the failure
 *    record now, nothing further is written for them.
 * 4. Success clears the WHOLE account key (including this request's own
 *    entry), but deletes only this request's OWN source entry -- never the
 *    whole source key, so one good login cannot erase a sprayer's count
 *    sitting on the same address. Then it mints a 32-byte base64url token,
 *    stores its SHA-256 as the session, and responds 200 `{ ok: true }` with
 *    the session cookie. The token appears only in that header.
 * 5. Exactly one `deps.log({ route: "login", reason, userId })` per request,
 *    `reason` null only on success, `userId` null unless the login matched a
 *    real user.
 *
 * @param {LoginEvent} event
 * @param {LoginDeps} deps
 * @returns {Promise<{ statusCode: number, headers: Record<string,string>, body: string }>}
 */
export async function loginHandler(event, deps) {
  const auth = await loadAuthContract();
  const nowMs = deps.nowMs();

  const respond = (statusCode, payload, extraHeaders = {}) => ({
    statusCode,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  });
  const refuseBadRequest = () => {
    deps.log({ route: "login", reason: "bad_request", userId: null });
    return respond(400, { ok: false, reason: "bad_request" });
  };

  const contentType = event.headers?.["content-type"];
  if (typeof contentType !== "string" || !CONTENT_TYPE_RE.test(contentType)) {
    return refuseBadRequest();
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return refuseBadRequest();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.login !== "string" ||
    typeof parsed.password !== "string"
  ) {
    return refuseBadRequest();
  }
  const { login: rawLogin, password } = parsed;

  const normalized = auth.normalizeLogin(rawLogin);
  const acctKey = "acct:" + (normalized ?? rawLogin.toLowerCase().slice(0, 64));
  const srcKey = "src:" + event.sourceIp;
  const sinceMs = nowMs - auth.FAILURE_MEMORY_MS;

  // Record first, then count (CLOUD-LOGIN-SPEC.md section C step 2). This
  // request stakes its own attempt on both keys BEFORE anything decides
  // whether it is allowed to run scrypt -- reading a key's count before
  // recording is exactly what let 20 simultaneous guesses all pass a
  // 5-guess budget (measured: all 20 ran).
  const [acctId, srcId] = await Promise.all([
    deps.store.recordFailedLogin(acctKey, nowMs),
    deps.store.recordFailedLogin(srcKey, nowMs),
  ]);
  const [acctEntries, srcEntries] = await Promise.all([
    deps.store.failedLogins(acctKey, sinceMs),
    deps.store.failedLogins(srcKey, sinceMs),
  ]);
  // Only the entries that sort strictly BEFORE this request's own id count
  // against it -- so of a pile of truly simultaneous attempts, exactly the
  // budget's worth get counted as "ahead" of any one of them.
  const acctBeforeMs = acctEntries.filter((e) => e.id < acctId).map((e) => e.atMs);
  const srcBeforeMs = srcEntries.filter((e) => e.id < srcId).map((e) => e.atMs);
  const acctDecision = auth.loginDecision(acctBeforeMs, nowMs, auth.FREE_FAILURES_PER_ACCOUNT);
  const srcDecision = auth.loginDecision(srcBeforeMs, nowMs, auth.FREE_FAILURES_PER_SOURCE);
  if (!acctDecision.allowed || !srcDecision.allowed) {
    // A refused attempt is not a guess: undo the two entries this request
    // just staked, so being locked out never itself lengthens the lock.
    await Promise.all([deps.store.deleteFailedLogin(acctKey, acctId), deps.store.deleteFailedLogin(srcKey, srcId)]);
    const retryAfterMs = Math.max(
      acctDecision.allowed ? 0 : acctDecision.retryAfterMs,
      srcDecision.allowed ? 0 : srcDecision.retryAfterMs,
    );
    const retryAfterS = Math.ceil(retryAfterMs / 1000);
    deps.log({ route: "login", reason: "locked", userId: null });
    return respond(429, { ok: false, reason: "locked", retryAfterS }, { "retry-after": String(retryAfterS) });
  }

  const user = normalized === null ? null : await deps.store.getUser(normalized);
  const passwordOk = await verifyPassword(password, user ? user.password : null, deps);
  if (user === null || user.disabled || !passwordOk) {
    // The two entries recorded above stay: they ARE the failure record now.
    deps.log({ route: "login", reason: "bad_credentials", userId: null });
    return respond(401, { ok: false, reason: "bad_credentials" });
  }

  // Success: wipe the account's whole history (this request's own entry
  // included), but only ever delete the source key's OWN entry -- one good
  // login must never erase a sprayer's count sitting on the same address.
  await Promise.all([deps.store.clearFailedLogins(acctKey), deps.store.deleteFailedLogin(srcKey, srcId)]);
  const randomBytesFn = deps.randomBytes ?? nodeRandomBytes;
  const token = randomBytesFn(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  await deps.store.putSession(tokenHash, {
    login: user.login,
    createdMs: nowMs,
    lastSeenMs: nowMs,
    epoch: user.sessionEpoch,
  });

  deps.log({ route: "login", reason: null, userId: user.userId });
  return respond(200, { ok: true }, {
    "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
  });
}

/**
 * @typedef {Object} SessionEvent
 * @property {Record<string,string>} headers  lower-case header names; `cookie` carries the session, if any
 */

/**
 * `principalFromEvent(event, deps) -> principal | null` (CLOUD-LOGIN-SPEC.md
 * section C). Cookie only -- there is no bearer token in production; a dev
 * server's dev token is dev-only and does not go through this function.
 *
 * 1. Parse the `cookie` header (`parseCookies`, copied from `agent/auth.mjs`).
 * 2. The token must match `/^[A-Za-z0-9_-]{43}$/` -- anything else is `null`
 *    with no store lookup at all.
 * 3. Hash it, load the session and the user for the session's login, and run
 *    `sessionState`.
 * 4. Anything but `"valid"` deletes that session (best effort -- the store
 *    never throws for a missing one) and returns `null`.
 * 5. `needsTouch` true -> `touchSession` (once per five minutes, not once
 *    per request).
 * 6. Return `principalOf(user)`.
 *
 * @param {SessionEvent} event
 * @param {LoginDeps} deps
 * @returns {Promise<import("../dist/cloud/contracts/auth.js").ApiPrincipal|null>}
 */
export async function principalFromEvent(event, deps) {
  const auth = await loadAuthContract();
  const cookies = parseCookies(event.headers?.cookie);
  const token = cookies[SESSION_COOKIE];
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return null;
  }

  const tokenHash = sha256Hex(token);
  const session = await deps.store.getSession(tokenHash);
  const user =
    session !== null && typeof session === "object" && typeof session.login === "string"
      ? await deps.store.getUser(session.login)
      : null;

  const nowMs = deps.nowMs();
  const state = auth.sessionState(session, user, nowMs);
  if (state !== "valid") {
    await deps.store.deleteSession(tokenHash);
    return null;
  }
  if (auth.needsTouch(session, nowMs)) {
    await deps.store.touchSession(tokenHash, nowMs);
  }
  return auth.principalOf(user);
}

/**
 * Handle one `POST /logout` (CLOUD-LOGIN-SPEC.md section C). Deletes the
 * session the cookie names, if any -- no error when there is none, or when
 * the cookie is missing or malformed -- and always answers 200 with a
 * clearing cookie.
 *
 * @param {SessionEvent} event
 * @param {LoginDeps} deps
 * @returns {Promise<{ statusCode: number, headers: Record<string,string>, body: string }>}
 */
export async function logoutHandler(event, deps) {
  const cookies = parseCookies(event.headers?.cookie);
  const token = cookies[SESSION_COOKIE];
  if (typeof token === "string" && token !== "") {
    await deps.store.deleteSession(sha256Hex(token));
  }
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    },
    body: JSON.stringify({ ok: true }),
  };
}
