/**
 * Sign-in, end to end: the real auth module behind the real API server, on
 * loopback, with a throwaway state directory.
 *
 * The failures these checks exist to prevent (build rule 19):
 *
 *  - Any route answering 200 to someone who never signed in.
 *  - First boot handing the box to whoever reaches it first on the LAN.
 *  - A damaged accounts file read as "no accounts", which reopens activation.
 *  - A password on disk, or a login refusal that says which half was wrong.
 *  - Guessing passwords at full speed.
 *  - A removed account, or a changed password, leaving old sessions alive.
 *  - The store account creating accounts; a wall TV reaching recorded footage.
 *  - Another site's page posting to the recorder with the viewer's cookie, or
 *    opening a live stream from it.
 *  - A live stream opened before anyone checked who asked.
 *  - The last installer being removable.
 */
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createApiServer } from "../agent/api-server.mjs";
import { createAuth } from "../agent/auth.mjs";
import { attachLive } from "../agent/live.mjs";
import { createServer } from "node:http";
import { check, eq, same, report } from "./_assert.mjs";

console.log("auth");

const FAST = { N: 1024, r: 8, p: 1 };
const config = { siteId: "t", cameras: [], storeRoots: ["unused"], credentials: {} };
const quiet = () => {};
const dirs = [];
const servers = [];

let clock = new Date("2026-09-16T12:00:00Z");
const now = () => clock;

