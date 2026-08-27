// Terra Vista service worker.
// Two jobs: (1) make the app installable (Add to Home Screen) and (2) cache the
// app shell so it loads even with a flaky cell signal. Live data (Supabase REST,
// storage, our /api routes) is NEVER cached — only HTML navigations and static
// assets (JS/CSS/images/fonts/icons) are. So offline you get the last-rendered
// page shell + whatever was in memory, but fresh data still needs a connection.
//
// Bumping CACHE below purges the previous cache on activate. Do this whenever a
// precached asset (icon, manifest, logo) OR the app-shell JS/CSS changes — the
// nav, layout, and components live in the cached bundle, so a nav restructure
// (e.g. the mobile section-hubs) needs a bump too or installed clients keep
// showing the old tab bar. No reinstall needed — the new SW purges on activate.
const CACHE = "terra-vista-v7";
// How long a page navigation waits on the network before falling back to the
// cached shell. Long enough that a merely-sluggish connection still gets fresh
// HTML, short enough that nobody watches a blank screen. NOT a bump-worthy
// change: no precached asset or shell bundle changed, and the browser
// byte-compares this file to pick up new worker logic on its own. Deliberately
// keeping CACHE means users keep the shells they already have — which is the
// thing that makes the fallback below useful. Stale entries from the old
// cache-anything behaviour self-heal on the next successful navigation, since
// the handler now overwrites on every 2xx.
const NAV_TIMEOUT_MS = 3000;
// Only precache public, auth-free assets. /dashboard etc. get cached on first
// visit via the navigation handler (they require a session, so precaching them
// at install time would store a login redirect).
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/terra-vista-icon.svg",
  "/terra-verde-icon.svg",
  "/apple-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/terra-verde-apple-icon.png",
  "/terra-verde-icon-192.png",
  "/terra-verde-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Don't intercept cross-origin (Supabase REST/storage) or our own API — live
  // data must always go to the network.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Page navigations: network-first (fresh HTML when online), fall back to the
  // cached shell so the app still opens on a bad connection.
  //
  // TIMEOUT, not just try/catch. The old version awaited fetch() bare, so the
  // fallback only fired when fetch REJECTED — i.e. only when fully offline. On a
  // slow-but-alive connection (flaky cell, captive portal, a degraded upstream)
  // the fetch just hangs, and the browser's own navigation timeout is tens of
  // seconds. The user sat on a blank page with a perfectly good shell already in
  // the cache. Since "loads even with a flaky cell signal" is this worker's
  // entire reason to exist, slow has to count as a failure, not just dead.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        // Kick the network off first and keep the handle: even when we stop
        // WAITING on it, we still want it to finish and refresh the cache.
        const network = fetch(req).then(async (res) => {
          // Only cache successes. The old code cached the response
          // unconditionally, so a 500 or an error page became the thing served
          // on the next offline visit.
          if (res.ok) {
            const c = await caches.open(CACHE);
            c.put(req, res.clone());
          }
          return res;
        });

        const cached = (await caches.match(req)) || (await caches.match("/"));

        // Nothing cached to fall back to — a timeout would buy the user nothing,
        // so wait it out and only handle a hard failure.
        if (!cached) {
          try {
            return await network;
          } catch {
            return new Response(
              "You're offline and this page isn't cached yet. Reconnect to load the app.",
              { status: 503, headers: { "Content-Type": "text/plain" } }
            );
          }
        }

        // We have a shell. Give the network a bounded window, then serve it.
        const TIMED_OUT = Symbol("timeout");
        try {
          const winner = await Promise.race([
            network,
            new Promise((resolve) =>
              setTimeout(() => resolve(TIMED_OUT), NAV_TIMEOUT_MS)
            ),
          ]);
          if (winner !== TIMED_OUT) return winner;
          // Too slow: serve the shell now and let the request finish in the
          // background so the NEXT navigation gets the fresh HTML. waitUntil
          // keeps the worker alive for it; .catch keeps a late failure from
          // surfacing as an unhandled rejection.
          event.waitUntil(network.catch(() => {}));
          return cached;
        } catch {
          // Hard failure inside the window — the shell is the best answer.
          return cached;
        }
      })()
    );
    return;
  }

  // Hashed build bundles under /_next/static/ are immutable — cache-first is
  // safe forever and avoids re-downloading on every visit.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) {
            const copy = res.clone();
            const c = await caches.open(CACHE);
            c.put(req, copy);
          }
          return res;
        } catch {
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Everything else static (icons, manifest, logo, other public assets) is NOT
  // immutable — it can change on deploy. Stale-while-revalidate: serve the
  // cached copy instantly for speed, but fetch in the background and update the
  // cache so the NEXT visit reflects the new asset. This is what lets an icon or
  // logo update show up without uninstalling/reinstalling the app.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || Response.error());
      // Serve cached immediately if we have it; otherwise wait for the network.
      return cached || network;
    })()
  );
});