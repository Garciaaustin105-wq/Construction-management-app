// Single source of truth for the app's primary navigation, consumed by both
// the desktop Sidebar and the mobile BottomNav so the two can never drift apart.
//
// `buildNavItems` is a deliberate 1:1 port of the BottomNav's original
// imperative item-building logic (it was inlined there before this module
// existed). The office block checks `role === "office" || "admin" ||
// "super_admin"` on purpose - NOT the `isOfficeLike` helper - so project_manager
// keeps getting ONLY the 3 base tabs. That matches the pre-Phase-1 behavior
// exactly (PM is in OFFICE_OR_PM but the old bottom nav never admitted it).
// Whether PM should get more tabs is a product decision, not a layout one, so
// it is intentionally left as-is here. See the desktop-layout plan's
// "PM discrepancy" note.
//
// `buildMobileNav` is the MOBILE bar: office/admin/super_admin collapse into
// 5 section hubs (Home/Field/Lawn/Office/Manage) instead of the flat 7-8 cell
// row. Crew/superintendent/PM keep a flat bar (not crowded). The desktop
// Sidebar still uses buildNavItems (flat, expanded - it has room). Hub
// `aliases` drive the mobile active-state (prefix match) and are ignored by
// the Sidebar.

import {
  Home,
  Camera,
  Clock,
  Receipt,
  Sprout,
  Users,
  Building,
  CreditCard,
  HardHat,
  ClipboardList,
  CheckSquare,
  FileDiff,
  FileText,
  Settings,
  Contact,
  Calendar,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@/lib/roles";
import { isLawn } from "@/lib/variant";

export type NavItem = {
  href: string;
  label: string;
  Icon: LucideIcon;
  // "unread" => the consuming chrome renders the unread-notifications count
  // on this row (Home only).
  badge?: "unread";
  // Hub active-state prefixes (mobile only; ignored by the desktop Sidebar).
  // A row is active when pathname === href OR any alias matches exactly or as
  // a path prefix (pathname === alias || pathname.startsWith(alias + "/")).
  aliases?: string[];
};

export function buildNavItems(role: Role | string | null): NavItem[] {
  // Lawn variant: lawn-only desktop sidebar — no construction GC-pro surfaces
  // (receipts/daily-logs/punch/change-orders/submittals all dropped). Crew keep
  // their flat route tab; PM keeps the base 3.
  if (isLawn()) {
    const base: NavItem[] = [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Time", Icon: Clock },
    ];
    if (role === "crew" || role === "superintendent") {
      return [...base, { href: "/lawn/my-route", label: "Route", Icon: Sprout }];
    }
    if (role === "project_manager") {
      return base;
    }
    // office / admin / super_admin — in the lawn app /lawn IS the home
    // dashboard (the lawn office landing page), so Home points there directly
    // and there is no separate "Lawn" tab (it would just duplicate Home).
    // /dashboard still redirects to /lawn as a safety net for typed/old links.
    const items: NavItem[] = [
      { href: "/lawn", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Time", Icon: Clock },
      { href: "/admin/customers", label: "Customers", Icon: Contact },
      { href: "/estimates", label: "Estimates", Icon: FileText },
      { href: "/invoices", label: "Invoices", Icon: Receipt },
      { href: "/calendar", label: "Calendar", Icon: Calendar },
      { href: "/admin/users", label: "Admin", Icon: Users },
    ];
    if (role === "admin") {
      items.push({ href: "/admin/billing", label: "Billing", Icon: CreditCard });
    }
    if (role === "super_admin") {
      items.push({ href: "/admin/orgs", label: "Platform", Icon: Building });
    }
    return items;
  }

  // Construction variant (unchanged): full GC + lawn nav.
  const items: NavItem[] = [
    { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
    { href: "/crew/photo", label: "Photos", Icon: Camera },
    { href: "/crew/time", label: "Time", Icon: Clock },
  ];
  if (role === "office" || role === "admin" || role === "super_admin") {
    items.push(
      { href: "/receipts", label: "Receipts", Icon: Receipt },
      { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
      { href: "/punch", label: "Punch List", Icon: CheckSquare },
      { href: "/change-orders", label: "Change Orders", Icon: FileDiff },
      { href: "/submittals", label: "Submittals", Icon: FileText },
      { href: "/admin/users", label: "Admin", Icon: Users },
    );
  }
  // Only the org admin manages billing (checkout + Customer Portal routes are
  // admin-only). office/super_admin don't get the tab.
  if (role === "admin") {
    items.push({ href: "/admin/billing", label: "Billing", Icon: CreditCard });
  }
  if (role === "super_admin") {
    items.push({ href: "/admin/orgs", label: "Platform", Icon: Building });
  }
  return items;
}

// Mobile bottom-nav items. Office/admin/super_admin collapse the flat 7-8 cell
// row into 5 section hubs; crew/superintendent/PM keep a flat bar. Sign Out
// for hub roles lives in the Manage hub page (not the bar), so it is NOT an
// item here. See plan: mobile bottom-nav cleanup.
export function buildMobileNav(role: Role | string | null): NavItem[] {
  const base: NavItem[] = [
    { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
    { href: "/crew/photo", label: "Photos", Icon: Camera },
    { href: "/crew/time", label: "Time", Icon: Clock },
  ];
  if (role === "crew" || role === "superintendent") {
    // Lawn crew get their Route tab; construction crew don't (construction is
    // construction-only now — /lawn is blocked there, so the tab would bounce).
    return isLawn()
      ? [...base, { href: "/lawn/my-route", label: "Route", Icon: Sprout }]
      : base;
  }
  if (role === "project_manager") {
    return base;
  }
  if (role === "office" || role === "admin" || role === "super_admin") {
    // Lawn variant mobile hubs: Home / Lawn / Office / Manage (drop Field).
    // Office hub drops construction doc links; Manage hub drops
    // subcontractors/cost-codes. /field itself is redirected to /lawn by
    // middleware, so it is not a hub here.
    if (isLawn()) {
      return [
        // In the lawn app /lawn IS the home dashboard, so the Home hub points
        // there directly (no separate Lawn hub — it would duplicate Home).
        // aliases keep Home active on /lawn sub-routes (schedules/visits/etc).
        {
          href: "/lawn",
          label: "Home",
          Icon: Home,
          badge: "unread",
          aliases: ["/lawn"],
        },
        {
          href: "/office",
          label: "Office",
          Icon: ClipboardList,
          aliases: [
            "/estimates",
            "/invoices",
            "/admin/reports",
            "/calendar",
            "/admin/customers",
          ],
        },
        {
          href: "/manage",
          label: "Manage",
          Icon: Settings,
          aliases: ["/admin/users", "/admin/billing", "/admin/orgs", "/admin/org"],
        },
      ];
    }
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      {
        href: "/field",
        label: "Field",
        Icon: HardHat,
        aliases: [
          "/crew/photo",
          "/crew/time",
          "/crew/rfi",
          "/crew/daily-log",
          "/crew/punch",
        ],
      },
      {
        href: "/office",
        label: "Office",
        Icon: ClipboardList,
        aliases: [
          "/receipts",
          "/admin/reports",
          "/calendar",
          "/daily-logs",
          "/punch",
          "/change-orders",
          "/submittals",
        ],
      },
      {
        href: "/manage",
        label: "Manage",
        Icon: Settings,
        aliases: [
          "/admin/users",
          "/admin/customers",
          "/admin/subcontractors",
          "/admin/cost-codes",
          "/admin/billing",
          "/admin/orgs",
        ],
      },
    ];
  }
  // Unknown/null role (before the profile load resolves): minimal flat bar,
  // same as the pre-hub initial render - avoids flashing office hubs at crew.
  return base;
}

// Routes that must NOT get the desktop sidebar or the lg:pl-64 content offset -
// public/portal surfaces that have their own chrome and should stay centered.
// This is a superset of the old BottomNav's 4-exact-path suppression (which
// missed the auth-recovery routes and the customer/estimate portals; aligning
// both chrome pieces on this fixes that latent leak too).
const PUBLIC_EXACT = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/update-password",
  "/customer",
];

export function isPublicRoute(pathname: string): boolean {
  return (
    PUBLIC_EXACT.includes(pathname) ||
    pathname.startsWith("/q/") || // customer estimate portal (token link)
    pathname.startsWith("/invoices/view/") || // customer invoice portal (token link)
    pathname.startsWith("/co/") || // customer change-order portal (token link)
    pathname.startsWith("/s/") || // reviewer submittal portal (token link)
    pathname.startsWith("/customer/") // customer portal sub-routes
  );
}