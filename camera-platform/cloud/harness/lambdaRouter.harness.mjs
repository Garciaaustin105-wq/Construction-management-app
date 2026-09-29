// cloud/harness/lambdaRouter.harness.mjs — cloud/lambda/router.mjs (CLOUD-AWS-SPEC.md B).
//
// FEARED: API Gateway's 2.0 event differing from what the handlers expect
// (cookies arrive in `event.cookies`, not a header; bodies may be base64), so
// login "works" locally and fails on AWS; a session cookie that never reaches
// the browser because it stayed in `headers`; a dev-only shortcut (the dev
// token, the site-dev glue) shipped to production; a crash that logs the
// request, and with it a password, a cookie or a claim code.
//
// The box's REAL enroll() and sendCheckin() run here, through a fetch that
// turns each request into an API Gateway 2.0 event and hands it to the router.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouter } from "../lambda/router.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";
import { runAdmin } from "../admin/admin.mjs";
import { enroll as boxEnroll } from "../../agent/cloud-enroll.mjs";
import { sendCheckin } from "../../agent/checkin.mjs";

console.log("lambda router");

const FAST = { N: 1024, r: 8, p: 1 };
const PW = "correct horse battery";
const LOGIN = "tech@example.com";
const API = "https://abc123.execute-api.us-east-1.amazonaws.com";

/** An API Gateway HTTP API payload 2.0 event, as AWS sends it. */
function apiEvent(method, rawPath, { body, headers = {}, cookies, sourceIp = "198.51.100.7", base64 = false, routeKey } = {}) {
  const event = {
    version: "2.0",
    routeKey: routeKey ?? `${method} ${rawPath}`,
    rawPath,
    rawQueryString: "",
    headers: { "user-agent": "harness", ...headers },
    requestContext: {
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp, userAgent: "harness" },
      routeKey: routeKey ?? `${method} ${rawPath}`,
      stage: "$default",
    },
    isBase64Encoded: base64,
  };
  if (cookies) event.cookies = cookies;
  if (body !== undefined) event.body = base64 ? Buffer.from(body, "utf8").toString("base64") : body;
  return event;
}
const json = (method, p, obj, extra = {}) =>
  apiEvent(method, p, { body: JSON.stringify(obj), headers: { "content-type": "application/json" }, ...extra });

/** fetch() for the box's own code: every request becomes an event for `route`. */
const fetchVia = (route) => async (url, init = {}) => {
  const u = new URL(url);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = {};
  for (const [k, v] of new Headers(init.headers ?? {})) headers[k] = v;
  const res = await route(apiEvent(method, u.pathname, { body: init.body ?? undefined, headers }));
  return new Response(res.body ?? "", { status: res.statusCode, headers: res.headers ?? {} });
};

// A test box identity: a real Ed25519 key and the box's deviceId derivation,
// base32(sha256(SPKI DER)[0:16]), computed here independently on purpose.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function testBox() {
  const kp = generateKeyPairSync("ed25519");
  const der = kp.publicKey.export({ type: "spki", format: "der" });
  const deviceId = base32(createHash("sha256").update(der).digest().subarray(0, 16));
  const publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    deviceId,
    identity: {
      loadOrCreateIdentity: async () => ({ deviceId, publicKeyPem, createdAtUtc: new Date().toISOString() }),
      signWithIdentity: async (_dir, message) =>
        cryptoSign(null, Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8"), kp.privateKey),
    },
  };
}

