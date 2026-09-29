// cloud/harness/apiLogin.harness.mjs — cloud/api/login.mjs (CLOUD-LOGIN-SPEC.md C).
//
// FEARED: a prober telling "no such account" from "wrong password" (by the
// response, or by the time scrypt takes); a lockout that only real accounts
// get (which itself says the account exists); the right password getting in
// during a lock; one good login wiping a sprayer's count; a session that
// survives a reset, a disable, 12 idle hours or 7 days; a token or password
// in a log line; a store write on every request.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { loginHandler, logoutHandler, principalFromEvent, hashPassword } from "../api/login.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";

console.log("api login");

const H = 3600_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const FAST = { N: 1024, r: 8, p: 1 };
const PW = "correct horse battery";
const LOGIN = "tech@example.com";
const IP = "203.0.113.5";
const COOKIE_RE = /^camplat_session=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/;
const realScrypt = promisify(scryptCb);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** A fresh store holding one active installer tech, and deps that count scrypt calls. */
async function setup({ disabled = false } = {}) {
  const store = createMemoryStore();
  const logs = [];
  const clock = { t: NOW };
  const counter = { scrypt: 0 };
  const deps = {
    store,
    nowMs: () => clock.t,
    randomBytes,
    scryptParams: FAST,
    scrypt: async (...a) => {
      counter.scrypt++;
      return realScrypt(...a);
    },
    log: (e) => logs.push(e),
  };
  const password = await hashPassword(PW, deps);
  const user = { userId: "usr_0123456789abcdef", login: LOGIN, installerId: "inst-1", password, disabled, sessionEpoch: 0, createdMs: NOW - H };
  eq(await store.putUser(user, { ifAbsent: true }), true, "seed user");
  counter.scrypt = 0;
  return { store, logs, clock, counter, deps, user };
}
const ev = (body, over = {}) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json" },
  sourceIp: IP,
  ...over,
});
const login = (deps, l = LOGIN, p = PW, ip = IP) => loginHandler(ev({ login: l, password: p }, { sourceIp: ip }), deps);
const tokenOf = (res) => {
  const m = COOKIE_RE.exec(res.headers["set-cookie"] ?? "");
  if (!m) throw new Error(`no session cookie in ${JSON.stringify(res.headers)}`);
  return m[1];
};
const withCookie = (token, ip = IP) => ({ body: "", headers: { cookie: `camplat_session=${token}` }, sourceIp: ip });
const snapshot = (res) => JSON.stringify({ s: res.statusCode, h: res.headers, b: res.body });

await check("the right password logs in with an exact session cookie", async () => {
  const { deps, logs } = await setup();
  const res = await login(deps);
  eq(res.statusCode, 200, "status");
  same(JSON.parse(res.body), { ok: true }, "body");
  const token = tokenOf(res);
  eq(res.body.includes(token), false, "the token is only in the cookie");
  same(logs, [{ route: "login", reason: null, userId: "usr_0123456789abcdef" }], "one log line");
});

await check("unknown login and wrong password are byte-identical, one scrypt each", async () => {
  const { deps, counter } = await setup();
  const wrong = await login(deps, LOGIN, "wrong password here");
  eq(counter.scrypt, 1, "wrong password: one scrypt");
  const unknown = await login(deps, "ghost@example.com", PW);
  eq(counter.scrypt, 2, "unknown login: still one scrypt (dummy record)");
  const unshaped = await login(deps, "x", PW);
  eq(counter.scrypt, 3, "a login that does not normalize: still one scrypt");
  eq(wrong.statusCode, 401, "401");
  eq(snapshot(unknown), snapshot(wrong), "unknown == wrong");
  eq(snapshot(unshaped), snapshot(wrong), "unshaped == wrong");
  same(JSON.parse(wrong.body), { ok: false, reason: "bad_credentials" }, "body");
  eq(wrong.headers["set-cookie"], undefined, "no cookie on failure");
});

await check("a disabled user with the RIGHT password gets the same 401", async () => {
  const { deps } = await setup({ disabled: true });
  const other = await setup();
  const res = await login(deps);
  const wrong = await login(other.deps, LOGIN, "wrong password here");
  eq(snapshot(res), snapshot(wrong), "disabled == wrong password");
});

await check("5 failures lock the account: the 6th is 429 with the RIGHT password, no scrypt", async () => {
  const { deps, counter } = await setup();
  for (let i = 0; i < 5; i++) eq((await login(deps, LOGIN, "wrong password here")).statusCode, 401, `failure ${i + 1}`);
  const before = counter.scrypt;
  const res = await login(deps);
  eq(res.statusCode, 429, "locked even with the right password");
  eq(counter.scrypt, before, "no scrypt while locked");
  const body = JSON.parse(res.body);
  eq(body.ok, false, "ok false");
  eq(body.reason, "locked", "reason");
  eq(body.retryAfterS, 30, "30 s after the 5th failure");
  eq(res.headers["retry-after"], "30", "retry-after header");
  eq(res.headers["set-cookie"], undefined, "no cookie");
});

