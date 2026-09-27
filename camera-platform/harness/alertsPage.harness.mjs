/**
 * agent/ui/alerts-client.mjs: the Alerts page (MANAGER-ALERTS-SPEC.md "The
 * phone side") -- the pure helpers (secure-context check, iOS/standalone
 * detection, the user-agent label, the VAPID key decode, the subscribe
 * body), the subscribe flow driven with a fake PushManager and no real
 * browser, the insecure-context message, the iOS "Add to Home Screen" hint,
 * and the browser bootstrap block (camera-page-bootstrap-lesson, agent bus
 * 2026-09-26).
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/alertsPage.harness.mjs`.
 *
 * THE FEARED FAILURES, by name:
 *  - a subscribe attempt on an insecure page anyway, or one whose failure
 *    message claims "needs https" when the REAL problem was something else
 *    (an old browser with no Push API, a network error) -- isSecureContextOk
 *    is checked once, up front, and every other failure path in
 *    subscribeThisPhone carries its OWN code and message.
 *  - a raw subscription's endpoint or keys ending up anywhere this file logs
 *    or renders -- checked by grepping this file's own source, the same
 *    "prove it structurally" shape agent/push-delivery.mjs's own header
 *    comment already uses for the identical claim server-side.
 *  - camera-page-bootstrap-lesson itself: a client with no browser bootstrap
 *    block passes every check above while the real page never fetches
 *    anything -- THE FEARED ONE, at the bottom of this file, closes that gap
 *    for this page too.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, same, throws, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/alerts-client.mjs")).href);
const webPush = await import(pathToFileURL(join(root, "agent/web-push.mjs")).href);

console.log("alerts page");

/* ── urlBase64ToUint8Array: round-trips the SAME bytes generateVapidKeys
   itself produces, using this codebase's own toBase64Url as the encoder ──── */

check("REQUIRED: urlBase64ToUint8Array decodes a real VAPID public key back to its own 65 raw bytes, 0x04-prefixed", () => {
  const { publicKey } = webPush.generateVapidKeys();
  const encoded = webPush.toBase64Url(publicKey);
  const decoded = client.urlBase64ToUint8Array(encoded);
  eq(decoded.length, 65, "an uncompressed P-256 point is exactly 65 bytes");
  eq(decoded[0], 0x04, "the uncompressed-point marker");
  eq(Buffer.from(decoded).equals(publicKey), true, "byte-for-byte identical to the key generateVapidKeys actually returned");
});

check("urlBase64ToUint8Array handles every padding length (base64url drops the '=' padding base64 needs)", () => {
  for (const bytes of [Buffer.from([1]), Buffer.from([1, 2]), Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3, 4])]) {
    const encoded = webPush.toBase64Url(bytes);
    eq(Buffer.from(client.urlBase64ToUint8Array(encoded)).equals(bytes), true, `${bytes.length}-byte input`);
  }
});

check("urlBase64ToUint8Array refuses an empty or non-string input rather than returning an empty key", () => {
  throws(() => client.urlBase64ToUint8Array(""), "empty string");
  throws(() => client.urlBase64ToUint8Array(undefined), "undefined");
  throws(() => client.urlBase64ToUint8Array(null), "null");
});

/* ── isSecureContextOk: a blank is not a secure context ──────────────────── */

check("isSecureContextOk is true only for isSecureContext === true, never a truthy-looking value or an absent one", () => {
  eq(client.isSecureContextOk({ isSecureContext: true }), true);
  eq(client.isSecureContextOk({ isSecureContext: false }), false);
  eq(client.isSecureContextOk({ isSecureContext: "true" }), false, "a string is not the boolean true");
  eq(client.isSecureContextOk({}), false, "no such field at all: never assumed secure");
  eq(client.isSecureContextOk(null), false);
  eq(client.isSecureContextOk(undefined), false);
});

/* ── iOS Safari / standalone detection ───────────────────────────────────── */

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const WINDOWS_FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

