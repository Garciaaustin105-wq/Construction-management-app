"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

// `enabled` gates whether the poll runs. The desktop Sidebar and mobile
// BottomNav both stay mounted (CSS hidden/lg:flex does not unmount them), so
// without a guard both would poll /api/notifications/unread every 30s. Sidebar
// passes isDesktop; BottomNav passes !isDesktop, so exactly one polls at any
// viewport. Defaults to true for any other call site.
export function useUnreadCount(enabled = true) {
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  // `pathname` used to be a dependency of the polling effect, so EVERY
  // navigation tore the interval down and fired an immediate refetch. Combined
  // with the 30s poll that made /api/notifications/unread the single busiest
  // path in the app — ~3 calls per page view, against a route that fans out
  // across the user's jobs. Split in two: the poll below is keyed on `enabled`
  // only, so it survives navigation and ticks at a steady 30s.
  useEffect(() => {
    if (!enabled) return;
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/notifications/unread");
        if (!res.ok) return;
        const data = await res.json();
        if (active) setUnread(data.unread ?? 0);
      } catch {
        // ignore
      }
    }

    poll();
    const interval = setInterval(poll, 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [enabled]);

  // Landing on Home marks everything seen in the same request so the badge
  // clears instantly rather than waiting on the next poll tick. This is the one
  // case that genuinely needs to fire on navigation — and only for /dashboard,
  // not for every route. The periodic poll never marks seen, so the badge still
  // only clears when the user actually visits Home.
  useEffect(() => {
    if (!enabled || pathname !== "/dashboard") return;
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/notifications/unread?markSeen=1");
        if (!res.ok) return;
        const data = await res.json();
        if (active) setUnread(data.unread ?? 0);
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname, enabled]);

  return unread;
}