// cloud/harness/auth.harness.mjs — cloud/contracts/auth.ts (CLOUD-LOGIN-SPEC.md A).
//
// FEARED: a second, weaker password rule drifting away from the box's; a
// tampered scrypt record that pins the CPU; a lock that opens a failure too
// early or never caps; a broken failure count read as "no failures"; a session
// that survives a password reset or a disable; an off-by-one at 12 h / 7 days.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import * as auth from "../dist/cloud/contracts/auth.js";
import * as boxAccess from "../dist/contracts/access.js";

console.log("auth contract");

const H = 3600_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const hex = (bytes, ch = "a") => ch.repeat(bytes * 2);
const goodRecord = () => ({ algo: "scrypt", N: 32768, r: 8, p: 1, salt: hex(32), key: hex(64, "b") });
const goodUser = (over = {}) => ({
  userId: "usr_0123456789abcdef",
  login: "tech@example.com",
  installerId: "inst-1",
  password: goodRecord(),
  disabled: false,
  sessionEpoch: 3,
  createdMs: NOW - 10 * H,
  ...over,
});
const session = (over = {}) => ({ login: "tech@example.com", createdMs: NOW - H, lastSeenMs: NOW - 60_000, epoch: 3, ...over });

// --- the password rule is the box's, not a copy ---
check("validatePassword is the box's own function", () => {
  eq(auth.validatePassword, boxAccess.validatePassword, "same function object");
  eq(auth.MIN_PASSWORD_LENGTH, 12, "12 characters");
});

// --- login names ---
check("normalizeLogin lower-cases and bounds", () => {
  eq(auth.normalizeLogin("Tech@Example.COM"), "tech@example.com", "lower-cased");
  eq(auth.normalizeLogin("ab"), null, "2 chars refused");
  eq(auth.normalizeLogin("abc"), "abc", "3 chars ok");
  eq(auth.normalizeLogin("a".repeat(64)), "a".repeat(64), "64 ok");
  eq(auth.normalizeLogin("a".repeat(65)), null, "65 refused");
  eq(auth.normalizeLogin(" tech"), null, "leading space refused, not stripped");
  eq(auth.normalizeLogin("tech "), null, "trailing space refused");
  eq(auth.normalizeLogin("te ch"), null, "inner space refused");
  eq(auth.normalizeLogin("tech/../x"), null, "slash refused");
  eq(auth.normalizeLogin(42), null, "not a string");
  eq(auth.normalizeLogin(undefined), null, "blank");
});

// --- stored password record: the box's bounds ---
check("checkPasswordRecord accepts the box's shape", () => {
  same(auth.checkPasswordRecord(goodRecord()), [], "good record");
});
check("checkPasswordRecord names every problem", () => {
  same(auth.checkPasswordRecord(null), ["not_object"], "null");
  same(auth.checkPasswordRecord([]), ["not_object"], "array");
  same(auth.checkPasswordRecord({ ...goodRecord(), algo: "bcrypt" }), ["bad_algo"], "algo");
  same(auth.checkPasswordRecord({ ...goodRecord(), N: 2 ** 30 }), ["bad_params"], "tampered N = 2^30 must not pin the CPU");
  same(auth.checkPasswordRecord({ ...goodRecord(), N: 1000 }), ["bad_params"], "N not a power of two");
  same(auth.checkPasswordRecord({ ...goodRecord(), N: 512 }), ["bad_params"], "N below 1024");
  same(auth.checkPasswordRecord({ ...goodRecord(), r: 17 }), ["bad_params"], "r above 16");
  same(auth.checkPasswordRecord({ ...goodRecord(), p: 5 }), ["bad_params"], "p above 4");
  same(auth.checkPasswordRecord({ ...goodRecord(), p: 1.5 }), ["bad_params"], "p not an integer");
  same(auth.checkPasswordRecord({ ...goodRecord(), salt: hex(16) }), ["bad_salt"], "16-byte salt");
  same(auth.checkPasswordRecord({ ...goodRecord(), salt: "Z".repeat(64) }), ["bad_salt"], "non-hex salt");
  same(auth.checkPasswordRecord({ ...goodRecord(), key: hex(32) }), ["bad_key"], "32-byte key");
  same(auth.checkPasswordRecord({ ...goodRecord(), salt: 1, key: 2 }), ["bad_salt", "bad_key"], "both, in order");
});
check("scrypt constants match the box", () => {
  same(auth.SCRYPT_PARAMS, { N: 32768, r: 8, p: 1 }, "params");
  eq(auth.SALT_BYTES, 32, "salt bytes");
  eq(auth.KEY_BYTES, 64, "key bytes");
});

