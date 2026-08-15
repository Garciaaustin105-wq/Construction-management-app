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

import {
  Home,
  Camera,
  Clock,
  Receipt,
  Sprout,
  Users,
  Building,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@/lib/roles";

export type NavItem = {
  href: string;
  label: string;
  Icon: LucideIcon;
  // "unread" => the consuming chrome renders the unread-notifications count
  // on this row (Home only).
  badge?: "unread";
};

export function buildNavItems(role: Role | string | null): NavItem[] {
  const items: NavItem[] = [
    { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
    { href: "/crew/photo", label: "Photos", Icon: Camera },
    { href: "/crew/time", label: "Time", Icon: Clock },
  ];
  if (role === "office" || role === "admin" || role === "super_admin") {
    items.push(
      { href: "/receipts", label: "Receipts", Icon: Receipt },
      { href: "/lawn", label: "Lawn", Icon: Sprout },
      { href: "/admin/users", label: "Admin", Icon: Users },
    );
  }
  // Field crew get their own scoped Lawn tab (their assigned route), not the
  // office hub (which would redirect them).
  if (role === "crew" || role === "superintendent") {
    items.push({ href: "/lawn/my-route", label: "Route", Icon: Sprout });
  }
  if (role === "super_admin") {
    items.push({ href: "/admin/orgs", label: "Platform", Icon: Building });
  }
  return items;
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
    pathname.startsWith("/customer/") // customer portal sub-routes
  );
}