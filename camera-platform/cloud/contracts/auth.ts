/**
 * Who may sign in to the cloud, and for how long, once they are in
 * (cloud/CLOUD-LOGIN-SPEC.md section A, "cloud/contracts/auth.ts (pure, no
 * I/O)"). Pure: no fs, no `node:crypto`, no clock of its own (every function
 * here takes `nowMs` from the caller) and no randomness -- hashing a
 * password and minting a session token are I/O and live in
 * `cloud/api/login.mjs`, which injects `scrypt` and `randomBytes` so a test
 * can count calls and fake the clock.
 *
 * The password rule is not reimplemented here: `validatePassword` and
 * `MIN_PASSWORD_LENGTH` are re-exported from the box's own
 * `../../contracts/access.ts`, the SAME function object, so the cloud and
 * every NVR in the field always refuse the same passwords for the same
 * reason. Everything else mirrors bounds the box already enforces in
 * `agent/auth.mjs` -- the scrypt parameter bounds in `validStoredHash`, and
 * the lock escalation in `recordFailure` -- so a tampered record or a
 * spraying client meets the same wall in the cloud that it would meet on an
 * appliance.
 *
 * See cloud/CLOUD-LOGIN-SPEC.md section A for the full contract, and
 * cloud/harness/auth.harness.mjs for the checks it must pass.
 */

import { validatePassword, MIN_PASSWORD_LENGTH } from "../../contracts/access.js";
import type { Principal } from "./scope.js";

export { validatePassword, MIN_PASSWORD_LENGTH };

// ---------------------------------------------------------------------------
// Login names
// ---------------------------------------------------------------------------

/** 3 to 64 characters of `[a-z0-9._@+-]`. Deliberately NOT `[A-Za-z]` with a
 *  separate lower-case step: running the pattern against the already-lowered
 *  string means a space, a slash or any other stray character is refused in
 *  the same pass, rather than surviving a trim somewhere upstream and
 *  quietly becoming a different login than the one the person typed. */
const LOGIN_PATTERN = /^[a-z0-9._@+-]{3,64}$/;

/**
 * Normalize a login to the form every comparison uses, or refuse it.
 *
 * Nothing here is stripped: a leading, trailing or inner space is a
 * different string than the one without it, and silently trimming it would
 * mean "tech " and "tech" sign in as the same account while looking like two
 * in an audit log. So a space simply never matches `LOGIN_PATTERN`, and the
 * login is refused rather than repaired.
 */
export function normalizeLogin(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const lowered = raw.toLowerCase();
  return LOGIN_PATTERN.test(lowered) ? lowered : null;
}

// ---------------------------------------------------------------------------
// Stored password record -- the box's shape, the box's bounds
// ---------------------------------------------------------------------------

/** `{ algo: "scrypt", N, r, p, salt, key }`, exactly as the box stores it
 *  (see `agent/auth.mjs`'s `validStoredHash`). `salt` and `key` are hex
 *  text, not raw bytes: this record is JSON on disk and in DynamoDB, and hex
 *  survives that round trip without an encoding decision at every read. */
export interface PasswordRecord {
  algo: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  key: string;
}

/** The scrypt cost the cloud hashes new passwords with. Bounds-checked by
 *  `checkPasswordRecord`, not trusted from a stored record, because a record
 *  is JSON someone else wrote -- see `SCRYPT_PARAMS`'s own comment. */
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });

/** Raw salt length the cloud generates for a new hash: 32 bytes, stored as
 *  64 hex characters. Matches the box so a hash produced by either side
 *  looks identical on disk. */
export const SALT_BYTES = 32;

/** Raw key length scrypt derives: 64 bytes, stored as 128 hex characters. */
export const KEY_BYTES = 64;

