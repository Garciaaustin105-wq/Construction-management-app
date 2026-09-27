// agent/ui/alerts-client.mjs
//
// Client logic for the Alerts page (agent/ui/alerts.html, MANAGER-ALERTS-
// SPEC.md "The phone side"): "Get alerts on this phone" (register /sw.js,
// subscribe with the box's own VAPID public key), choose all rules or pick
// some, "Send a test alert", and a list of this account's own devices, each
// with Remove.
//
// Same discipline as agent/ui/rules-client.mjs and agent/ui/activity-
// client.mjs: every dependency (the document, the window, the navigator,
// fetch, the clock) arrives through `opts`, never read off a bare global
// inside an exported function, so a harness can drive this without a real
// browser, a real Push API or a real service worker. Nothing here ever sets
// innerHTML -- every node is built with createElement, and every piece of
// untrusted text (a rule's own name, a device's own label) is set with
// .textContent, never innerHTML.
//
// contracts/pushAlerts.ts's own MAX_LABEL_LENGTH is MIRRORED below, not
// imported: a browser resolves this file's own module specifiers against
// where IT was served ("/ui/alerts-client.js"), not against a filesystem
// path, so a relative import of "../../dist/pushAlerts.js" would ask the
// browser for "/dist/pushAlerts.js" -- a path this server never serves (see
// agent/ui/accounts-client.mjs's own comment on GRID_SHAPES for the same
// reason). This IS that contract's own value; nothing here computes a
// different one.
//
// THE FEARED FAILURES this file is written against:
// - a payload showing a real endpoint or key anywhere on screen: this file
//   never reads sub.endpoint/p256dh/auth off a stored row at all (the
//   server's own subscriptionView, agent/push-delivery.mjs, already strips
//   them to an endpointHost) -- it only ever sends the RAW subscription
//   (fresh off pushManager.subscribe) up to the server, never back down.
// - the notification permission or the Push API being missing entirely
//   (an older browser, or a browser that never asked) being treated the
//   same as an insecure context: isSecureContextOk and the actual
//   subscribe attempt are two separate checks, so a secure page with no
//   Push API support fails with its OWN message, not a wrong "needs https".
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): a client with no
//   browser bootstrap block passes every harness check that drives its
//   exported functions directly while the real page never fetches anything.
//   See the bottom of this file.

/** contracts/pushAlerts.ts's own value -- see this file's header comment on
 *  why it is mirrored, not imported. */
export const MAX_LABEL_LENGTH = 60;

/** The exact words MANAGER-ALERTS-SPEC.md asks for: "a plain message that
 *  phone alerts need this page opened over https (for example through the
 *  store's secure link)". */
export const SECURE_CONTEXT_MESSAGE =
  "Phone alerts need this page opened over https (for example through the store's secure link).";

/** MANAGER-ALERTS-SPEC.md: "iPhone: web push works only after 'Add to Home
 *  Screen' (iOS 16.4+)." One step, exactly as the spec asks for. */
export const IOS_ADD_TO_HOME_SCREEN_HINT =
  'On an iPhone: tap Share, then "Add to Home Screen" — alerts only work once this page has been added.';

/* ── pure helpers (no document, no fetch, no Push API) ──────────────────── */

/** `win.isSecureContext` alone -- the Push API's own gate (HTTPS, or
 *  localhost). Never guesses true for a `win` that carries no such field at
 *  all (build rule 5: a blank is not a zero -- an unset value here means
 *  "not secure", never "assume it is"). */
export function isSecureContextOk(win) {
  return !!(win && win.isSecureContext === true);
}

/** True for Safari running ON iOS -- never for Chrome, Firefox or Edge on
 *  iOS, which all carry "Safari" in their own UA string too but ship their
 *  OWN token ahead of it. Apple's iPadOS 13+ Safari reports itself as a Mac
 *  (no "iPad" token at all) unless the site has asked for the mobile UA, so
 *  this is deliberately narrower than "every iOS browser" -- it only ever
 *  covers what MANAGER-ALERTS-SPEC.md itself names, "iPhone". */
