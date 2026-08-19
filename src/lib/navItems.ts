// Single source of truth for the app's primary navigation, consumed by both
// the desktop Sidebar and the mobile BottomNav so the two can never drift apart.
//
// Role → nav model (Option A: single primary role + role-set gates). Field
// roles (crew, superintendent) get a FOCUSED nav — only the surfaces they
// actually use — so a field worker isn't handed a confusing office dashboard.
// Office/PM/accountant/sales get the denser surfaces appropriate to their job.
//
//   crew            — minimal field-capture nav (Home/Photos/Time [+ Route lawn]).
//   superintendent  — field MANAGEMENT (Daily Logs/Punch/Change Orders + base).
//   project_manager — schedule/contracts/pricing + field/office doc surfaces
//                     (Daily Logs/Punch/Change Orders/Submittals/Receipts +
//                     Reports/Insights). The old "PM discrepancy" (PM got only
//                     3 base tabs) is RESOLVED — a PM running jobs end-to-end,
//                     and a small-GC owner wearing PM+Super, needs these.
//   sales           — pre-sale funnel (Estimates/Customers/Insights), no field.
//   accountant      — read-only financials (Invoices/Customers/Reports/Insights).
//   office/admin/   — full office surface (+ Billing for admin, Platform for
//   super_admin       super_admin).
//
// `buildMobileNav` is the MOBILE bar: office/admin/super_admin collapse into
// section hubs (Home/Field/Office/Manage, or Home/Office/Manage on lawn);
// crew/superintendent/PM/sales/accountant keep a short flat bar. The desktop
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
  FileSpreadsheet,
  Settings,
  Contact,
  Calendar,
  TrendingUp,
  Bell,
  UsersRound,
  MessagesSquare,
  Terminal,
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
    // Sales (estimator): pre-sale funnel only — estimates, leads, pipeline.
    if (role === "sales") {
      return [
        { href: "/lawn", label: "Home", Icon: Home, badge: "unread" },
        { href: "/estimates", label: "Estimates", Icon: FileText },
        { href: "/admin/customers", label: "Customers", Icon: Contact },
        { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
      ];
    }
    // Accountant: read-only financials — invoices, customers, insights.
    if (role === "accountant") {
      return [
        { href: "/lawn", label: "Home", Icon: Home, badge: "unread" },
        { href: "/invoices", label: "Invoices", Icon: Receipt },
        { href: "/admin/customers", label: "Customers", Icon: Contact },
        { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
      ];
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
      { href: "/admin/crew-members", label: "Crew", Icon: UsersRound },
      { href: "/estimates", label: "Estimates", Icon: FileText },
      { href: "/invoices", label: "Invoices", Icon: Receipt },
      { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
      { href: "/lawn/notifications", label: "Notifications", Icon: Bell },
      { href: "/calendar", label: "Calendar", Icon: Calendar },
      { href: "/admin/users", label: "Admin", Icon: Users },
    ];
    if (role === "admin") {
      items.push({ href: "/admin/billing", label: "Billing", Icon: CreditCard });
    }
    if (role === "super_admin") {
      items.push({ href: "/admin/orgs", label: "Platform", Icon: Building });
      items.push({ href: "/admin/dev", label: "Dev", Icon: Terminal });
    }
    return items;
  }

  // Construction variant.
  //
  // Field-friendly principle: crew + superintendent get a FOCUSED nav (the
  // field surfaces they actually use), NOT the full office dashboard. A
  // super who runs the site shouldn't be handed Client Portal / Admin /
  // Submittals clutter. Office/PM/accountant get the denser surfaces.
  //
  // PM discrepancy RESOLVED (was flagged at the old line 6-12 note): PM now
  // gets the field/office doc surfaces (Daily Logs, Punch, Change Orders,
  // Submittals, Receipts) alongside Reports + Insights — a PM who runs jobs
  // end-to-end (and a small-GC owner wearing PM+Super) needs them.

  // Crew: minimal field nav — nothing that isn't field-capture.
  if (role === "crew") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Time", Icon: Clock },
    ];
  }

  // Superintendent: field MANAGEMENT — runs the site. Daily Logs, Punch,
  // Change Orders (review), plus the field-capture base. No office/admin
  // clutter. (Time-review FEATURES land next phase; the Time tab is the entry.)
  if (role === "superintendent") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Time", Icon: Clock },
      { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
      { href: "/punch", label: "Punch List", Icon: CheckSquare },
      { href: "/change-orders", label: "Change Orders", Icon: FileDiff },
    ];
  }

  // PM: schedule/permits/contracts/pricing + the field/office doc surfaces.
  if (role === "project_manager") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Time", Icon: Clock },
      { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
      { href: "/punch", label: "Punch List", Icon: CheckSquare },
      { href: "/change-orders", label: "Change Orders", Icon: FileDiff },
      { href: "/submittals", label: "Submittals", Icon: FileText },
      { href: "/receipts", label: "Receipts", Icon: Receipt },
      { href: "/admin/reports", label: "Reports", Icon: FileSpreadsheet },
      { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
    ];
  }

  // Sales (estimator): pre-sale funnel only. No field tabs, no invoices/billing.
  if (role === "sales") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/estimates", label: "Estimates", Icon: FileText },
      { href: "/admin/customers", label: "Customers", Icon: Contact },
      { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
    ];
  }

  // Accountant: read-only financials. No field tabs, no write surfaces.
  if (role === "accountant") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/invoices", label: "Invoices", Icon: Receipt },
      { href: "/admin/customers", label: "Customers", Icon: Contact },
      { href: "/admin/reports", label: "Reports", Icon: FileSpreadsheet },
      { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
    ];
  }

  // office / admin / super_admin — full office surface.
  const items: NavItem[] = [
    { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
    { href: "/crew/photo", label: "Photos", Icon: Camera },
    { href: "/crew/time", label: "Time", Icon: Clock },
    { href: "/receipts", label: "Receipts", Icon: Receipt },
    { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
    { href: "/punch", label: "Punch List", Icon: CheckSquare },
    { href: "/change-orders", label: "Change Orders", Icon: FileDiff },
    { href: "/submittals", label: "Submittals", Icon: FileText },
    { href: "/admin/clients", label: "Client Portal", Icon: MessagesSquare },
    { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
    { href: "/admin/users", label: "Admin", Icon: Users },
  ];
  // Only the org admin manages billing (checkout + Customer Portal routes are
  // admin-only). office/super_admin don't get the tab.
  if (role === "admin") {
    items.push({ href: "/admin/billing", label: "Billing", Icon: CreditCard });
  }
  if (role === "super_admin") {
    items.push({ href: "/admin/orgs", label: "Platform", Icon: Building });
    items.push({ href: "/admin/dev", label: "Dev", Icon: Terminal });
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
  if (role === "crew") {
    // Lawn crew get their Route tab; construction crew don't (construction is
    // construction-only now — /lawn is blocked there, so the tab would bounce).
    return isLawn()
      ? [...base, { href: "/lawn/my-route", label: "Route", Icon: Sprout }]
      : base;
  }
  if (role === "superintendent") {
    // Superintendent runs the site — field-management flat bar. Lawn super
    // stays route-focused (same as crew + Route). Construction super gets the
    // core review surfaces (Time/Daily Logs/Punch); Change Orders + Photos are
    // reachable from the desktop sidebar / dashboard, kept off the short bar.
    if (isLawn()) {
      return [...base, { href: "/lawn/my-route", label: "Route", Icon: Sprout }];
    }
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/time", label: "Time", Icon: Clock },
      { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
      { href: "/punch", label: "Punch", Icon: CheckSquare },
    ];
  }
  if (role === "project_manager") {
    // PM flat bar + Reports (org-wide reports; tier_office_or_pm RLS admits).
    return [...base, { href: "/admin/reports", label: "Reports", Icon: FileSpreadsheet }];
  }
  if (role === "sales") {
    // Sales flat bar — estimates, leads, pipeline. No field tabs.
    return isLawn()
      ? [
          { href: "/lawn", label: "Home", Icon: Home, badge: "unread" },
          { href: "/estimates", label: "Estimates", Icon: FileText },
          { href: "/admin/customers", label: "Customers", Icon: Contact },
          { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
        ]
      : [
          { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
          { href: "/estimates", label: "Estimates", Icon: FileText },
          { href: "/admin/customers", label: "Customers", Icon: Contact },
          { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
        ];
  }
  if (role === "accountant") {
    // Accountant flat bar — read-only financials. No field tabs, no writes.
    return isLawn()
      ? [
          { href: "/lawn", label: "Home", Icon: Home, badge: "unread" },
          { href: "/invoices", label: "Invoices", Icon: Receipt },
          { href: "/admin/customers", label: "Customers", Icon: Contact },
          { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
        ]
      : [
          { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
          { href: "/invoices", label: "Invoices", Icon: Receipt },
          { href: "/admin/customers", label: "Customers", Icon: Contact },
          { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
        ];
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
            "/admin/crew-members",
            "/crew/time",
            "/lawn/insights",
            "/lawn/notifications",
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
          "/admin/insights",
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
          "/admin/clients",
          "/admin/dev",
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
    pathname.startsWith("/v/") || // customer lawn visit photo portal (token link)
    pathname.startsWith("/customer/") // customer portal sub-routes
  );
}