await check("the lock opens after 30 s", async () => {
  const { deps, clock } = await setup();
  for (let i = 0; i < 5; i++) await login(deps, LOGIN, "wrong password here");
  clock.t += 30_000;
  eq((await login(deps)).statusCode, 200, "open after 30 s");
});

await check("an unknown login gets locked exactly like a real one", async () => {
  const { deps } = await setup();
  const real = await setup();
  for (let i = 0; i < 5; i++) {
    await login(deps, "ghost@example.com", "wrong password here");
    await login(real.deps, LOGIN, "wrong password here");
  }
  const ghost = await login(deps, "ghost@example.com", "wrong password here");
  const locked = await login(real.deps, LOGIN, "wrong password here");
  eq(ghost.statusCode, 429, "ghost locked");
  eq(snapshot(ghost), snapshot(locked), "ghost lock == real lock");
});

await check("20 failures from one address block it, for every account; another address is fine", async () => {
  const { deps } = await setup();
  for (let i = 0; i < 20; i++) await login(deps, `ghost${i}@example.com`, "wrong password here");
  eq((await login(deps)).statusCode, 429, "the sprayer's address is blocked, even for a real login");
  eq((await login(deps, LOGIN, PW, "198.51.100.9")).statusCode, 200, "a different address logs in");
});

await check("a success clears the account's count but NOT the source's", async () => {
  const { deps, store } = await setup();
  for (let i = 0; i < 4; i++) await login(deps, LOGIN, "wrong password here");
  eq((await login(deps)).statusCode, 200, "success");
  same(await store.failedLogins(`acct:${LOGIN}`, 0), [], "account cleared");
  eq((await store.failedLogins(`src:${IP}`, 0)).length, 4, "source keeps its 4");
  for (let i = 0; i < 4; i++) eq((await login(deps, LOGIN, "wrong password here")).statusCode, 401, `fresh failure ${i + 1}`);
});

// Many copies of the handler run at once in the cloud. If every request reads
// the failure count before any of them records one, a burst of simultaneous
// guesses all get through before the first failure lands.
await check("20 simultaneous wrong guesses run at most 5 scrypts: the budget cannot be raced", async () => {
  const { deps, counter } = await setup();
  const results = await Promise.all(Array.from({ length: 20 }, () => login(deps, LOGIN, "wrong password here")));
  eq(counter.scrypt <= 5, true, `scrypt ran ${counter.scrypt} times for 20 simultaneous guesses`);
  eq(counter.scrypt >= 1, true, "the first guesses still run (a burst must not lock out everyone)");
  eq(results.filter((r) => r.statusCode === 401).length, counter.scrypt, "every guess that ran is a 401");
  eq(results.filter((r) => r.statusCode === 429).length, 20 - counter.scrypt, "every other one is locked");
});

await check("attempts refused while locked do not lengthen the lock", async () => {
  const { deps, clock, store } = await setup();
  for (let i = 0; i < 5; i++) await login(deps, LOGIN, "wrong password here");
  for (let i = 0; i < 10; i++) eq((await login(deps)).statusCode, 429, `locked try ${i + 1}`);
  eq((await store.failedLogins(`acct:${LOGIN}`, 0)).length, 5, "still exactly 5 failures on record");
  clock.t += 30_000;
  eq((await login(deps)).statusCode, 200, "the lock is still 30 s, not escalated by refused tries");
});

await check("a success leaves no attempt of its own on record", async () => {
  const { deps, store } = await setup();
  eq((await login(deps)).statusCode, 200, "success");
  eq((await store.failedLogins(`src:${IP}`, 0)).length, 0, "no source entry for a good login");
  eq((await store.failedLogins(`acct:${LOGIN}`, 0)).length, 0, "no account entry");
});

await check("bad requests are 400 and run no scrypt", async () => {
  const { deps, counter } = await setup();
  const cases = [
    ev({ login: LOGIN, password: PW }, { headers: { "content-type": "application/x-www-form-urlencoded" } }),
    ev({ login: LOGIN, password: PW }, { headers: {} }),
    ev("not json"),
    ev({ login: LOGIN }),
    ev({ login: LOGIN, password: 12345678901234 }),
    ev({ login: ["a"], password: PW }),
    ev("null"),
  ];
  for (const c of cases) {
    const res = await loginHandler(c, deps);
    eq(res.statusCode, 400, `400 for ${c.body} / ${JSON.stringify(c.headers)}`);
    same(JSON.parse(res.body), { ok: false, reason: "bad_request" }, "body");
  }
  eq(counter.scrypt, 0, "no scrypt");
});