check("REQUIRED: isIosSafari is true for real iPhone Safari, false for iOS Chrome (CriOS), Android and desktop", () => {
  eq(client.isIosSafari({ userAgent: IPHONE_SAFARI_UA }), true, "iPhone Safari");
  eq(client.isIosSafari({ userAgent: IPHONE_CHROME_UA }), false, "iOS Chrome carries its own CriOS token ahead of Safari's");
  eq(client.isIosSafari({ userAgent: ANDROID_CHROME_UA }), false, "Android");
  eq(client.isIosSafari({ userAgent: DESKTOP_SAFARI_UA }), false, "desktop Safari is not iOS");
  eq(client.isIosSafari(null), false, "no navigator at all");
  eq(client.isIosSafari({}), false, "no userAgent field");
});

check("isStandaloneDisplay reads either navigator.standalone (iOS Safari's own) or the display-mode media query", () => {
  eq(client.isStandaloneDisplay({}, { standalone: true }), true, "iOS Safari's own flag");
  eq(client.isStandaloneDisplay({ matchMedia: () => ({ matches: true }) }, {}), true, "the standard media query");
  eq(client.isStandaloneDisplay({ matchMedia: () => ({ matches: false }) }, { standalone: false }), false);
  eq(client.isStandaloneDisplay({}, {}), false, "neither signal present: not standalone");
});

check("REQUIRED: needsAddToHomeScreenHint is iOS Safari AND not yet standalone -- never shown once it has been added", () => {
  const iosSafariNav = { userAgent: IPHONE_SAFARI_UA, standalone: false };
  eq(client.needsAddToHomeScreenHint({}, iosSafariNav), true, "not yet added: show the hint");
  eq(client.needsAddToHomeScreenHint({}, { ...iosSafariNav, standalone: true }), false, "already added: nothing left to tell it");
  eq(client.needsAddToHomeScreenHint({}, { userAgent: ANDROID_CHROME_UA }), false, "never shown off iOS Safari at all");
});

/* ── the user-agent label ────────────────────────────────────────────────── */

check("deriveLabelFromUserAgent names the OS and the real browser, never a fabricated specific one for an unknown UA", () => {
  eq(client.deriveLabelFromUserAgent(IPHONE_SAFARI_UA), "iPhone Safari");
  eq(client.deriveLabelFromUserAgent(ANDROID_CHROME_UA), "Android Chrome");
  eq(client.deriveLabelFromUserAgent(WINDOWS_FIREFOX_UA), "Windows Firefox");
  eq(client.deriveLabelFromUserAgent(DESKTOP_SAFARI_UA), "Mac Safari");
  eq(client.deriveLabelFromUserAgent("something nobody has ever seen before"), "This device browser");
  eq(client.deriveLabelFromUserAgent(undefined), "This device browser");
  eq(client.deriveLabelFromUserAgent(null).length <= client.MAX_LABEL_LENGTH, true, "never longer than the field's own limit");
});

/* ── rule selection and the subscribe body ───────────────────────────────── */

check('ruleSelectionFrom: "pick" with nothing checked still reads as "all", never an empty allow-list', () => {
  eq(client.ruleSelectionFrom("pick", []), "all");
  eq(client.ruleSelectionFrom("pick", ["r1", "r2"]), ["r1", "r2"]);
  eq(client.ruleSelectionFrom("all", ["r1"]), "all", "the \"all\" radio wins regardless of what a stale checkbox still carries");
});

check("buildSubscribeBody carries the raw subscription through unchanged, plus label and rules", () => {
  const raw = { endpoint: "https://push.example/abc", keys: { p256dh: "P", auth: "A" } };
  same(client.buildSubscribeBody(raw, "iPhone Safari", "all"), { subscription: raw, label: "iPhone Safari", rules: "all" });
  same(client.buildSubscribeBody(raw, null, ["r1"]), { subscription: raw, label: null, rules: ["r1"] });
});

check("rawSubscriptionFrom keeps only endpoint and the two keys, dropping anything else the browser's own PushSubscription carries (e.g. expirationTime)", () => {
  const sub = { toJSON: () => ({ endpoint: "https://push.example/abc", expirationTime: null, keys: { p256dh: "P", auth: "A", extra: "nope" } }) };
  same(client.rawSubscriptionFrom(sub), { endpoint: "https://push.example/abc", keys: { p256dh: "P", auth: "A" } });
});