export function isIosSafari(nav) {
  if (!nav || typeof nav.userAgent !== "string") return false;
  const ua = nav.userAgent;
  if (!/iP(hone|od|ad)/.test(ua)) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return /Safari/.test(ua);
}

/** Already added to the home screen, in either of the two ways a browser
 *  reports it: iOS Safari's own non-standard `navigator.standalone`, or the
 *  standard `display-mode: standalone` media query every other launched-
 *  from-home-screen page (and a future non-Safari browser) can answer. */
export function isStandaloneDisplay(win, nav) {
  const navStandalone = !!(nav && nav.standalone === true);
  const mediaStandalone = !!(
    win && typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches
  );
  return navStandalone || mediaStandalone;
}

/** MANAGER-ALERTS-SPEC.md: "The page detects iOS Safari and shows that one
 *  step" -- only while it is NOT already running standalone (an iPhone that
 *  already added the page has nothing left to be told). */
export function needsAddToHomeScreenHint(win, nav) {
  return isIosSafari(nav) && !isStandaloneDisplay(win, nav);
}

const OS_PATTERNS = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/iPod/, "iPod"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Macintosh/, "Mac"],
  [/Linux/, "Linux"],
];
const BROWSER_PATTERNS = [
  [/EdgiOS|Edg\//, "Edge"],
  [/CriOS|Chrome/, "Chrome"],
  [/FxiOS|Firefox/, "Firefox"],
  [/Safari/, "Safari"],
];

/** "a label derived from the user agent" -- "iPhone Safari", "Android
 *  Chrome", and so on. Never a guess dressed as a real device name: an
 *  unrecognised OS or browser reads as the generic word, not a fabricated
 *  specific one (build rule 10). */
export function deriveLabelFromUserAgent(ua) {
  const s = typeof ua === "string" ? ua : "";
  const os = OS_PATTERNS.find(([re]) => re.test(s));
  const browser = BROWSER_PATTERNS.find(([re]) => re.test(s));
  const label = `${os ? os[1] : "This device"} ${browser ? browser[1] : "browser"}`;
  return label.slice(0, MAX_LABEL_LENGTH);
}

/** The box's own VAPID public key (base64url, from GET /push/public-key) as
 *  the Uint8Array PushManager.subscribe's own `applicationServerKey` wants.
 *  Uses `atob` (a global in both the browser and modern Node, unlike
 *  `Buffer`, which no browser has) so this same function runs unchanged in
 *  the real page and in a harness. */
export function urlBase64ToUint8Array(base64Url) {
  if (typeof base64Url !== "string" || base64Url.length === 0) {
    throw new TypeError("base64Url must be a non-empty string");
  }
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A browser's own PushSubscription -> the {endpoint, keys:{p256dh,auth}}
 *  shape POST /push/subscribe (contracts/pushAlerts.ts's own
 *  checkPushSubscriptionRow, by way of agent/web-push.mjs's own
 *  validateSubscription) expects -- built fresh from `.toJSON()` rather than
 *  trusting a caller-supplied shape, so a stray `expirationTime` field on
 *  the browser's own object never reaches the wire. */
export function rawSubscriptionFrom(pushSubscription) {
  const json =
    pushSubscription && typeof pushSubscription.toJSON === "function"
      ? pushSubscription.toJSON()
      : pushSubscription;
  if (!json || typeof json.endpoint !== "string" || !json.keys) {
    throw new TypeError("not a PushSubscription-shaped object");
  }
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/** "choose all my rules, or pick rules" -- `checkedIds` empty (nothing
 *  ticked, or the "all" radio itself chosen) reads as "all", never as an
 *  empty allow-list that would silently receive nothing (checkRuleSelection,
 *  contracts/pushAlerts.ts, refuses an empty array for exactly this reason). */
export function ruleSelectionFrom(mode, checkedIds) {
  if (mode !== "pick") return "all";
  const ids = Array.from(checkedIds ?? []);
  return ids.length > 0 ? ids : "all";
}

/** The POST /push/subscribe body -- the exact shape agent/push-delivery.mjs's
 *  own route reads (`body.subscription`, `body.label`, `body.rules`). */
export function buildSubscribeBody(rawSubscription, label, rules) {
  return { subscription: rawSubscription, label: label ?? null, rules: rules ?? "all" };
}

/* ── the subscribe flow itself -- DOM-free, so a harness can drive it with a
   fake PushManager and a fake fetch, with no document at all ────────────── */

/**
 * "Get alerts on this phone" end to end: register the service worker, read
 * the box's own public key, subscribe with it, and save the raw subscription
 * server-side. Returns `{ok:true, subscription}` (the server's own
 * subscriptionView -- see agent/push-delivery.mjs) or `{ok:false, code,
 * message}` at the FIRST step that failed -- never a partial success (a
 * subscription the browser holds but the server never saved would show as
 * "on" on THIS device and never actually fire).
 *
 * `deps.win`/`deps.nav` are the secure-context and Push-API surfaces (never
 * read off a bare `window`/`navigator` global -- see this file's header
 * comment); `deps.fetchFn` is the same injected fetch every other client in
 * this codebase takes.
 */
export async function subscribeThisPhone({ win, nav, fetchFn, label, rules }) {
  if (!isSecureContextOk(win)) {
    return { ok: false, code: "insecure_context", message: SECURE_CONTEXT_MESSAGE };
  }
  if (!nav || !nav.serviceWorker || typeof nav.serviceWorker.register !== "function") {
    return { ok: false, code: "no_service_worker", message: "This browser cannot register a service worker." };
  }
  let registration;
  try {
    registration = await nav.serviceWorker.register("/sw.js");
  } catch (err) {
    return { ok: false, code: "sw_register_failed", message: (err && err.message) || "Could not install the alert service worker." };
  }
  if (!registration || !registration.pushManager || typeof registration.pushManager.subscribe !== "function") {
    return { ok: false, code: "no_push_manager", message: "This browser does not support push notifications." };
  }

  let keyRes;
  try {
    keyRes = await fetchFn("/push/public-key", { credentials: "same-origin" });
  } catch (err) {
    return { ok: false, code: "network_error", message: (err && err.message) || "Could not reach the recorder." };
  }
  if (!keyRes || !keyRes.ok) {
    return { ok: false, code: "public_key_failed", message: "Could not read this box's public key." };
  }
  const keyBody = await keyRes.json().catch(() => null);
  if (!keyBody || typeof keyBody.publicKey !== "string" || keyBody.publicKey === "") {
    return { ok: false, code: "public_key_failed", message: "The box did not return a public key." };
  }

  let pushSubscription;
  try {
    pushSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyBody.publicKey),
    });
  } catch (err) {
    return { ok: false, code: "subscribe_failed", message: (err && err.message) || "Could not turn on alerts for this device." };
  }

  let rawSubscription;
  try {
    rawSubscription = rawSubscriptionFrom(pushSubscription);
  } catch (err) {
    return { ok: false, code: "bad_subscription", message: (err && err.message) || "This browser returned an unusable subscription." };
  }

  let saveRes;
  try {
    saveRes = await fetchFn("/push/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSubscribeBody(rawSubscription, label, rules)),
    });
  } catch (err) {
    return { ok: false, code: "network_error", message: (err && err.message) || "Could not reach the recorder." };
  }
  const saveBody = await saveRes.json().catch(() => null);
  if (!saveRes.ok || !saveBody || saveBody.ok === false) {
    return {
      ok: false,
      code: (saveBody && saveBody.code) || "save_failed",
      message: (saveBody && saveBody.message) || "Could not save this subscription.",
    };
  }
  return { ok: true, subscription: saveBody.subscription };
}