async function boot(stateDir, opts = {}) {
  const auth = await createAuth({ stateDir, now, scryptParams: FAST, log: quiet, ...opts });
  const server = createApiServer({ stateDir, config, index: null, now, auth });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { auth, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function stateDir() {
  const d = await mkdtemp(join(tmpdir(), "camplat-auth-"));
  dirs.push(d);
  return d;
}

/** fetch that never follows redirects and keeps cookies as a plain string. */
async function call(base, method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  const setCookies = res.headers.getSetCookie();
  const jar = setCookies.map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
  return { status: res.status, json, text, headers: res.headers, setCookies, jar };
}

const INSTALLER_PW = "correct horse battery";
const STORE_PW = "front desk staple 42";

// Every route the table knows, as a signed-out client would try them.
const ALL_ROUTES = [
  ["GET", "/"], ["GET", "/review"], ["GET", "/system"], ["GET", "/accounts-page"],
  ["GET", "/ui/live-client.js"], ["GET", "/ui/review-client.js"], ["GET", "/ui/alert-banner.js"],
  ["GET", "/ui/system-client.js"], ["GET", "/ui/wall-client.js"], ["GET", "/ui/grid-layout.js"],
  ["GET", "/ui/playback.js"], ["GET", "/ui/accounts-client.js"],
  ["GET", "/health"], ["GET", "/alerts"], ["GET", "/cameras"], ["GET", "/devices"], ["GET", "/timeline"],
  ["GET", "/playback"], ["GET", "/export/plan"], ["GET", "/export"], ["GET", "/accounts"], ["GET", "/displays"],
  ["GET", "/audit"], ["GET", "/segments/cam-1.1"], ["GET", "/live/cam-1"],
  ["POST", "/auth/password"], ["POST", "/accounts"], ["POST", "/displays"], ["DELETE", "/accounts/tech"],
  ["POST", "/accounts/tech/password"], ["DELETE", "/displays/tv"], ["GET", "/nope"], ["PUT", "/accounts"],
];

await check("no auth, no server: a missing gate is a crash at boot, not an open recorder", async () => {
  let threw = false;
  try { createApiServer({ stateDir: "x", config, index: null }); } catch { threw = true; }
  eq(threw, true, "createApiServer without auth");
  threw = false;
  try { attachLive(createServer(), { config, spawnFn: () => {} }); } catch { threw = true; }
  eq(threw, true, "attachLive without authorize");
});

const dirA = await stateDir();
const A = await boot(dirA, { trustLoopback: false });

await check("signed out, nothing but the login routes answers 200", async () => {
  for (const [m, p] of ALL_ROUTES) {
    const r = await call(A.base, m, p, m === "GET" || m === "DELETE" ? {} : { body: {} });
    eq(r.status === 401 || (r.status === 302 && r.headers.get("location").startsWith("/login?next=")), true,
      `${m} ${p} -> ${r.status}`);
  }
  const state = await call(A.base, "GET", "/auth/state");
  eq(state.status, 200, "state");
  same({ n: state.json.needsActivation, c: state.json.activationNeedsCode, p: state.json.principal, perms: state.json.permissions },
    { n: true, c: true, p: { kind: "anonymous" }, perms: [] }, "state body");
});

await check("first boot: no code, no installer; the code lives only on the box", async () => {
  const code = (await readFile(join(dirA, "activation-code"), "utf8")).trim();
  eq(/^[A-Z2-9]{10}$/.test(code), true, "code shape");
  if (process.platform !== "win32") eq((await stat(join(dirA, "activation-code"))).mode & 0o777, 0o600, "code mode");
  const none = await call(A.base, "POST", "/auth/activate", { body: { username: "tech", password: INSTALLER_PW } });
  eq(none.status, 403, "no code");
  const wrong = await call(A.base, "POST", "/auth/activate", { body: { username: "tech", password: INSTALLER_PW, code: "AAAAAAAAAA" } });
  eq(wrong.status, 403, "wrong code");
  eq(wrong.setCookies.length, 0, "no cookie on refusal");
  const weak = await call(A.base, "POST", "/auth/activate", { body: { username: "tech", password: "password1234", code } });
  eq(weak.json.code, "weak_password", "a weak first password is refused");
  const ok = await call(A.base, "POST", "/auth/activate", { body: { username: "Tech", password: INSTALLER_PW, code: code.toLowerCase() } });
  eq(ok.status, 200, "right code");
  same(ok.json.principal, { kind: "user", username: "tech", role: "installer" }, "installer, lowercased");
  const cookie = ok.setCookies.find((c) => c.startsWith("camplat_session="));
  eq(/HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\//.test(cookie), true, `cookie flags: ${cookie}`);
  let gone = false;
  try { await stat(join(dirA, "activation-code")); } catch { gone = true; }
  eq(gone, true, "the code is deleted once used");
  const again = await call(A.base, "POST", "/auth/activate", { body: { username: "evil", password: INSTALLER_PW, code } });
  eq(again.status, 409, "activation never runs twice");
});

await check("the accounts file holds a hash, never the password", async () => {
  const text = await readFile(join(dirA, "accounts.json"), "utf8");
  eq(text.includes(INSTALLER_PW), false, "no plaintext");
  const data = JSON.parse(text);
  eq(data.users[0].hash.algo, "scrypt", "scrypt");
  if (process.platform !== "win32") eq((await stat(join(dirA, "accounts.json"))).mode & 0o777, 0o600, "accounts mode");
});

let installer;
await check("login: right password in; wrong password and unknown user get the same answer", async () => {
  const bad = await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: "wrong wrong wrong" } });
  const unknown = await call(A.base, "POST", "/auth/login", { body: { username: "nobody", password: "wrong wrong wrong" } });
  eq(bad.status, 401, "bad status");
  same(bad.json, unknown.json, "indistinguishable");
  const ok = await call(A.base, "POST", "/auth/login", { body: { username: "TECH", password: INSTALLER_PW } });
  eq(ok.status, 200, "login");
  installer = ok.jar;
  const page = await call(A.base, "GET", "/ui/live-client.js", { cookie: installer });
  eq(page.status, 200, "signed in, the page script loads");
  const login = await call(A.base, "GET", "/login?next=%2Freview", { cookie: installer });
  eq([login.status, login.headers.get("location")], [302, "/review"], "signed in, /login goes where next says");
  const offsite = await call(A.base, "GET", "/login?next=%2F%2Fevil.example", { cookie: installer });
  eq(offsite.headers.get("location"), "/", "but never off the box");
});

