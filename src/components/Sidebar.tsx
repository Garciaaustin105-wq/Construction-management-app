"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useUnreadCount } from "@/lib/useUnreadCount";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { BRAND } from "@/lib/brand";
import { buildNavItems, isPublicRoute, type NavItem } from "@/lib/navItems";
import { useOrgBranding } from "@/lib/useOrgBranding";
import { useRole } from "@/lib/useRole";
import OrgLogo from "@/components/OrgLogo";

// Desktop primary navigation. Persistent fixed-left sidebar, visible only at
// lg+ (the mobile BottomNav takes over below that). Shares the nav item source
// of truth with BottomNav (buildNavItems) so the two never diverge. Only this
// component polls the unread count on desktop (BottomNav polls on mobile);
// both stay mounted via CSS, so the useIsDesktop guard is what keeps it to one
// poller - see useUnreadCount's `enabled` param.
export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const role = useRole();
  const isDesktop = useIsDesktop();
  const unread = useUnreadCount(isDesktop);
  const branding = useOrgBranding();

  // No chrome on public/portal routes - the sidebar would leave an empty gap.
  if (isPublicRoute(pathname)) return null;

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const items = buildNavItems(role);

  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 w-64 bg-white border-r border-gray-200 z-30 flex-col">
      {/* Brand header - sits under the sticky per-page TopBar (z-40 > z-30). */}
      <div className="h-14 flex items-center gap-2 px-4 border-b border-gray-200 shrink-0">
        <OrgLogo
          logoUrl={branding.logoUrl}
          alt={branding.orgName ?? BRAND.shortName}
          size={28}
        />
        <span className="font-bold text-gray-900 truncate">
          {branding.logoUrl ? branding.orgName ?? BRAND.shortName : BRAND.shortName}
        </span>
      </div>

      {/* Nav items - flex-1 so the sign-out row pins to the bottom. */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {items.map(({ href, label, Icon, badge }: NavItem) => {
          // startsWith so a sub-page keeps its section highlighted (natural for
          // a persistent sidebar). BottomNav keeps exact match on mobile.
          const active =
            pathname === href || pathname.startsWith(href + "/");
          const showBadge = badge === "unread" && unread > 0;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                active
                  ? "bg-brand-bg text-brand-dark font-semibold"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              <Icon
                className="w-5 h-5 shrink-0"
                strokeWidth={active ? 2.5 : 2}
              />
              <span className="truncate">{label}</span>
              {showBadge && (
                <span className="ml-auto bg-red-600 text-white text-[10px] font-bold rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Sign-out pinned to the bottom, separated from nav. */}
      <div className="border-t border-gray-200 p-3 shrink-0">
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-700 hover:bg-gray-100"
        >
          <LogOut className="w-5 h-5" />
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  );
}