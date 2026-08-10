"use client";

import { useEffect, useState } from "react";

export function useUnreadCount() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let active = true;

    async function fetchUnread() {
      try {
        const res = await fetch("/api/notifications/unread");
        if (!res.ok) return;
        const data = await res.json();
        if (active) setUnread(data.unread ?? 0);
      } catch {
        // ignore
      }
    }

    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return unread;
}