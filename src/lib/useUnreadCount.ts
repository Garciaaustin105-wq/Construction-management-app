"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export function useUnreadCount() {
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  useEffect(() => {
    let active = true;
    const onDashboard = pathname === "/dashboard";

    async function fetchUnread(markSeen: boolean) {
      try {
        const url = `/api/notifications/unread${markSeen ? "?markSeen=1" : ""}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (active) setUnread(data.unread ?? 0);
      } catch {
        // ignore
      }
    }

    // Immediate fetch on navigation: when landing on Home, mark everything
    // seen in the same request so the badge clears instantly instead of
    // waiting on the 30s poll. The periodic poll never marks seen, so the
    // badge only clears when the user actually visits Home.
    fetchUnread(onDashboard);
    const interval = setInterval(() => fetchUnread(false), 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pathname]);

  return unread;
}