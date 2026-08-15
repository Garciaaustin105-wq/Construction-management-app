"use client";

import { useEffect, useState } from "react";

// SSR-safe "is the viewport at least lg (1024px)?" hook. Returns false on the
// server and on the first client render, then re-syncs after mount so there is
// no hydration mismatch. Used to gate the unread-notifications poll so only the
// chrome that is actually visible (Sidebar on desktop, BottomNav on mobile)
// polls - both stay mounted via CSS hidden/lg:flex, so without this guard both
// would poll.
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}