/* ── DOM helpers -- never innerHTML ──────────────────────────────────────── */

function el(doc, tag, attrs, kids) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids || []) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

/* ── the whole page ──────────────────────────────────────────────────────── */

export function startAlertsPage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const win = opts.win;
  const nav = opts.nav;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const navigate = typeof opts.navigate === "function" ? opts.navigate : () => {};

  const byId = (id) => (typeof doc.getElementById === "function" ? doc.getElementById(id) : null);

  const secureNotice = byId("secureNotice");
  const iosHint = byId("iosHint");
  const subscribeBtn = byId("subscribeBtn");
  const subscribeStatus = byId("subscribeStatus");
  const ruleModeAll = byId("ruleModeAll");
  const ruleModePick = byId("ruleModePick");
  const rulePickList = byId("rulePickList");
  const testBtn = byId("testBtn");
  const testStatus = byId("testStatus");
  const deviceListEl = byId("deviceList");
  const deviceEmptyEl = byId("deviceEmpty");

  let rules = []; // [{id, name}], from GET /rules
  let devices = []; // subscriptionView rows, from GET /push/my-subscriptions

  function currentRuleSelection() {
    const mode = ruleModePick && ruleModePick.checked ? "pick" : "all";
    const checked = [];
    if (rulePickList && typeof rulePickList.querySelectorAll === "function") {
      for (const box of rulePickList.querySelectorAll("input[type=checkbox]")) {
        if (box.checked) checked.push(box.value);
      }
    }
    return ruleSelectionFrom(mode, checked);
  }

  function renderRulePicker() {
    if (!rulePickList) return;
    clearChildren(rulePickList);
    for (const r of rules) {
      const box = el(doc, "input", { type: "checkbox" });
      box.value = r.id;
      const nameEl = el(doc, "span", {});
      nameEl.textContent = r.name; // untrusted: textContent only
      rulePickList.append(el(doc, "label", { class: "row" }, [box, nameEl]));
    }
  }

  // alerts.html's own CSS toggle (`#ruleModePick:checked ~ #rulePickList`)
  // cannot fire: the two radios each sit inside their own <div class="row">,
  // so #rulePickList is never a REAL sibling of #ruleModePick and the
  // `~` selector never matches in a real browser (invisible to the JS
  // harnesses, which drive this module against a fake `document` with no
  // CSS engine at all). Set the same thing directly from the radios'
  // `change` event instead, mirroring the other `.hidden` toggles this file
  // already does (applySecureContext, applyIosHint, renderDeviceList).
  function updateRulePickerVisibility() {
    if (rulePickList) rulePickList.hidden = !(ruleModePick && ruleModePick.checked);
  }
  if (ruleModeAll) ruleModeAll.addEventListener("change", updateRulePickerVisibility);
  if (ruleModePick) ruleModePick.addEventListener("change", updateRulePickerVisibility);
  updateRulePickerVisibility();

  function renderDeviceList() {
    if (!deviceListEl) return;
    clearChildren(deviceListEl);
    if (deviceEmptyEl) deviceEmptyEl.hidden = devices.length > 0;
    for (const d of devices) {
      const nameEl = el(doc, "strong", {});
      nameEl.textContent = d.label || d.endpointHost || "This device"; // untrusted: textContent only
      const removeBtn = el(doc, "button", { type: "button", text: "Remove" });
      removeBtn.addEventListener("click", () => {
        void removeDevice(d.id);
      });
      deviceListEl.append(el(doc, "li", {}, [nameEl, removeBtn]));
    }
  }

  async function removeDevice(id) {
    try {
      const res = await fetchFn(`/push/unsubscribe/${encodeURIComponent(id)}`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok) {
        devices = devices.filter((d) => d.id !== id);
        renderDeviceList();
      }
    } catch (err) {
      log("error", "alerts page: could not remove device", { message: err && err.message });
    }
  }

  function applySecureContext() {
    const secure = isSecureContextOk(win);
    if (subscribeBtn) subscribeBtn.hidden = !secure;
    if (secureNotice) {
      secureNotice.textContent = secure ? "" : SECURE_CONTEXT_MESSAGE;
      secureNotice.hidden = secure;
    }
  }

  function applyIosHint() {
    if (!iosHint) return;
    const needed = needsAddToHomeScreenHint(win, nav);
    iosHint.textContent = needed ? IOS_ADD_TO_HOME_SCREEN_HINT : "";
    iosHint.hidden = !needed;
  }

  async function doSubscribe() {
    if (subscribeBtn) subscribeBtn.disabled = true;
    if (subscribeStatus) subscribeStatus.textContent = "Setting up…";
    const label = deriveLabelFromUserAgent(nav && nav.userAgent);
    const result = await subscribeThisPhone({ win, nav, fetchFn, label, rules: currentRuleSelection() });
    if (subscribeBtn) subscribeBtn.disabled = false;
    if (!result.ok) {
      if (subscribeStatus) subscribeStatus.textContent = result.message || "Could not turn on alerts.";
      return;
    }
    if (subscribeStatus) subscribeStatus.textContent = "Alerts are on for this device.";
    await loadDevices();
  }

  async function sendTestAlert() {
    if (testStatus) testStatus.textContent = "Sending…";
    try {
      const res = await fetchFn("/push/test", { method: "POST", credentials: "same-origin" });
      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        if (testStatus) testStatus.textContent = (data && data.message) || "Wait a moment before sending another test alert.";
        return;
      }
      if (!res.ok || !data || data.ok === false) {
        if (testStatus) testStatus.textContent = (data && data.message) || "Could not send a test alert.";
        return;
      }
      if (testStatus) testStatus.textContent = "Test alert sent.";
    } catch (err) {
      log("error", "alerts page: test alert failed", { message: err && err.message });
      if (testStatus) testStatus.textContent = "Could not reach the recorder.";
    }
  }

  if (subscribeBtn) subscribeBtn.addEventListener("click", () => { void doSubscribe(); });
  if (testBtn) testBtn.addEventListener("click", () => { void sendTestAlert(); });

  async function loadDevices() {
    try {
      const res = await fetchFn("/push/my-subscriptions", { credentials: "same-origin" });
      if (res.status === 401) {
        navigate("/login?next=%2Falerts-page");
        return;
      }
      const data = await res.json().catch(() => null);
      devices = data && Array.isArray(data.subscriptions) ? data.subscriptions : [];
      renderDeviceList();
    } catch (err) {
      log("error", "alerts page: could not load devices", { message: err && err.message });
    }
  }

  async function loadRules() {
    try {
      const res = await fetchFn("/rules", { credentials: "same-origin" });
      if (res.status === 401) {
        navigate("/login?next=%2Falerts-page");
        return;
      }
      const data = await res.json().catch(() => null);
      rules = data && Array.isArray(data.rules) ? data.rules.map((r) => ({ id: r.id, name: r.name })) : [];
      renderRulePicker();
    } catch (err) {
      log("error", "alerts page: could not load rules", { message: err && err.message });
    }
  }

  applySecureContext();
  applyIosHint();

  const ready = Promise.all([loadRules(), loadDevices()]);
  return { ready, reload: () => Promise.all([loadRules(), loadDevices()]) };
}

// Browser bootstrap. Runs only when the real page has its own container in
// the DOM; a harness importing this module for its pure helpers has no side
// effects. Copies camera-page-bootstrap-lesson: every new NVR page client
// needs this, and harness/alertsPage.harness.mjs proves it.
if (
  typeof document !== "undefined" &&
  typeof document.getElementById === "function" &&
  document.getElementById("alertsBody")
) {
  startAlertsPage({
    doc: document,
    win: window,
    nav: navigator,
    fetchFn: function (url, init) { return fetch(url, init); },
    navigate: (url) => { window.location.assign(url); },
    log: () => {},
  });
}
