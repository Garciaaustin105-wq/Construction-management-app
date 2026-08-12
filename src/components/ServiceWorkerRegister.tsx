"use client";

import { useEffect } from "react";

// Registers the Terra Vista service worker (/public/sw.js) so the app is
// installable (Add to Home Screen) and loads its shell offline. The SW only
// caches HTML navigations + static assets — live Supabase/API data is never
// cached (see sw.js). Registered from Providers so it runs once for the whole
// app, after first paint. Skipped in dev to avoid caching stale hot-reload
// bundles; enabled in production builds.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => console.warn("SW registration failed:", err));
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}