await check("a request from another site's page is refused, even carrying the cookie", async () => {
  const body = { username: "sneaky", role: "installer", password: "another long passphrase" };
  const evil = await call(A.base, "POST", "/accounts", { body, cookie: installer, headers: { Origin: "http://evil.example" } });
  eq(evil.status, 403, "foreign Origin");
  const site = await call(A.base, "POST", "/accounts", { body, cookie: installer, headers: { "Sec-Fetch-Site": "cross-site" } });
  eq(site.status, 403, "cross-site fetch metadata");
  const form = await call(A.base, "POST", "/accounts", { body: "username=sneaky", cookie: installer, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  eq(form.status, 415, "a plain form post");
  const list = await call(A.base, "GET", "/accounts", { cookie: installer });
  eq(list.json.accounts.map((a) => a.username), ["tech"], "nothing was created");
});

let store;
await check("the store account runs the day and cannot manage the box", async () => {
  const made = await call(A.base, "POST", "/accounts", { body: { username: "frontdesk", role: "store", password: STORE_PW }, cookie: installer });
  eq(made.status, 200, "installer creates store");
  const dup = await call(A.base, "POST", "/accounts", { body: { username: "FrontDesk", role: "store", password: STORE_PW }, cookie: installer });
  eq(dup.status, 409, "names are unique, any case");
  const role = await call(A.base, "POST", "/accounts", { body: { username: "boss", role: "admin", password: STORE_PW }, cookie: installer });
  eq(role.status, 400, "no role this code never issued");
  store = (await call(A.base, "POST", "/auth/login", { body: { username: "frontdesk", password: STORE_PW } })).jar;
  eq((await call(A.base, "GET", "/ui/review-client.js", { cookie: store })).status, 200, "store reviews");
  for (const [m, p, body] of [["GET", "/accounts"], ["POST", "/accounts", { username: "x2", role: "installer", password: STORE_PW }],
    ["DELETE", "/accounts/tech"], ["GET", "/audit"], ["GET", "/displays"], ["GET", "/accounts-page"]]) {
    eq((await call(A.base, m, p, { body, cookie: store })).status, 403, `store ${m} ${p}`);
  }
});

await check("the last installer cannot be removed; a removed account is signed out at once", async () => {
  const last = await call(A.base, "DELETE", "/accounts/tech", { cookie: installer });
  eq(last.status, 409, "last installer");
  const removed = await call(A.base, "DELETE", "/accounts/frontdesk", { cookie: installer });
  eq(removed.status, 200, "remove store");
  eq((await call(A.base, "GET", "/ui/review-client.js", { cookie: store })).status, 401, "its session is dead");
});

await check("a password change signs out every other session of that account", async () => {
  const other = (await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: INSTALLER_PW } })).jar;
  const wrong = await call(A.base, "POST", "/auth/password", { body: { currentPassword: "not it at all", newPassword: "brand new passphrase" }, cookie: installer });
  eq(wrong.status, 401, "current password required");
  const ok = await call(A.base, "POST", "/auth/password", { body: { currentPassword: INSTALLER_PW, newPassword: "brand new passphrase" }, cookie: installer });
  eq(ok.status, 200, "changed");
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: other })).status, 401, "other session dead");
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: installer })).status, 401, "old cookie of this one too");
  installer = ok.jar;
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: installer })).status, 200, "the new cookie works");
  eq((await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: INSTALLER_PW } })).status, 401, "old password dead");
});