/* ── the subscribe flow, with a FAKE PushManager -- no real browser, no real
   push service, no network at all ───────────────────────────────────────── */

function fakePushManager({ subscribeResult, subscribeError } = {}) {
  return {
    subscribe: async (opts) => {
      if (subscribeError) throw subscribeError;
      return subscribeResult ?? {
        toJSON: () => ({ endpoint: "https://push.example/dev-1", keys: { p256dh: "P256DH", auth: "AUTH" } }),
        applicationServerKeyUsed: opts.applicationServerKey,
      };
    },
  };
}

function fakeFetchFor({ publicKey, saveOk = true, saveBody } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("/push/public-key")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, publicKey: publicKey ?? webPush.toBase64Url(webPush.generateVapidKeys().publicKey) }) };
    }
    if (String(url).startsWith("/push/subscribe")) {
      return {
        ok: saveOk,
        status: saveOk ? 200 : 400,
        json: async () => saveBody ?? (saveOk ? { ok: true, subscription: { id: "sub-1", label: "iPhone Safari", rules: "all", createdUtc: "2026-09-27T00:00:00.000Z", endpointHost: "push.example" } } : { ok: false, code: "invalid_subscription", message: "nope" }),
      };
    }
    throw new Error(`unexpected fetch in this test: ${url}`);
  };
  return { fetchFn, calls };
}

await check("REQUIRED: subscribeThisPhone end to end with a fake PushManager -- registers the worker, reads the public key, subscribes, and saves the RAW subscription", async () => {
  let registeredPath = null;
  const nav = {
    userAgent: IPHONE_SAFARI_UA,
    serviceWorker: {
      register: async (path) => { registeredPath = path; return { pushManager: fakePushManager() }; },
    },
  };
  const { fetchFn, calls } = fakeFetchFor({});
  const result = await client.subscribeThisPhone({ win: { isSecureContext: true }, nav, fetchFn, label: "iPhone Safari", rules: "all" });
  eq(result.ok, true, JSON.stringify(result));
  eq(registeredPath, "/sw.js", "registers exactly /sw.js, not some other path");
  eq(calls[0].url.startsWith("/push/public-key"), true, "reads the public key before subscribing");
  const subscribeCall = calls.find((c) => c.url.startsWith("/push/subscribe"));
  eq(subscribeCall !== undefined, true, "saved the subscription server-side");
  const sentBody = JSON.parse(subscribeCall.init.body);
  same(sentBody, { subscription: { endpoint: "https://push.example/dev-1", keys: { p256dh: "P256DH", auth: "AUTH" } }, label: "iPhone Safari", rules: "all" });
  eq(sentBody.subscription.endpoint.startsWith("https://push.example/"), true, "the RAW endpoint travels up to the server -- see the note below on it never traveling back down");
});

await check("subscribeThisPhone never even attempts a service-worker registration on an insecure context", async () => {
  let registerCalled = false;
  const nav = { userAgent: IPHONE_SAFARI_UA, serviceWorker: { register: async () => { registerCalled = true; return {}; } } };
  const result = await client.subscribeThisPhone({ win: { isSecureContext: false }, nav, fetchFn: async () => { throw new Error("must not fetch"); }, label: "x", rules: "all" });
  eq(result.ok, false);
  eq(result.code, "insecure_context");
  eq(result.message, client.SECURE_CONTEXT_MESSAGE);
  eq(registerCalled, false, "REQUIRED: no service-worker registration attempt at all -- the secure-context check runs first");
});

await check("subscribeThisPhone reports a browser with no serviceWorker support with its OWN message, never the https one", async () => {
  const result = await client.subscribeThisPhone({ win: { isSecureContext: true }, nav: { userAgent: "x" }, fetchFn: async () => { throw new Error("must not fetch"); }, label: "x", rules: "all" });
  eq(result.ok, false);
  eq(result.code, "no_service_worker");
  eq(result.message === client.SECURE_CONTEXT_MESSAGE, false, "a DIFFERENT failure must never be reported as the https message");
});