/**
 * Every way a stored password record can be wrong, in order:
 * `"not_object"`, `"bad_algo"`, `"bad_params"`, `"bad_salt"`, `"bad_key"`.
 * More than one can fire on the same record (a corrupt `salt` and `key`
 * together), so this returns every problem found, not just the first.
 *
 * The `N`/`r`/`p` bounds (`N` a power of two in 1024..1048576, `r` in
 * 1..16, `p` in 1..4) are the box's own bounds from `validStoredHash`, not a
 * fresh guess: a record is untrusted input the moment it comes back out of
 * storage, and `N = 2 ** 30` would otherwise let one tampered row pin a
 * Lambda's CPU for the life of the scrypt call.
 */
export function checkPasswordRecord(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return ["not_object"];
  }
  const record = raw as Record<string, unknown>;
  const problems: string[] = [];

  if (record.algo !== "scrypt") {
    problems.push("bad_algo");
  }

  const n = record.N;
  const r = record.r;
  const p = record.p;
  const validN =
    typeof n === "number" && Number.isInteger(n) && n >= 1024 && n <= 1048576 && (n & (n - 1)) === 0;
  const validR = typeof r === "number" && Number.isInteger(r) && r >= 1 && r <= 16;
  const validP = typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 4;
  if (!validN || !validR || !validP) {
    problems.push("bad_params");
  }

  if (typeof record.salt !== "string" || !/^[0-9a-f]{64}$/.test(record.salt)) {
    problems.push("bad_salt");
  }
  if (typeof record.key !== "string" || !/^[0-9a-f]{128}$/.test(record.key)) {
    problems.push("bad_key");
  }

  return problems;
}

// ---------------------------------------------------------------------------
// User record
// ---------------------------------------------------------------------------

/** `{ userId, login, installerId, password, disabled, sessionEpoch,
 *  createdMs }`. `sessionEpoch` goes up by one on every password reset and
 *  every disable -- that is the whole mechanism behind "resetting a
 *  password signs out that account's other sessions": no session table scan,
 *  just a number a stale session can no longer match (see `sessionState`). */
export interface UserRecord {
  userId: string;
  login: string;
  installerId: string;
  password: PasswordRecord;
  disabled: boolean;
  sessionEpoch: number;
  createdMs: number;
}

/**
 * Every way a user record can be wrong. Checks every field rather than
 * stopping at the first, because this runs over data already accepted into
 * storage -- when it fails, whoever is debugging needs the whole list, not
 * one problem at a time across five redeploys.
 */