let displayToken;
let displayCookie;
await check("a wall display watches live, nothing else, and survives a restart", async () => {
  const made = await call(A.base, "POST", "/displays", { body: { displayId: "backroom-tv" }, cookie: installer });
  eq(made.status, 200, "created");
  displayToken = made.json.token;
  eq(typeof displayToken === "string" && displayToken.length >= 24, true, "a long token, shown once");
  eq((await readFile(join(dirA, "accounts.json"), "utf8")).includes(displayToken), false, "stored only as a hash");
  eq(JSON.stringify((await call(A.base, "GET", "/displays", { cookie: installer })).json).includes(displayToken), false, "never listed again");
  eq((await call(A.base, "POST", "/auth/display", { body: { token: "WRONGTOKENWRONGTOKEN" } })).status, 401, "bad token");
  const paired = await call(A.base, "POST", "/auth/display", { body: { token: displayToken } });
  eq(paired.status, 200, "paired");
  displayCookie = paired.jar;
  eq((await call(A.base, "GET", "/ui/wall-client.js", { cookie: displayCookie })).status, 200, "live script");
  for (const p of ["/review", "/export", "/timeline", "/segments/cam-1.1", "/accounts"]) {
    eq((await call(A.base, "GET", p, { cookie: displayCookie })).status, 403, `display ${p}`);
  }
  eq((await call(A.base, "POST", "/auth/password", { body: { currentPassword: "x", newPassword: "y" }, cookie: displayCookie })).status, 403, "no password to change");
});

await check("after a restart: sessions are gone, accounts and displays are not", async () => {
  const B = await boot(dirA, { trustLoopback: false });
  eq((await call(B.base, "GET", "/ui/live-client.js", { cookie: installer })).status, 401, "session did not survive");
  eq((await call(B.base, "GET", "/ui/wall-client.js", { cookie: displayCookie })).status, 200, "display did");
  eq((await call(B.base, "POST", "/auth/login", { body: { username: "tech", password: "brand new passphrase" } })).status, 200, "account did");
  let noCode = false;
  try { await stat(join(dirA, "activation-code")); } catch { noCode = true; }
  eq(noCode, true, "no new activation code for an activated box");
  const del = await call(A.base, "DELETE", "/displays/backroom-tv", { cookie: installer });
  eq(del.status, 200, "display removed");
  eq((await call(A.base, "GET", "/ui/wall-client.js", { cookie: displayCookie })).status, 401, "and signed out");
});

await check("sessions expire after 12 idle hours", async () => {
  const s = (await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: "brand new passphrase" } })).jar;
  clock = new Date(clock.getTime() + 11 * 3600 * 1000);
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: s })).status, 200, "11 h idle");
  clock = new Date(clock.getTime() + 12 * 3600 * 1000 + 1000);
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: s })).status, 401, "12 h idle");
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: "camplat_session=forged" })).status, 401, "a forged cookie");
});

await check("the sign-in and account pages are installed and served", async () => {
  const s = (await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: "brand new passphrase" } })).jar;
  const login = await call(A.base, "GET", "/login");
  eq([login.status, login.text.includes("/ui/login-client.js")], [200, true], "login page, signed out");
  eq((await call(A.base, "GET", "/ui/login-client.js")).status, 200, "login script, signed out");
  const page = await call(A.base, "GET", "/accounts-page", { cookie: s });
  eq([page.status, page.text.includes("/ui/accounts-client.js")], [200, true], "accounts page");
  eq((await call(A.base, "GET", "/ui/accounts-client.js", { cookie: s })).status, 200, "accounts script");
  for (const p of ["/", "/review", "/system"]) {
    eq((await call(A.base, "GET", p, { cookie: s })).text.includes('src="/ui/session.js"'), true, `${p} carries the session bar`);
  }
  eq((await call(A.base, "GET", "/ui/session.js", { cookie: s })).status, 200, "session script");
  eq((await call(A.base, "GET", "/ui/session.js")).status, 401, "session script, signed out");
});

await check("logout ends the session on the server, not just in the browser", async () => {
  const s = (await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: "brand new passphrase" } })).jar;
  const out = await call(A.base, "POST", "/auth/logout", { cookie: s, body: {} });
  eq(out.status, 200, "logout");
  eq((await call(A.base, "GET", "/ui/live-client.js", { cookie: s })).status, 401, "replayed cookie");
});

