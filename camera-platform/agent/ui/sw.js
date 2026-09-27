// agent/ui/sw.js -- served at root scope as "/sw.js" (MANAGER-ALERTS-SPEC.md
// "A service worker"). Public (contracts/routeAccess.ts: { kind: "public" }):
// it holds no secrets, and a push or notificationclick event fires with no
// session attached at all -- the BROWSER wakes this worker, not a signed-in
// tab, so gating it behind a permission would make every notification after
// a session expired fail to even load the code that shows it.
//
// A classic (non-module) worker script on purpose: registered with
// navigator.serviceWorker.register("/sw.js") and no `{ type: "module" }`
// option, so this file uses `self.addEventListener`, never `import`/`export`
// -- the one file in agent/ui/ that is NOT loaded as an ES module, because a
// service worker's own scope is a different global than the page that
// registered it.
//
// THE ONE RULE this file exists to keep, twice over (MANAGER-ALERTS-SPEC.md
// "A service worker": "opens `url` when tapped" -- and this codebase's own
// wider rule against following a link supplied by data rather than typed by
// a person): a notification's own `data.url`, which travelled inside an
// ENCRYPTED push payload this box itself built (agent/push-delivery.mjs's
// buildPushPayload, always a same-origin "/review?..." or "/reports?...")
// but which nothing on the wire between the push service and this worker can
// be trusted to have left untouched, is resolved against this worker's own
// origin and clamped BACK to "/" the instant it resolves to any other
// origin -- never opened, whatever it says.

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = {}; // not JSON: shown as a bare, title-only notification below, never thrown away silently
    }
  }
  const title = typeof data.title === "string" && data.title !== "" ? data.title : "Alert";
  const body = typeof data.body === "string" ? data.body : "";
  const url = typeof data.url === "string" && data.url !== "" ? data.url : "/";
  event.waitUntil(self.registration.showNotification(title, { body, data: { url } }));
});

/** The notification's own `data.url`, resolved against this worker's own
 *  origin and clamped to "/" for anything else -- a scheme-relative URL
 *  ("//evil.example/x"), a full off-origin URL, or a value that does not
 *  parse as a URL at all are all the same case here: never opened. */
function sameOriginPathOrRoot(url) {
  // A blank/absent url (a payload with no url field at all -- build rule 5:
  // a blank is not a zero) must never fall through to `new URL(undefined,
  // origin)`, which coerces to the STRING "undefined" and resolves as the
  // relative path "/undefined": same-origin, technically, but a real path
  // nothing on this box ever serves, not the "/" this function means by "no
  // url at all".
  if (typeof url !== "string" || url === "") return "/";
  let target;
  try {
    target = new URL(url, self.location.origin);
  } catch {
    return "/";
  }
  if (target.origin !== self.location.origin) return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = sameOriginPathOrRoot(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of openClients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(path);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(path);
    })(),
  );
});