/** A router over a fresh memory store, an installer with one site and one user. */
async function setup({ store = createMemoryStore() } = {}) {
  const logs = [];
  const route = createRouter({ store, nowMs: () => Date.now(), randomBytes, log: (entry) => logs.push(entry), scryptParams: FAST });
  const answers = [];
  const admin = (...argv) =>
    runAdmin(argv, {
      store,
      out: () => {},
      promptSecret: async () => answers.shift(),
      nowMs: () => Date.now(),
      randomBytes,
      scryptParams: FAST,
    });
  eq(await admin("create-installer", "inst-1", "Acme Security"), 0, "installer");
  answers.push(PW, PW);
  eq(await admin("create-user", LOGIN, "inst-1"), 0, "user");
  eq(await admin("create-org", "inst-1", "org-1", "Car Wash Co"), 0, "org");
  eq(await admin("create-site", "inst-1", "org-1", "site-1", "Main St"), 0, "site");
  return { store, route, logs, admin };
}
async function loginCookie(route) {
  const res = await route(json("POST", "/login", { login: LOGIN, password: PW }));
  eq(res.statusCode, 200, `login: ${res.body}`);
  const cookie = (res.cookies ?? [])[0] ?? "";
  const m = /^camplat_session=([A-Za-z0-9_-]{43});/.exec(cookie);
  if (!m) throw new Error(`no session cookie in cookies: ${JSON.stringify(res)}`);
  return { res, pair: `camplat_session=${m[1]}`, token: m[1] };
}