await check("a good session gives the installer principal", async () => {
  const { deps } = await setup();
  const token = tokenOf(await login(deps));
  same(
    await principalFromEvent(withCookie(token), deps),
    { userId: "usr_0123456789abcdef", role: "installer_tech", scope: { kind: "installer", id: "inst-1" }, installerId: "inst-1" },
    "principal",
  );
});

await check("tampered, malformed or missing cookies give no principal", async () => {
  const { deps } = await setup();
  const token = tokenOf(await login(deps));
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  eq(await principalFromEvent(withCookie(flipped), deps), null, "one character changed");
  eq(await principalFromEvent(withCookie(token + "A"), deps), null, "44 characters");
  eq(await principalFromEvent(withCookie(sha256(token)), deps), null, "the stored hash is not a token");
  eq(await principalFromEvent({ body: "", headers: {}, sourceIp: IP }, deps), null, "no cookie");
  eq(await principalFromEvent({ body: "", headers: { cookie: "other=1" }, sourceIp: IP }, deps), null, "other cookie");
});

await check("12 idle hours end a session, and the dead session is deleted", async () => {
  const { deps, clock, store } = await setup();
  const token = tokenOf(await login(deps));
  clock.t += 12 * H;
  eq(await principalFromEvent(withCookie(token), deps), null, "idle 12 h");
  eq(await store.getSession(sha256(token)), null, "deleted");
});

await check("7 days end a session even when it is used all along", async () => {
  const { deps, clock } = await setup();
  const token = tokenOf(await login(deps));
  for (let i = 1; i < 28; i++) {
    clock.t = NOW + i * 6 * H;
    eq((await principalFromEvent(withCookie(token), deps)) !== null, true, `alive at ${i * 6} h`);
  }
  clock.t = NOW + 7 * 24 * H;
  eq(await principalFromEvent(withCookie(token), deps), null, "dead at exactly 7 days");
});

await check("a password reset (epoch bump) ends existing sessions", async () => {
  const { deps, store, user } = await setup();
  const token = tokenOf(await login(deps));
  eq(await store.putUser({ ...user, sessionEpoch: 1 }, { ifEpoch: 0 }), true, "reset");
  eq(await principalFromEvent(withCookie(token), deps), null, "old session dead");
});

await check("disabling a user ends their sessions", async () => {
  const { deps, store, user } = await setup();
  const token = tokenOf(await login(deps));
  eq(await store.putUser({ ...user, disabled: true, sessionEpoch: 1 }, { ifEpoch: 0 }), true, "disable");
  eq(await principalFromEvent(withCookie(token), deps), null, "session dead");
});

await check("a session is touched only after 5 minutes, not on every request", async () => {
  const { deps, clock, store } = await setup();
  const token = tokenOf(await login(deps));
  const h = sha256(token);
  clock.t = NOW + 4 * 60_000;
  await principalFromEvent(withCookie(token), deps);
  eq((await store.getSession(h)).lastSeenMs, NOW, "not touched at 4 min");
  clock.t = NOW + 5 * 60_000;
  await principalFromEvent(withCookie(token), deps);
  eq((await store.getSession(h)).lastSeenMs, NOW + 5 * 60_000, "touched at 5 min");
});

await check("logout ends the session and clears the cookie", async () => {
  const { deps } = await setup();
  const token = tokenOf(await login(deps));
  const res = await logoutHandler(withCookie(token), deps);
  eq(res.statusCode, 200, "200");
  eq(res.headers["set-cookie"], "camplat_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0", "clearing cookie");
  eq(await principalFromEvent(withCookie(token), deps), null, "session gone");
  eq((await logoutHandler({ body: "", headers: {}, sourceIp: IP }, deps)).statusCode, 200, "logout with no session is still 200");
});

await check("no log line carries a password, a token, its hash or the login name", async () => {
  const { deps, logs } = await setup();
  const token = tokenOf(await login(deps));
  await login(deps, LOGIN, "wrong password here");
  await login(deps, "ghost@example.com", PW);
  await principalFromEvent(withCookie(token), deps);
  await logoutHandler(withCookie(token), deps);
  const text = JSON.stringify(logs);
  for (const needle of [PW, "wrong password here", token, sha256(token), LOGIN, "ghost@example.com"]) {
    eq(text.includes(needle), false, `logs must not contain ${needle.slice(0, 12)}...`);
  }
});

report("api login");