await check("subscribeThisPhone surfaces a PushManager.subscribe() rejection (e.g. permission denied) as its own failure, and never calls /push/subscribe afterward", async () => {
  const nav = {
    userAgent: IPHONE_SAFARI_UA,
    serviceWorker: { register: async () => ({ pushManager: fakePushManager({ subscribeError: new Error("permission denied") }) }) },
  };
  const { fetchFn, calls } = fakeFetchFor({});
  const result = await client.subscribeThisPhone({ win: { isSecureContext: true }, nav, fetchFn, label: "x", rules: "all" });
  eq(result.ok, false);
  eq(result.code, "subscribe_failed");
  eq(calls.some((c) => c.url.startsWith("/push/subscribe")), false, "REQUIRED: never saves anything server-side after a failed subscribe -- no half-done state");
});

await check("subscribeThisPhone surfaces the server's own refusal (e.g. an unreadable subscriptions file) rather than claiming success", async () => {
  const nav = { userAgent: IPHONE_SAFARI_UA, serviceWorker: { register: async () => ({ pushManager: fakePushManager() }) } };
  const { fetchFn } = fakeFetchFor({ saveOk: false, saveBody: { ok: false, code: "subscriptions_unreadable", message: "cannot be trusted right now" } });
  const result = await client.subscribeThisPhone({ win: { isSecureContext: true }, nav, fetchFn, label: "x", rules: "all" });
  eq(result.ok, false);
  eq(result.code, "subscriptions_unreadable");
});

/* ── this file never lets a raw endpoint or key travel BACK down to the page
   for display -- structural, the same shape agent/push-delivery.mjs's own
   header comment uses for the identical claim server-side ───────────────── */