// --- user record ---
check("checkUserRecord accepts a good user", () => {
  same(auth.checkUserRecord(goodUser()), [], "good user");
});
check("checkUserRecord refuses each bad field", () => {
  const bad = [
    { userId: "usr_XYZ" },
    { userId: "0123456789abcdef" },
    { login: "Tech@Example.com" }, // not normalized
    { installerId: "" },
    { password: { ...goodRecord(), N: 2 ** 30 } },
    { disabled: "no" },
    { sessionEpoch: -1 },
    { sessionEpoch: 1.5 },
    { createdMs: NaN },
  ];
  for (const over of bad) {
    const problems = auth.checkUserRecord(goodUser(over));
    eq(problems.length > 0, true, `refuses ${JSON.stringify(over)}`);
  }
  eq(auth.checkUserRecord(null).length > 0, true, "null user");
});

// --- the failed-login throttle: the box's escalation ---
check("throttle constants", () => {
  eq(auth.FREE_FAILURES_PER_ACCOUNT, 5, "account budget");
  eq(auth.FREE_FAILURES_PER_SOURCE, 20, "source budget");
  eq(auth.FIRST_LOCK_MS, 30_000, "first lock 30 s");
  eq(auth.MAX_LOCK_MS, 15 * 60_000, "cap 15 min");
  eq(auth.FAILURE_MEMORY_MS, 24 * H, "memory 24 h");
});
const fails = (n, lastAt = NOW - 1000, gap = 1000) => Array.from({ length: n }, (_, i) => lastAt - (n - 1 - i) * gap);
check("4 failures: allowed; 5: locked 30 s from the 5th", () => {
  same(auth.loginDecision(fails(4), NOW, 5), { allowed: true }, "4 failures");
  const d = auth.loginDecision(fails(5, NOW - 1000), NOW, 5);
  eq(d.allowed, false, "5th failure locks");
  eq(d.retryAfterMs, 29_000, "30 s after the 5th failure, 1 s already gone");
});
check("the lock opens exactly when it says", () => {
  const f = fails(5, NOW - 30_000);
  same(auth.loginDecision(f, NOW, 5), { allowed: true }, "30 s after the 5th: open");
  eq(auth.loginDecision(f, NOW - 1, 5).allowed, false, "1 ms before: still locked");
});
check("6th failure doubles to 60 s; the lock caps at 15 minutes", () => {
  eq(auth.loginDecision(fails(6, NOW), NOW, 5).retryAfterMs, 60_000, "6th -> 60 s");
  eq(auth.loginDecision(fails(7, NOW), NOW, 5).retryAfterMs, 120_000, "7th -> 120 s");
  eq(auth.loginDecision(fails(40, NOW), NOW, 5).retryAfterMs, 15 * 60_000, "40 failures -> capped");
});
check("a failure exactly 24 h old no longer counts", () => {
  const f = [NOW - 24 * H, ...fails(4, NOW)];
  same(auth.loginDecision(f, NOW, 5), { allowed: true }, "the old one is forgotten, 4 remain");
  const g = [NOW - 24 * H + 1, ...fails(4, NOW)];
  eq(auth.loginDecision(g, NOW, 5).allowed, false, "1 ms younger still counts");
});
check("the source budget is separate", () => {
  same(auth.loginDecision(fails(19, NOW), NOW, 20), { allowed: true }, "19 < 20");
  eq(auth.loginDecision(fails(20, NOW), NOW, 20).allowed, false, "20th locks");
});
check("a broken failure list fails CLOSED", () => {
  for (const junk of [null, undefined, "5", [NaN], [NOW, "x"], [Infinity], {}]) {
    same(auth.loginDecision(junk, NOW, 5), { allowed: false, retryAfterMs: 15 * 60_000 }, `junk ${JSON.stringify(junk)}`);
  }
  same(auth.loginDecision([], NOW, 5), { allowed: true }, "an empty list is zero failures, not junk");
});