export function checkUserRecord(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return ["not_object"];
  }
  const user = raw as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof user.userId !== "string" || !/^usr_[0-9a-f]{16}$/.test(user.userId)) {
    problems.push("bad_user_id");
  }
  if (typeof user.login !== "string" || normalizeLogin(user.login) !== user.login) {
    problems.push("bad_login");
  }
  if (typeof user.installerId !== "string" || user.installerId === "") {
    problems.push("bad_installer_id");
  }
  if (checkPasswordRecord(user.password).length > 0) {
    problems.push("bad_password");
  }
  if (typeof user.disabled !== "boolean") {
    problems.push("bad_disabled");
  }
  if (typeof user.sessionEpoch !== "number" || !Number.isInteger(user.sessionEpoch) || user.sessionEpoch < 0) {
    problems.push("bad_session_epoch");
  }
  if (typeof user.createdMs !== "number" || !Number.isFinite(user.createdMs)) {
    problems.push("bad_created_ms");
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Failed-login throttle -- the box's escalation
// ---------------------------------------------------------------------------

/** Failed attempts against one ACCOUNT before it starts locking. The box's
 *  own number (`agent/auth.mjs`'s `FREE_FAILURES`), kept separate from the
 *  per-source budget below so the two throttles can be reasoned about
 *  independently even though `loginDecision` runs the same math for both. */
export const FREE_FAILURES_PER_ACCOUNT = 5;

/** Failed attempts from one SOURCE address before it starts locking. Wider
 *  than the account budget on purpose: a source spraying many logins should
 *  hit its own ceiling well before it could single-handedly lock every
 *  account it tries. */
export const FREE_FAILURES_PER_SOURCE = 20;

/** The lock after the first failure past the free budget: 30 seconds. */
export const FIRST_LOCK_MS = 30_000;

/** The lock never grows past this, however many failures pile up: 15
 *  minutes. Without a cap, `FIRST_LOCK_MS * 2 ** n` reaches lock times of
 *  years within a couple of dozen failed attempts -- a number nobody chose
 *  on purpose, just an exponent nobody capped. */
export const MAX_LOCK_MS = 15 * 60_000;

/** How long a failure keeps counting against the budget: 24 hours. A
 *  failure this old is forgotten entirely, not merely aged out of the lock
 *  math, so a account that failed once yesterday starts today with a clean
 *  budget rather than one already down a try. */
export const FAILURE_MEMORY_MS = 24 * 3600_000;

/** `{ allowed: true }` or `{ allowed: false, retryAfterMs }` -- never a
 *  bare boolean, so a caller cannot forget to read `retryAfterMs` when it
 *  matters. */
export type LoginDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * The box's failed-login escalation: 30 seconds after the free budget is
 * spent, doubling on every failure after that, capped at 15 minutes.
 *
 * `failuresMs` is untrusted: it comes back out of a store keyed by account
 * or by source address, and a broken read -- not an array, a non-numeric
 * entry, `NaN`, `Infinity` -- fails CLOSED at the maximum lock rather than
 * being read as "no failures on record" (build rule 10: a wrong answer that
 * looks plausible, here "this address has never failed," is the one to
 * refuse). An empty array is not broken; it is zero failures.
 *
 * Only failures within `FAILURE_MEMORY_MS` of `nowMs` count toward that
 * total (`n`). Below `freeFailures`, the result is allowed. At or above it,
 * the lock runs from the most recent counted failure, for
 * `min(FIRST_LOCK_MS * 2 ** (n - freeFailures), MAX_LOCK_MS)` -- so calling
 * this again after the lock has passed returns `{ allowed: true }` again,
 * without any separate "unlock" step.
 */
export function loginDecision(failuresMs: unknown, nowMs: number, freeFailures: number): LoginDecision {
  if (!Array.isArray(failuresMs) || !failuresMs.every((f) => typeof f === "number" && Number.isFinite(f))) {
    return { allowed: false, retryAfterMs: MAX_LOCK_MS };
  }

  const recent = failuresMs.filter((f) => nowMs - f < FAILURE_MEMORY_MS);
  const n = recent.length;
  if (n < freeFailures) {
    return { allowed: true };
  }

  const lastFailureMs = Math.max(...recent);
  const lockUntilMs = lastFailureMs + Math.min(FIRST_LOCK_MS * 2 ** (n - freeFailures), MAX_LOCK_MS);
  const retryAfterMs = lockUntilMs - nowMs;
  if (retryAfterMs <= 0) {
    return { allowed: true };
  }
  return { allowed: false, retryAfterMs };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** `{ login, createdMs, lastSeenMs, epoch }`. The token itself (32 random
 *  bytes, base64url, handed to the browser once) never appears here -- only
 *  its SHA-256 hex is the store's key, so this record, and the store it
 *  lives in, holds nothing that would let a leaked backup sign in as
 *  anyone. */
export interface SessionRecord {
  login: string;
  createdMs: number;
  lastSeenMs: number;
  epoch: number;
}

/** No request in 12 hours ends the session -- the box's own idle window. */
export const SESSION_IDLE_MS = 12 * 3600_000;

/** However active, a session dies at 7 days. A login that never has to
 *  happen again is a login nobody remembers granting. */
export const SESSION_MAX_MS = 7 * 24 * 3600_000;

/** How often an active session's `lastSeenMs` is written back: every 5
 *  minutes, not on every request (see `needsTouch`) -- one write per five
 *  minutes per session instead of one per request is the difference between
 *  a DynamoDB bill that scales with logins and one that scales with clicks
 *  (AWS costs are tight). */
export const SESSION_TOUCH_EVERY_MS = 5 * 60_000;

/** Every state `sessionState` can return. `"malformed"` and `"revoked"`
 *  both mean "sign out and forget this session," but are kept distinct
 *  because they come from different failures -- a corrupt record versus a
 *  legitimate reset or disable -- and a caller investigating a support
 *  ticket needs to tell those apart. */
export type SessionState = "malformed" | "revoked" | "expired_max" | "expired_idle" | "valid";

function isWellFormedSession(session: unknown): session is SessionRecord {
  if (session === null || typeof session !== "object" || Array.isArray(session)) {
    return false;
  }
  const s = session as Record<string, unknown>;
  return (
    typeof s.login === "string" &&
    typeof s.createdMs === "number" &&
    Number.isFinite(s.createdMs) &&
    typeof s.lastSeenMs === "number" &&
    Number.isFinite(s.lastSeenMs) &&
    typeof s.epoch === "number" &&
    Number.isInteger(s.epoch) &&
    s.epoch >= 0
  );
}

/**
 * Whether a session is still good to use, checked in this exact order --
 * the first match wins:
 *
 * 1. `"malformed"`: the record itself is not well-shaped. Checked before
 *    anything else touches it, because a record this broken cannot be
 *    trusted to even compare correctly against a user.
 * 2. `"revoked"`: there is no user for `session.login`, that user is
 *    disabled, `session.login !== user.login` (the session names an
 *    account it was never issued for -- CLOUD-LOGIN-SPEC.md section A), or
 *    `session.epoch !== user.sessionEpoch` (the password was reset, or the
 *    account was disabled and re-enabled, since either bumps the epoch).
 * 3. `"expired_max"`: `nowMs - createdMs >= SESSION_MAX_MS`. Checked before
 *    idle so a session that is BOTH past its 7 days and idle reports the
 *    more absolute reason.
 * 4. `"expired_idle"`: `nowMs - lastSeenMs >= SESSION_IDLE_MS`.
 * 5. `"valid"`: none of the above.
 */
export function sessionState(session: unknown, user: UserRecord | null, nowMs: number): SessionState {
  if (!isWellFormedSession(session)) {
    return "malformed";
  }
  if (user === null || user.disabled || session.login !== user.login || session.epoch !== user.sessionEpoch) {
    return "revoked";
  }
  if (nowMs - session.createdMs >= SESSION_MAX_MS) {
    return "expired_max";
  }
  if (nowMs - session.lastSeenMs >= SESSION_IDLE_MS) {
    return "expired_idle";
  }
  return "valid";
}

/** Whether a valid session's `lastSeenMs` is old enough to write back:
 *  `nowMs - lastSeenMs >= SESSION_TOUCH_EVERY_MS`. Only meaningful to call
 *  once `sessionState` has already said `"valid"`. */
export function needsTouch(session: SessionRecord, nowMs: number): boolean {
  return nowMs - session.lastSeenMs >= SESSION_TOUCH_EVERY_MS;
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/** A logged-in user's scope PLUS the one field `cloud/api/fleet.mjs` reads
 *  beyond the pure `Principal` -- the installer id, unpacked once here so
 *  every handler downstream can read `principal.installerId` directly
 *  instead of re-deriving it from `principal.scope`. */
export type ApiPrincipal = Principal & { installerId: string };

/**
 * The principal a logged-in user maps to, or `null` for a disabled one.
 * This build logs in installer techs only -- `role` is always
 * `"installer_tech"` and `scope` is always that user's own installer.
 * Chain roles (`head_office`, `regional_manager`, ...) have no login path
 * yet; when they do, THIS is where a second case is added, not a second
 * function.
 */
export function principalOf(user: UserRecord): ApiPrincipal | null {
  if (user.disabled) {
    return null;
  }
  return {
    userId: user.userId,
    role: "installer_tech",
    scope: { kind: "installer", id: user.installerId },
    installerId: user.installerId,
  };
}
