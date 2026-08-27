"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useUnreadCount } from "@/lib/useUnreadCount";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { buildMobileNav, isPublicRoute, type NavItem } from "@/lib/navItems";
import { isOfficeLike } from "@/lib/roles";
import { useRole } from "@/lib/useRole";

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const role = useRole();
  const [hidden, setHidden] = useState(false);
  const isDesktop = useIsDesktop();
  // Only poll on mobile (desktop uses the Sidebar's poller). Both chrome
  // pieces stay mounted via CSS, so this guard keeps it to one poller.
  const unread = useUnreadCount(!isDesktop);

  // Auto-hide on scroll down, reveal on scroll up (Facebook-style).
  useEffect(() => {
    let lastY = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      if (y <= 8) {
        setHidden(false);
      } else if (y > lastY + 4) {
        setHidden(true);
      } else if (y < lastY - 4) {
        setHidden(false);
      }
      lastY = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const items = buildMobileNav(role);
  // Hub roles (office/admin) put Sign Out inside the Manage hub page, so the
  // bar shows only the hub cells. Flat roles keep the trailing Sign Out button.
  // super_admin's mobile nav is a FLAT platform-only bar (Home/Users/Platform/
  // Dev) — it has no Manage hub, so it must get the trailing Sign Out cell too,
  // otherwise it has no way to sign out on mobile.
  const showSignOutCell =
    role !== null && (role === "super_admin" || !isOfficeLike(role));

  // The bottom nav is persistent (rendered from the root layout) but should
  // not appear on public/portal routes that have their own chrome.
  if (isPublicRoute(pathname)) return null;

  return (
    <nav
      className={`fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 transition-transform duration-200 lg:hidden ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
    >
      <div className="max-w-md mx-auto flex">
        {items.map(({ href, label, Icon, badge, aliases }: NavItem) => {
          const active =
            pathname === href ||
            (aliases?.some(
              (a) => pathname === a || pathname.startsWith(a + "/"),
            ) ??
              false);
          const showBadge = badge === "unread" && unread > 0;
          return (
            <Link
              key={href}
              href={href}
              // prefetch OFF — same reason as Sidebar.tsx (see the note there).
              // This bar is mounted on every authed page too, and on mobile the
              // prefetch storm is worse: cell latency and a device that has to
              // parse every prefetched payload.
              prefetch={false}
              className={`flex-1 flex flex-col items-center justify-center py-3 text-xs relative ${
                active ? "text-brand" : "text-gray-600"
              }`}
            >
              <Icon
                className={`w-6 h-6 mb-0.5 ${active ? "stroke-[2.5]" : ""}`}
                strokeWidth={active ? 2.5 : 2}
              />
              <span className={active ? "font-semibold" : ""}>{label}</span>
              {showBadge && (
                <span className="absolute top-1 right-3 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Link>
          );
        })}
        {showSignOutCell && (
          <button
            onClick={handleSignOut}
            className="flex-1 flex flex-col items-center justify-center py-3 text-xs text-gray-600"
          >
            <LogOut className="w-6 h-6 mb-0.5" />
            <span>Sign Out</span>
          </button>
        )}
      </div>
    </nav>
  );
}