// --- sessions ---
check("session constants", () => {
  eq(auth.SESSION_IDLE_MS, 12 * H, "idle 12 h");
  eq(auth.SESSION_MAX_MS, 7 * 24 * H, "max 7 days");
  eq(auth.SESSION_TOUCH_EVERY_MS, 5 * 60_000, "touch 5 min");
});
check("sessionState: valid, and the idle boundary", () => {
  eq(auth.sessionState(session(), goodUser(), NOW), "valid", "fresh");
  eq(auth.sessionState(session({ lastSeenMs: NOW - 12 * H + 1 }), goodUser(), NOW), "valid", "just under 12 h idle");
  eq(auth.sessionState(session({ lastSeenMs: NOW - 12 * H }), goodUser(), NOW), "expired_idle", "exactly 12 h idle");
});
check("sessionState: the 7-day boundary, even when active", () => {
  const s = session({ createdMs: NOW - 7 * 24 * H, lastSeenMs: NOW - 1000 });
  eq(auth.sessionState(s, goodUser(), NOW), "expired_max", "exactly 7 days");
  eq(auth.sessionState({ ...s, createdMs: s.createdMs + 1 }, goodUser(), NOW), "valid", "1 ms under");
  const both = session({ createdMs: NOW - 8 * 24 * H, lastSeenMs: NOW - 13 * H });
  eq(auth.sessionState(both, goodUser(), NOW), "expired_max", "max is checked before idle");
});
check("sessionState: a reset, a disable or a missing user revokes", () => {
  eq(auth.sessionState(session({ epoch: 2 }), goodUser(), NOW), "revoked", "epoch behind (password reset)");
  eq(auth.sessionState(session(), goodUser({ disabled: true }), NOW), "revoked", "disabled user");
  eq(auth.sessionState(session(), null, NOW), "revoked", "deleted user");
  eq(auth.sessionState(session({ login: "someone.else" }), goodUser(), NOW), "revoked", "session names another login");
});
check("sessionState: a malformed record is malformed, checked first", () => {
  for (const bad of [null, {}, session({ createdMs: "x" }), session({ lastSeenMs: undefined }), session({ epoch: -1 })]) {
    eq(auth.sessionState(bad, goodUser(), NOW), "malformed", `bad ${JSON.stringify(bad)}`);
  }
  eq(auth.sessionState(null, null, NOW), "malformed", "malformed wins over revoked");
});
check("needsTouch at 5 minutes", () => {
  eq(auth.needsTouch(session({ lastSeenMs: NOW - 5 * 60_000 + 1 }), NOW), false, "just under 5 min");
  eq(auth.needsTouch(session({ lastSeenMs: NOW - 5 * 60_000 }), NOW), true, "exactly 5 min");
});

// --- principal ---
check("principalOf: an installer tech, scoped to their installer", () => {
  same(
    auth.principalOf(goodUser()),
    { userId: "usr_0123456789abcdef", role: "installer_tech", scope: { kind: "installer", id: "inst-1" }, installerId: "inst-1" },
    "principal",
  );
  eq(auth.principalOf(goodUser({ disabled: true })), null, "disabled user has no principal");
});

report("auth contract");
