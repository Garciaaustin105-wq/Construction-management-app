/**
 * agent/ui/sw.js: the Alerts page's service worker (MANAGER-ALERTS-SPEC.md
 * "A service worker") -- run without a browser, by loading its real source
 * text into a fake `self` (a classic, non-module script, so this is a plain
 * `new Function("self", src)` load, not an ESM import).
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/sw.harness.mjs`.
 *
 * THE FEARED FAILURE, twice over (this file's own header comment):
 *  - a push payload showing up as a notification with the WRONG title/body
 *    (or none at all when the payload fails to parse as JSON);
 *  - notificationclick opening a URL an attacker-controlled push payload
 *    named, off this box's own origin -- checked here against a same-origin
 *    path, a scheme-relative URL, a full off-origin URL, and a value that
 *    does not parse as a URL at all.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { check, eq, report } from "./_assert.mjs";

const root = process.cwd();
const src = await readFile(join(root, "agent/ui/sw.js"), "utf8");

console.log("service worker (sw.js)");

check("REQUIRED: sw.js is a classic script -- no import/export -- since a service worker's own scope is not the page that registered it", () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq(/^\s*import\s/m.test(code), false, "no top-level import");
  eq(/^\s*export\s/m.test(code), false, "no top-level export");
});

/**
 * A minimal fake `self`: enough of the ServiceWorkerGlobalScope surface for
 * this file's own two listeners to run against. `showNotification` and
 * `clients.matchAll`/`openWindow` just record what they were called with,
 * so this test file — like agent/ui/alerts-client.mjs's own harness — never
 * needs a real browser, a real push service or a real notification.
 */
function makeFakeSelf({ clientsList = [] } = {}) {
  const calls = { showNotification: [], focus: [], navigate: [], openWindow: [] };
  const listeners = {};
  const self = {
    location: { origin: "https://box.example" },
    addEventListener(type, fn) { listeners[type] = fn; },
    registration: {
      showNotification: async (title, options) => { calls.showNotification.push({ title, options }); },
    },
    clients: {
      matchAll: async () => clientsList.map((c) => ({
        focus: async () => { calls.focus.push(c.id); },
        navigate: async (path) => { calls.navigate.push({ id: c.id, path }); },
      })),
      openWindow: async (path) => { calls.openWindow.push(path); },
    },
  };
  // eslint-disable-next-line no-new-func -- loading a real, non-module classic
  // script's source text is exactly what registering it as a service worker
  // does; this is the harness equivalent of that load, not eval of arbitrary
  // input (the source is this repo's own file, read above).
  new Function("self", "URL", src)(self, URL);
  return { self, listeners, calls };
}

async function fireEvent(listeners, type, ev) {
  const fn = listeners[type];
  if (typeof fn !== "function") throw new Error(`sw.js never registered a "${type}" listener`);
  const waited = [];
  const event = { ...ev, waitUntil: (p) => waited.push(p) };
  fn(event);
  await Promise.all(waited);
  return event;
}

/* ── push: shows title and body ──────────────────────────────────────────── */

await check("REQUIRED: a push event with a JSON payload shows a notification with that title and body", async () => {
  const { listeners, calls } = makeFakeSelf();
  await fireEvent(listeners, "push", {
    data: { json: () => ({ title: "Manager's desk unattended", body: "2:10-2:55 (45 min)", url: "/review?camera=cam-1&at=2026-09-27T02:10:00.000Z" }) },
  });
  eq(calls.showNotification.length, 1);
  eq(calls.showNotification[0].title, "Manager's desk unattended");
  eq(calls.showNotification[0].options.body, "2:10-2:55 (45 min)");
  eq(calls.showNotification[0].options.data.url, "/review?camera=cam-1&at=2026-09-27T02:10:00.000Z");
});

await check("a push event with no data at all, or data that is not JSON, still shows a notification -- never throws, never drops it silently", async () => {
  const { listeners, calls } = makeFakeSelf();
  await fireEvent(listeners, "push", { data: null });
  eq(calls.showNotification.length, 1, "still shown, with the generic title");
  eq(calls.showNotification[0].title, "Alert");

  const { listeners: listeners2, calls: calls2 } = makeFakeSelf();
  await fireEvent(listeners2, "push", { data: { json: () => { throw new Error("not json"); } } });
  eq(calls2.showNotification.length, 1);
  eq(calls2.showNotification[0].title, "Alert");
});

/* ── notificationclick: opens `url`, but only ever same-origin ───────────── */

await check("REQUIRED: notificationclick with a same-origin url focuses/navigates an open window to it", async () => {
  const { listeners, calls } = makeFakeSelf({ clientsList: [{ id: "win-1" }] });
  await fireEvent(listeners, "notificationclick", {
    notification: { close: () => {}, data: { url: "/review?camera=cam-1&at=2026-09-27T02:10:00.000Z" } },
  });
  eq(calls.focus, ["win-1"]);
  eq(calls.navigate, [{ id: "win-1", path: "/review?camera=cam-1&at=2026-09-27T02:10:00.000Z" }]);
  eq(calls.openWindow.length, 0, "an open window was reused, never a second one opened");
});

await check("notificationclick opens a NEW window at the url when nothing is open", async () => {
  const { listeners, calls } = makeFakeSelf({ clientsList: [] });
  await fireEvent(listeners, "notificationclick", { notification: { close: () => {}, data: { url: "/reports?day=2026-09-27" } } });
  eq(calls.openWindow, ["/reports?day=2026-09-27"]);
});

await check("REQUIRED, THE FEARED ONE: notificationclick REFUSES an off-origin url -- a full off-origin URL, a scheme-relative one, and an unparseable value all clamp to \"/\"", async () => {
  for (const badUrl of [
    "https://evil.example/steal",
    "//evil.example/steal",
    "http://box.example.evil.example/x", // looks like this origin as a PREFIX, but is a different host entirely
    "https://box.example:8443/x", // a different PORT is a different origin too, even with the identical host
  ]) {
    const { listeners, calls } = makeFakeSelf({ clientsList: [{ id: "win-1" }] });
    await fireEvent(listeners, "notificationclick", { notification: { close: () => {}, data: { url: badUrl } } });
    eq(calls.navigate, [{ id: "win-1", path: "/" }], `REQUIRED: "${badUrl}" must never be opened -- clamped to "/" instead`);
  }
});

await check("a same-origin url that is only a path (no scheme/host at all) is opened exactly as given", async () => {
  const { listeners, calls } = makeFakeSelf({ clientsList: [{ id: "win-1" }] });
  await fireEvent(listeners, "notificationclick", { notification: { close: () => {}, data: { url: "/" } } });
  eq(calls.navigate, [{ id: "win-1", path: "/" }]);
});

await check("no data.url at all defaults to \"/\", never throws", async () => {
  const { listeners, calls } = makeFakeSelf({ clientsList: [{ id: "win-1" }] });
  await fireEvent(listeners, "notificationclick", { notification: { close: () => {}, data: {} } });
  eq(calls.navigate, [{ id: "win-1", path: "/" }]);
});

await check("the notification is always closed, whether the url was good or refused", async () => {
  let closed = false;
  const { listeners } = makeFakeSelf({ clientsList: [] });
  await fireEvent(listeners, "notificationclick", { notification: { close: () => { closed = true; }, data: { url: "https://evil.example/x" } } });
  eq(closed, true);
});

report("service worker (sw.js)");