await check("the whole loop through API Gateway 2.0 events: login, enrol, claim, assign, check in, online", async () => {
  const { route, admin } = await setup();
  const { pair } = await loginCookie(route);
  const box = testBox();
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-router-box-"));
  try {
    const e = await boxEnroll({ stateDir, url: `${API}/enroll`, fetchFn: fetchVia(route), identity: box.identity });
    eq(typeof e.claimCode, "string", `the box enrols through the router, got ${JSON.stringify(e)}`);
    const claim = await route(json("POST", "/claim", { code: e.claimCode }, { cookies: [pair] }));
    eq(claim.statusCode, 200, `claim with the cookie from event.cookies: ${claim.body}`);
    eq(await admin("assign-device", "inst-1", box.deviceId, "site-1"), 0, "assign-device");
    const c = await sendCheckin({ stateDir, url: `${API}/checkin`, fetchFn: fetchVia(route), identity: box.identity, appDir: stateDir });
    eq(c.outcome, "sent", `the box's check-in through the router, got ${JSON.stringify(c)}`);
    const fleet = await route(apiEvent("GET", "/fleet", { cookies: [pair] }));
    eq(fleet.statusCode, 200, `fleet: ${fleet.body}`);
    const row = JSON.parse(fleet.body).rows.find((r) => r.deviceId === box.deviceId);
    eq(row?.status, "online", `the device is online, got ${JSON.stringify(row)}`);
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

await check("the session cookie leaves in `cookies`, not in a header", async () => {
  const { route } = await setup();
  const { res } = await loginCookie(route);
  eq(res.headers?.["set-cookie"], undefined, "no set-cookie header left behind");
  eq(res.cookies.length, 1, "exactly one cookie");
  eq(/; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/.test(res.cookies[0]), true, "flags intact");
});

await check("a cookie sent only as a header still counts (a proxy may fold it)", async () => {
  const { route } = await setup();
  const { pair } = await loginCookie(route);
  const fleet = await route(apiEvent("GET", "/fleet", { headers: { cookie: pair } }));
  eq(fleet.statusCode, 200, `fleet via header cookie: ${fleet.body}`);
});

await check("logout clears the cookie in `cookies` and ends the session", async () => {
  const { route } = await setup();
  const { pair } = await loginCookie(route);
  const out = await route(apiEvent("POST", "/logout", { cookies: [pair] }));
  eq(out.statusCode, 200, "logout");
  eq((out.cookies ?? [])[0], "camplat_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0", "clearing cookie");
  eq((await route(apiEvent("GET", "/fleet", { cookies: [pair] }))).statusCode, 401, "old cookie refused");
});

await check("a base64 body is decoded before the handler sees it", async () => {
  const { route } = await setup();
  const res = await route(
    apiEvent("POST", "/login", {
      body: JSON.stringify({ login: LOGIN, password: "wrong password here" }),
      headers: { "content-type": "application/json" },
      base64: true,
    }),
  );
  eq(res.statusCode, 401, `decoded JSON reaches login (undecoded would be 400), got ${res.statusCode} ${res.body}`);
});

await check("the caller's address comes from requestContext, so the source lock works per address", async () => {
  const { route } = await setup();
  for (let i = 0; i < 20; i++) {
    await route(json("POST", "/login", { login: `ghost${i}@example.com`, password: "wrong password here" }, { sourceIp: "203.0.113.66" }));
  }
  eq((await route(json("POST", "/login", { login: LOGIN, password: PW }, { sourceIp: "203.0.113.66" }))).statusCode, 429, "sprayer blocked");
  eq((await route(json("POST", "/login", { login: LOGIN, password: PW }, { sourceIp: "198.51.100.8" }))).statusCode, 200, "another address fine");
});

await check("a body over 16 KB is refused 413 before any handler or store call", async () => {
  const base = createMemoryStore();
  const calls = { n: 0 };
  const spy = new Proxy(base, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === "function" ? (...a) => (calls.n++, v.apply(target, a)) : v;
    },
  });
  const route = createRouter({ store: spy, nowMs: () => Date.now(), randomBytes, log: () => {}, scryptParams: FAST });
  const res = await route(apiEvent("POST", "/checkin", { body: "x".repeat(16 * 1024 + 1), headers: { "content-type": "application/json" } }));
  eq(res.statusCode, 413, "413");
  same(JSON.parse(res.body), { ok: false, reason: "payload_too_large" }, "body");
  eq(calls.n, 0, "no store call");
  const ok = await route(apiEvent("POST", "/checkin", { body: "x".repeat(16 * 1024), headers: { "content-type": "application/json" } }));
  eq(ok.statusCode !== 413, true, "exactly 16 KB is not refused for size");
});

await check("an unknown route is 404", async () => {
  const { route } = await setup();
  for (const ev of [apiEvent("GET", "/admin"), apiEvent("DELETE", "/fleet"), apiEvent("GET", "/", { routeKey: "$default" })]) {
    const res = await route(ev);
    eq(res.statusCode, 404, `404 for ${ev.routeKey}`);
    same(JSON.parse(res.body), { ok: false, reason: "not_found" }, "body");
  }
});

await check("no dev token, and no site-dev placement, exist in production", async () => {
  const { route, store } = await setup();
  for (const token of ["dev", "x".repeat(48), "0".repeat(48)]) {
    const res = await route(apiEvent("GET", "/fleet", { headers: { authorization: `Bearer ${token}` } }));
    eq(res.statusCode, 401, `a bearer token is not a login (${token.slice(0, 4)}...)`);
  }
  const { pair } = await loginCookie(route);
  const box = testBox();
  const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-router-box-"));
  try {
    const e = await boxEnroll({ stateDir, url: `${API}/enroll`, fetchFn: fetchVia(route), identity: box.identity });
    eq((await route(json("POST", "/claim", { code: e.claimCode }, { cookies: [pair] }))).statusCode, 200, "claim");
    eq((await store.getDevice(box.deviceId)).siteId, null, "a claim alone places the device on no site");
    same((await store.getTenancy("inst-1")).devices, [], "nothing added to the tree until assign-device");
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

await check("a handler that throws gives 500, and the log carries no password, cookie, body or header", async () => {
  const base = createMemoryStore();
  const broken = new Proxy(base, {
    get(target, prop) {
      if (prop === "getUser" || prop === "getSession") return async () => { throw new Error("store unavailable"); };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const logs = [];
  const route = createRouter({ store: broken, nowMs: () => Date.now(), randomBytes, log: (e) => logs.push(e), scryptParams: FAST });
  const secretCookie = `camplat_session=${"S".repeat(43)}`;
  const res = await route(
    json("POST", "/login", { login: LOGIN, password: "a very secret password" }, { cookies: [secretCookie], headers: { "content-type": "application/json", authorization: "Bearer topsecret" } }),
  );
  eq(res.statusCode, 500, `500, got ${res.statusCode}`);
  same(JSON.parse(res.body), { ok: false, reason: "internal" }, "body");
  const fleet = await route(apiEvent("GET", "/fleet", { cookies: [secretCookie] }));
  eq(fleet.statusCode, 500, "a broken session store is a 500, not a silent 401");
  const text = JSON.stringify(logs);
  eq(text.includes("store unavailable"), true, "the error message is logged");
  for (const needle of ["a very secret password", "S".repeat(43), "topsecret", LOGIN]) {
    eq(text.includes(needle), false, `log must not contain ${needle.slice(0, 10)}...`);
  }
});

report("lambda router");