await check("the audit log records sign-ins, failures and account changes, and no password", async () => {
  const s = (await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: "brand new passphrase" } })).jar;
  await new Promise((r) => setTimeout(r, 50));
  const a = await call(A.base, "GET", "/audit", { cookie: s });
  const events = new Set(a.json.entries.map((e) => e.event));
  for (const e of ["activated", "login", "login_failed", "account_created", "account_removed", "password_changed", "display_created", "display_removed"]) {
    eq(events.has(e), true, `audit has ${e}`);
  }
  const raw = await readFile(join(dirA, "audit.jsonl"), "utf8");
  for (const pw of [INSTALLER_PW, STORE_PW, "brand new passphrase", "wrong wrong wrong"]) eq(raw.includes(pw), false, "no password in audit");
});

await check("guessing is slowed: five free failures, then 429 with Retry-After", async () => {
  const dir = await stateDir();
  const C = await boot(dir);
  await call(C.base, "POST", "/auth/activate", { body: { username: "tech", password: INSTALLER_PW } });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(C.base, "POST", "/auth/login", { body: { username: "tech", password: "guess guess " + i } })).status);
  eq(codes, [401, 401, 401, 401, 401, 429], "statuses");
  const locked = await call(C.base, "POST", "/auth/login", { body: { username: "tech", password: INSTALLER_PW } });
  eq(locked.status, 429, "even the right password waits");
  eq(Number(locked.headers.get("retry-after")) > 0, true, "Retry-After");
  clock = new Date(clock.getTime() + 31 * 1000);
  eq((await call(C.base, "POST", "/auth/login", { body: { username: "tech", password: INSTALLER_PW } })).status, 200, "after the wait");
});

await check("from the box itself, activation needs no code", async () => {
  const dir = await stateDir();
  const D = await boot(dir);
  eq((await call(D.base, "GET", "/auth/state")).json.activationNeedsCode, false, "loopback");
  eq((await call(D.base, "POST", "/auth/activate", { body: { username: "tech", password: INSTALLER_PW } })).status, 200, "activated");
});

await check("a damaged accounts file locks the box; it never reopens activation", async () => {
  const dir = await stateDir();
  await writeFile(join(dir, "accounts.json"), "{ not json");
  const E = await boot(dir);
  eq(E.auth.isBroken(), true, "broken");
  let noCode = false;
  try { await stat(join(dir, "activation-code")); } catch { noCode = true; }
  eq(noCode, true, "no activation code");
  eq((await call(E.base, "GET", "/auth/state")).status, 503, "state");
  eq((await call(E.base, "POST", "/auth/activate", { body: { username: "evil", password: INSTALLER_PW } })).status, 503, "activate");
  eq((await call(E.base, "POST", "/auth/login", { body: { username: "tech", password: INSTALLER_PW } })).status, 503, "login");
  eq((await readFile(join(dir, "accounts.json"), "utf8")), "{ not json", "the file is left for a person to repair");
  for (const bad of [
    JSON.stringify({ version: 1, users: [{ username: "tech", role: "installer", hash: { algo: "scrypt", N: 1073741824, r: 8, p: 1, salt: "0".repeat(64), key: "0".repeat(128) } }], displays: [] }),
    JSON.stringify({ version: 1, users: [{ username: "tech", role: "admin", hash: {} }], displays: [] }),
    JSON.stringify({ version: 2, users: [], displays: [] }),
    "[]",
  ]) {
    const d2 = await stateDir();
    await writeFile(join(d2, "accounts.json"), bad);
    const F = await createAuth({ stateDir: d2, now, scryptParams: FAST, log: quiet });
    eq(F.isBroken(), true, `refused: ${bad.slice(0, 40)}`);
  }
});

await check("a live stream is refused before the upgrade, signed out or from another site", async () => {
  const upgrade = (headers) => new Promise((resolve, reject) => {
    const req = httpRequest(A.base + "/live/cam-1", {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(101); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  eq(await upgrade({}), 401, "signed out");
  const s = (await call(A.base, "POST", "/auth/login", { body: { username: "tech", password: "brand new passphrase" } })).jar;
  eq(await upgrade({ Cookie: s, Origin: "http://evil.example" }), 403, "foreign origin");
});

for (const s of servers) s.close();
for (const d of dirs) await rm(d, { recursive: true, force: true });
report("auth");
