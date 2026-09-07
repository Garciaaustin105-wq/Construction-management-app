"use client";

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, LogOut, UserCog } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useUnreadCount } from "@/lib/useUnreadCount";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { BRAND } from "@/lib/brand";
import {
  buildNavItems,
  isPublicRoute,
  NAV_SECTIONS,
  type NavItem,
  type NavSection,
} from "@/lib/navItems";
import { useOrgBranding } from "@/lib/useOrgBranding";
import { useRole } from "@/lib/useRole";
import OrgLogo from "@/components/OrgLogo";

// Desktop primary navigation. Persistent fixed-left sidebar, visible only at
// lg+ (the mobile BottomNav takes over below that). Shares the nav item source
// of truth with BottomNav (buildNavItems) so the two never diverge. Only this
// component polls the unread count on desktop (BottomNav polls on mobile);
// both stay mounted via CSS, so the useIsDesktop guard is what keeps it to one
// poller - see useUnreadCount's `enabled` param.
//
// GROUPED, because the lawn office nav reached thirty-odd flat rows and the two
// things that office opens first - Overdue and Approvals - sat at positions
// nineteen and twenty. Nothing was removed to fix that: the rows are the same
// rows, in named groups. Navs that set no section (crew, PM, sales, accountant)
// render exactly the flat list they always did.

// Which groups the viewer has collapsed. Per-browser, not per-org: it is a
// display preference, and storing it server-side would make one person's tidy
// sidebar everyone else's.
const COLLAPSE_KEY = "tv-sidebar-groups";

// localStorage is an external store, so it is read through useSyncExternalStore
// rather than copied into state by an effect. That gives the server its own
// snapshot ("nothing collapsed"), which is what keeps the first client render
// identical to the server's, and it picks up a change made in another tab.
//
// Every access is wrapped: a private window, cleared site data, or a browser
// set to block storage all THROW here rather than returning empty.
const collapseListeners = new Set<() => void>();

