// Terra Vista service worker.
// Two jobs: (1) make the app installable (Add to Home Screen) and (2) cache the
// app shell so it loads even with a flaky cell signal. Live data (Supabase REST,
// storage, our /api routes) is NEVER cached — only HTML navigations and static
// assets (JS/CSS/images/fonts/icons) are. So offline you get the last-rendered
// page shell + whatever was in memory, but fresh data still needs a connection.
//
// Bumping CACHE below purges the previous cache on activate. Do this whenever a
// precached asset (icon, manifest, logo) changes so installed clients drop the
// stale copy and pick up the new one on the next visit — no reinstall needed.
const CACHE = "terra-vista-v3";
// Only precache public, auth-free assets. /dashboard etc. get cached on first
// visit via the navigation handler (they require a session, so precaching them
// at install time would store a login redirect).
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/icon.svg",
  "/terra-vista-icon.svg",
  "/apple-icon.png",
  "/icon-192.png",
  "/icon-512.png",
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
  // cached shell when offline so the app still opens.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const copy = res.clone();
          const c = await caches.open(CACHE);
          c.put(req, copy);
          return res;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          const shell = await caches.match("/");
          if (shell) return shell;
          return new Response(
            "You're offline and this page isn't cached yet. Reconnect to load Terra Vista.",
            { status: 503, headers: { "Content-Type": "text/plain" } }
          );
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