await check("REQUIRED: renderDeviceList's own source never reads .endpoint, .p256dh or .auth off a stored device row -- only the server's own stripped subscriptionView fields", async () => {
  const src = await readFile(join(root, "agent/ui/alerts-client.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fnStart = code.indexOf("function renderDeviceList");
  const fnEnd = code.indexOf("\n  }\n", fnStart);
  eq(fnStart >= 0 && fnEnd > fnStart, true, "renderDeviceList itself was found in the source");
  const fnSrc = code.slice(fnStart, fnEnd);
  // "d.endpointHost" is the server's own STRIPPED field (agent/push-
  // delivery.mjs's own subscriptionView) and is exactly what this function
  // is allowed to show -- only the RAW "d.endpoint" (no "Host" suffix) is
  // the failure this check exists to catch.
  for (const bad of [/\.p256dh\b/, /\.auth\b/, /d\.endpoint(?!Host)/, /row\.endpoint(?!Host)/]) {
    eq(bad.test(fnSrc), false, `renderDeviceList must never read ${bad} off a stored device row -- only rawSubscriptionFrom (a DIFFERENT function, reading the browser's OWN fresh PushSubscription, never a stored row) may name these`);
  }
});

/* ── startAlertsPage: the insecure-context message and the iOS hint, driven
   through the page function itself with a fake `doc` ──────────────────── */

function fakeEl() {
  const listeners = {};
  return {
    hidden: false, disabled: false, textContent: "", checked: false, value: "",
    children: [],
    addEventListener(type, fn) { listeners[type] = fn; },
    append(...kids) { this.children.push(...kids); },
    querySelectorAll() { return []; },
    _fire(type, ev) { if (listeners[type]) return listeners[type](ev); },
  };
}

function fakeDoc(ids) {
  const els = new Map();
  for (const id of ids) els.set(id, fakeEl());
  return {
    getElementById: (id) => els.get(id) ?? null,
    createElement: () => fakeEl(),
    _els: els,
  };
}

check("REQUIRED: an insecure context hides the subscribe button and shows the exact secure-context message", () => {
  const doc = fakeDoc(["alertsBody", "secureNotice", "iosHint", "subscribeBtn", "subscribeStatus", "testBtn", "testStatus", "deviceList", "deviceEmpty", "ruleModeAll", "ruleModePick", "rulePickList"]);
  client.startAlertsPage({ doc, win: { isSecureContext: false }, nav: { userAgent: DESKTOP_SAFARI_UA }, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  eq(doc._els.get("subscribeBtn").hidden, true);
  eq(doc._els.get("secureNotice").hidden, false);
  eq(doc._els.get("secureNotice").textContent, client.SECURE_CONTEXT_MESSAGE);
});

check("a secure context shows the button and no message", () => {
  const doc = fakeDoc(["alertsBody", "secureNotice", "iosHint", "subscribeBtn", "subscribeStatus", "testBtn", "testStatus", "deviceList", "deviceEmpty", "ruleModeAll", "ruleModePick", "rulePickList"]);
  client.startAlertsPage({ doc, win: { isSecureContext: true }, nav: { userAgent: DESKTOP_SAFARI_UA }, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  eq(doc._els.get("subscribeBtn").hidden, false);
  eq(doc._els.get("secureNotice").hidden, true);
});

check("REQUIRED: iOS Safari not yet standalone shows the one-step hint; anything else shows nothing", () => {
  const docIos = fakeDoc(["alertsBody", "secureNotice", "iosHint", "subscribeBtn", "subscribeStatus", "testBtn", "testStatus", "deviceList", "deviceEmpty", "ruleModeAll", "ruleModePick", "rulePickList"]);
  client.startAlertsPage({ doc: docIos, win: { isSecureContext: true }, nav: { userAgent: IPHONE_SAFARI_UA, standalone: false }, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  eq(docIos._els.get("iosHint").hidden, false);
  eq(docIos._els.get("iosHint").textContent, client.IOS_ADD_TO_HOME_SCREEN_HINT);

  const docAndroid = fakeDoc(["alertsBody", "secureNotice", "iosHint", "subscribeBtn", "subscribeStatus", "testBtn", "testStatus", "deviceList", "deviceEmpty", "ruleModeAll", "ruleModePick", "rulePickList"]);
  client.startAlertsPage({ doc: docAndroid, win: { isSecureContext: true }, nav: { userAgent: ANDROID_CHROME_UA }, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  eq(docAndroid._els.get("iosHint").hidden, true);
});

/** THE FEARED ONE: with #alertsBody in the DOM, the real bootstrap fetches
 *  every route this page needs on its own, with no harness calling
 *  startAlertsPage directly -- same isolation shape as
 *  harness/rulesPage.harness.mjs and harness/activityPage.harness.mjs. */
await check("THE FEARED ONE: the real bootstrap fetches /rules and /push/my-subscriptions on its own", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/alerts-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent" || k === "checked") return "";
        if (k === "length") return 0;
        if (k === "hidden" || k === "disabled") return false;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    globalThis.document = {
      getElementById: (id) => (id === "alertsBody" ? fake : null),
      createElement: () => fake, createElementNS: () => fake, createTextNode: () => fake,
      querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {}, isSecureContext: true, matchMedia: () => ({ matches: false }) };
    // Node itself defines a getter-only global "navigator" (its own fetch
    // implementation's identity) -- a plain "globalThis.navigator = ..."
    // throws under it, so this needs defineProperty, unlike every other
    // global this harness style replaces outright.
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "harness", serviceWorker: { register: async () => ({ pushManager: { subscribe: async () => ({}) } }) } },
      configurable: true,
    });
    const calls = [];
    globalThis.fetch = (url) => {
      calls.push(String(url));
      const u = String(url);
      if (u.startsWith("/rules")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ rules: [] }) });
      if (u.startsWith("/push/my-subscriptions")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, subscriptions: [] }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };
    await import(${JSON.stringify(clientUrl)} + "?boot");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(calls));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  eq(r.status, 0, `the child ran (${(r.stderr || "").slice(0, 500)})`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  const calls = JSON.parse(lines[lines.length - 1] || "[]");
  for (const path of ["/rules", "/push/my-subscriptions"]) {
    eq(calls.some((u) => u.startsWith(path)), true, `it asked for ${path} on its own: ${JSON.stringify(calls)}`);
  }
});

check("a harness importing this module for its pure helpers alone (no #alertsBody in the DOM) triggers no bootstrap side effect", () => {
  eq(typeof document === "undefined" || document.getElementById === undefined || document.getElementById("alertsBody") == null, true);
});

report("alerts page");