function subscribeCollapsed(onChange: () => void): () => void {
  collapseListeners.add(onChange);
  // Fired by other tabs; our own writes notify directly, since `storage` does
  // not fire in the tab that wrote.
  window.addEventListener("storage", onChange);
  return () => {
    collapseListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

// Returns the RAW string, not a parsed object: useSyncExternalStore compares
// snapshots by identity, and a fresh object every call would loop forever.
function collapsedSnapshot(): string {
  try {
    return localStorage.getItem(COLLAPSE_KEY) || "{}";
  } catch {
    return "{}";
  }
}

const EMPTY_COLLAPSED = "{}";

function writeCollapsed(next: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
  } catch {
    // A viewer who cannot persist still gets the toggle for this session.
  }
  for (const listener of collapseListeners) listener();
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const role = useRole();
  const isDesktop = useIsDesktop();
  const unread = useUnreadCount(isDesktop);
  const branding = useOrgBranding();
  const collapsedJson = useSyncExternalStore(
    subscribeCollapsed,
    collapsedSnapshot,
    // The server has no localStorage and must not guess: nothing collapsed.
    () => EMPTY_COLLAPSED,
  );
  const collapsed = useMemo<Record<string, boolean>>(() => {
    try {
      return JSON.parse(collapsedJson) as Record<string, boolean>;
    } catch {
      // Someone else's key, or a half-written value. Show everything rather
      // than hiding rows because a string would not parse.
      return {};
    }
  }, [collapsedJson]);

  // No chrome on public/portal routes - the sidebar would leave an empty gap.
  if (isPublicRoute(pathname)) return null;

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function toggleSection(id: NavSection) {
    writeCollapsed({ ...collapsed, [id]: !collapsed[id] });
  }

  const items = buildNavItems(role);
  // Derived from the nav itself rather than a second role list, so the two can
  // never disagree about who already has an Account entry.
  const hasAccountInNav = items.some((i) => i.href === "/manage");
  const hrefs = items.map((i) => i.href);

  // A row is active on an exact match, or on a path-prefix match ONLY when no
  // other row sits closer to the current path. Without the "longest prefix
  // wins" guard, a parent href like /lawn (Home) would also highlight on
  // /lawn/jobs (Jobs) - both rows lit at once. BottomNav avoids this via
  // explicit hub aliases; this nav needs the guard since one href can be a
  // prefix of another.
  function isActive(href: string): boolean {
    const prefixMatch = pathname.startsWith(`${href}/`);
    const longerMatchExists = hrefs.some(
      (other) =>
        other !== href &&
        other.startsWith(`${href}/`) &&
        (pathname === other || pathname.startsWith(`${other}/`)),
    );
    return pathname === href || (prefixMatch && !longerMatchExists);
  }

  // Rows with no section render above the groups. Today that is Home alone.
  const ungrouped = items.filter((i) => !i.section);
  const grouped = NAV_SECTIONS.map((section) => ({
    ...section,
    rows: items.filter((i) => i.section === section.id),
  })).filter((g) => g.rows.length > 0);

  function renderRow({ href, label, Icon, badge }: NavItem) {
    const active = isActive(href);
    const showBadge = badge === "unread" && unread > 0;
    return (
      <Link
        key={href}
        href={href}
        // prefetch OFF. This sidebar is mounted on every authed page and
        // renders one Link per role-visible nav item, so Next prefetched
        // EVERY section on EVERY page view — each one a full server render
        // of a dynamic, cookie-reading page.
        //
        // Vercel logs, 6h window: /dashboard 98 renders, and riding along
        // with it /admin/insights 89, /admin/users 87, /change-orders 87,
        // /crew/photo 86, /admin/email-preview 84, /daily-logs 83. Nobody
        // opened email-preview 84 times — those are all prefetches, and
        // they track the dashboard count almost exactly.
        //
        // So one navigation cost ~13 extra renders, each paying its own
        // proxy getUser() round trip and running its own queries
        // (/admin/insights pulls 13 months of invoices). On Hobby-plan
        // concurrency they queue behind each other, which is where the
        // 10s page loads came from.
        //
        // Little is lost: these are authed, force-dynamic pages, so a
        // prefetched payload is stale by the time it's clicked anyway.
        prefetch={false}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
          active
            ? "bg-brand-bg text-brand-dark font-semibold"
            : "text-gray-700 hover:bg-gray-100"
        }`}
      >
        <Icon className="w-5 h-5 shrink-0" strokeWidth={active ? 2.5 : 2} />
        <span className="truncate">{label}</span>
        {showBadge && (
          <span className="ml-auto bg-red-600 text-white text-[10px] font-bold rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Link>
    );
  }

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
        {ungrouped.map(renderRow)}

        {grouped.map((group) => {
          // A collapsed group holding the page you are ON would hide the active
          // row, leaving the sidebar showing nothing selected. It opens
          // regardless of the stored preference, and the preference itself is
          // left alone so it applies again once you navigate away.
          const holdsActive = group.rows.some((r) => isActive(r.href));
          const open = !collapsed[group.id] || holdsActive;
          return (
            <div key={group.id} className="pt-3 first:pt-0">
              <button
                onClick={() => toggleSection(group.id)}
                aria-expanded={open}
                className="w-full flex items-center gap-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600"
              >
                <span className="truncate">{group.label}</span>
                <ChevronDown
                  className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${
                    open ? "" : "-rotate-90"
                  }`}
                />
              </button>
              {open && (
                <div className="space-y-1">{group.rows.map(renderRow)}</div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Sign-out pinned to the bottom, with Account beside it ONLY for roles
          that have no Account entry in the nav above.
          Office-like roles get "Account" in the nav (-> /manage, which now
          inlines the personal security settings), so showing this link too put
          TWO items labelled "Account" in the same sidebar pointing at different
          pages. Crew, superintendent and accountant have no nav entry for it,
          so for them this is still the only way in. */}
      <div className="border-t border-gray-200 p-3 shrink-0 space-y-1">
        {!hasAccountInNav && (
          <Link
            href="/account"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-700 hover:bg-gray-100"
          >
            <UserCog className="w-5 h-5" />
            <span>Account</span>
          </Link>
        )}
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
