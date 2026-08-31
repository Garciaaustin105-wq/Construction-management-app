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
  Mail,
  UsersRound,
  Images,
  Terminal,
  Radio,
  UserPlus,
  Star,
  FlaskConical,
  Package,
  Sparkles,
  LayoutTemplate,
  CalendarDays,
  ShieldCheck,
  LocateFixed,
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

function buildNavItemsBase(role: Role | string | null): NavItem[] {
  // Lawn variant: lawn-only desktop sidebar — no construction GC-pro surfaces
  // (receipts/daily-logs/punch/change-orders/submittals all dropped). Crew keep
  // their flat route tab; PM keeps the base 3.
  if (isLawn()) {
    const base: NavItem[] = [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Clock in/out", Icon: Clock },
    ];
    if (role === "crew" || role === "superintendent") {
      return [...base, { href: "/lawn/my-route", label: "Route", Icon: Sprout }];
    }
    if (role === "project_manager") {
      return base;
    }
    // Sales (estimator): pre-sale funnel only — estimates, leads, pipeline.
    // Home points straight at /estimates because /lawn redirects non-FIELD_MGMT
    // roles away (sales → /estimates); pointing Home at /lawn would loop.
    if (role === "sales") {
      return [
        { href: "/estimates", label: "Home", Icon: Home, badge: "unread" },
        { href: "/estimates", label: "Estimates", Icon: FileText },
        { href: "/admin/customers", label: "Customers", Icon: Contact },
        { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
      ];
    }
    // Accountant: read-only financials — invoices, customers, insights. Home
    // points straight at /invoices (/lawn redirects accountant → /invoices).
    if (role === "accountant") {
      return [
        { href: "/invoices", label: "Home", Icon: Home, badge: "unread" },
        { href: "/invoices", label: "Invoices", Icon: Receipt },
        { href: "/admin/customers", label: "Customers", Icon: Contact },
        { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
      ];
    }
    // super_admin — platform-only nav (no org workspace content). Home is
    // /dashboard, which renders the platform block on both variants (the
    // dashboard lawn-redirect exempts super_admin).
    if (role === "super_admin") {
      return [
        { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
        { href: "/admin/users", label: "Users", Icon: Users },
        { href: "/admin/orgs", label: "Platform", Icon: Building },
        { href: "/admin/dev", label: "Dev", Icon: Terminal },
      ];
    }

    // office / admin — in the lawn app /lawn IS the home
    // dashboard (the lawn office landing page), so Home points there directly
    // and there is no separate "Lawn" tab (it would just duplicate Home).
    // /dashboard still redirects to /lawn as a safety net for typed/old links.
    const items: NavItem[] = [
      { href: "/lawn", label: "Home", Icon: Home, badge: "unread" },
      { href: "/lawn/jobs", label: "Jobs", Icon: CheckSquare },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Clock in/out", Icon: Clock },
      { href: "/admin/customers", label: "Customers", Icon: Contact },
      { href: "/admin/leads", label: "Leads", Icon: UserPlus },
      { href: "/admin/reviews", label: "Reviews", Icon: Star },
      // Chemical application tracking (lawn compliance). Applications = the log
      // + CSV export (office/PM; crew log from the visit page, not this nav).
      // Products = the org's chemical catalog (office/PM manage).
      { href: "/lawn/applications", label: "Applications", Icon: FlaskConical },
      { href: "/lawn/products", label: "Products", Icon: Package },
      // Compliance records (RUP purchases/30-day rule, disposal, CEU,
      // noncertified training) — page gate is OFFICE_OR_PM; this entry sits in
      // the lawn office/admin fallthrough block so it matches.
      { href: "/lawn/compliance", label: "Compliance", Icon: ShieldCheck },
      { href: "/admin/crew-members", label: "Team", Icon: UsersRound },
      // "Measure & quote" (/estimates/quick) and Templates (/templates) used
      // to be separate top-of-nav tabs, but neither is a distinct top-level
      // concept — both are entry points/config that live inside Estimates
      // (the New menu and a Templates sub-view respectively). Consolidated
      // per user request 2026-08-29: one Estimates tab, not three. The
      // routes themselves still work (quick-actions on /lawn still link
      // /estimates/quick directly; /templates redirects into the new view).
      { href: "/estimates", label: "Estimates", Icon: FileText },
      { href: "/invoices", label: "Invoices", Icon: Receipt },
      { href: "/lawn/insights", label: "Insights", Icon: TrendingUp },
      // AI admin (slice 1: visit summarization). Office/admin only — the page
      // gate (src/app/lawn/ai/page.tsx) bounces super_admin + non-office; this
      // nav entry is in the lawn office/admin fallthrough block so it matches.
      { href: "/lawn/ai", label: "AI admin", Icon: Sparkles },
      { href: "/lawn/notifications", label: "Customer notifications", Icon: Bell },
      // Scheduling ops (weather auto-reschedule settings, batch reschedule,
      // blackouts, zones, crew time off) — page gate is OFFICE_LIKE, this
      // entry sits in the lawn office/admin fallthrough block to match.
      { href: "/lawn/scheduling", label: "Scheduling", Icon: CalendarDays },
      // Live crew tracking. Sits next to Scheduling because it answers a
      // dispatch question ("how far out is he?"), not a reporting one. Page
      // gate is OFFICE_OR_PM and the crew_locations read policy is
      // me_is_office_or_pm, so this entry sits in the office/admin block to
      // match both. Free-plan orgs still see the tab and get the upgrade
      // panel — hiding it would make the feature undiscoverable.
      { href: "/lawn/track", label: "Crew tracking", Icon: LocateFixed },
      { href: "/admin/email-preview", label: "Email Preview", Icon: Mail },
      // Points at the lawn dispatch board (Month/Week/Agenda, drag-to-
      // reschedule, filters, crew colors), not the generic org-wide /calendar
      // page — office/admin is exactly who /lawn/calendar admits (OFFICE_LIKE),
      // so this never dead-ends. PM/superintendent don't get this nav entry on
      // lawn (their nav is the small `base` set), so they still only ever
      // reach the generic /calendar (which they can access) — no dead link.
      { href: "/lawn/calendar", label: "Calendar", Icon: Calendar },
      // Account = the org-settings hub (/manage), replacing the separate
      // "Admin" and "Billing" tabs. Billing and user management both read as
      // account concerns, and two near-identical tabs at the end of a 20-item
      // sidebar was clutter.
      //
      // Deliberately NOT /account: that page is PERSONAL (own login + MFA) and
      // open to every role including crew and customers. Moving org billing
      // there would either expose it to crew or force a gate that costs crew
      // their own MFA page. /manage is already the org-level hub, is already
      // OFFICE_LIKE-gated, and already shows billing only to office/admin — so
      // this changes discoverability, not permissions.
      { href: "/manage", label: "Account", Icon: Settings },
    ];
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
      { href: "/crew/time", label: "Clock in/out", Icon: Clock },
    ];
  }

  // Superintendent: field MANAGEMENT — runs the site. Daily Logs, Punch,
  // Change Orders (review), plus the field-capture base. No office/admin
  // clutter. (Time-review FEATURES land next phase; the Time tab is the entry.)
  if (role === "superintendent") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/crew/photo", label: "Photos", Icon: Camera },
      { href: "/crew/time", label: "Clock in/out", Icon: Clock },
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
      { href: "/crew/time", label: "Clock in/out", Icon: Clock },
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

  // super_admin — platform-only nav (no org workspace content). Home is
  // /dashboard, which renders the platform block on both variants.
  if (role === "super_admin") {
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/admin/users", label: "Users", Icon: Users },
      { href: "/admin/orgs", label: "Platform", Icon: Building },
      { href: "/admin/dev", label: "Dev", Icon: Terminal },
    ];
  }

  // office / admin — full office surface.
  const items: NavItem[] = [
    { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
    { href: "/crew/photo", label: "Upload Photo", Icon: Camera },
    { href: "/crew/time", label: "Clock in/out", Icon: Clock },
    { href: "/receipts", label: "Receipts", Icon: Receipt },
    { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
    { href: "/punch", label: "Punch List", Icon: CheckSquare },
    { href: "/change-orders", label: "Change Orders", Icon: FileDiff },
    { href: "/submittals", label: "Submittals", Icon: FileText },
    // Global photo browser — see all jobs' photos in one place (was
    // previously reachable from nowhere in the app). "Client Portal"
    // (/admin/clients) used to sit here; it's still reachable from the
    // Customers page (it largely duplicated that page's customer list —
    // see the "two customer tabs" fix on /admin/customers).
    { href: "/photos", label: "Photos", Icon: Images },
    // Reusable line-item templates (both variants use estimates).
    { href: "/templates", label: "Templates", Icon: LayoutTemplate },
    { href: "/admin/insights", label: "Insights", Icon: TrendingUp },
    { href: "/admin/email-preview", label: "Email Preview", Icon: Mail },
    // Account = the org-settings hub (/manage), replacing the separate
    // "Admin" and "Billing" tabs. Billing and user management both read as
    // account concerns, and two near-identical tabs at the end of a 20-item
    // sidebar was clutter.
    //
    // Deliberately NOT /account: that page is PERSONAL (own login + MFA) and
    // open to every role including crew and customers. Moving org billing
    // there would either expose it to crew or force a gate that costs crew
    // their own MFA page. /manage is already the org-level hub, is already
    // OFFICE_LIKE-gated, and already shows billing only to office/admin — so
    // this changes discoverability, not permissions.
    { href: "/manage", label: "Account", Icon: Settings },
  ];
  return items;
}

// Mobile bottom-nav items. Office/admin/super_admin collapse the flat 7-8 cell
// row into 5 section hubs; crew/superintendent/PM keep a flat bar. Sign Out
// for hub roles lives in the Manage hub page (not the bar), so it is NOT an
// item here. See plan: mobile bottom-nav cleanup.
function buildMobileNavBase(role: Role | string | null): NavItem[] {
  const base: NavItem[] = [
    { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
    { href: "/crew/photo", label: "Photos", Icon: Camera },
    { href: "/crew/time", label: "Clock in/out", Icon: Clock },
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
      { href: "/crew/time", label: "Clock in/out", Icon: Clock },
      { href: "/daily-logs", label: "Daily Logs", Icon: ClipboardList },
      { href: "/punch", label: "Punch", Icon: CheckSquare },
    ];
  }
  if (role === "project_manager") {
    // PM flat bar + Reports (org-wide reports; tier_office_or_pm RLS admits).
    return [...base, { href: "/admin/reports", label: "Reports", Icon: FileSpreadsheet }];
  }
  if (role === "sales") {
    // Sales flat bar — estimates, leads, pipeline. No field tabs. Home points
    // straight at /estimates (lawn) / /dashboard (construction) — /lawn redirects
    // sales away, so Home=/lawn would loop.
    return isLawn()
      ? [
          { href: "/estimates", label: "Home", Icon: Home, badge: "unread" },
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
    // Home points straight at /invoices (lawn) — /lawn redirects accountant away.
    return isLawn()
      ? [
          { href: "/invoices", label: "Home", Icon: Home, badge: "unread" },
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
  if (role === "super_admin") {
    // Platform-only mobile bar — no Field/Office/Manage org hubs.
    return [
      { href: "/dashboard", label: "Home", Icon: Home, badge: "unread" },
      { href: "/admin/users", label: "Users", Icon: Users },
      { href: "/admin/orgs", label: "Platform", Icon: Building },
      { href: "/admin/dev", label: "Dev", Icon: Terminal },
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
            "/admin/crew-members",
            "/crew/time",
            "/crew/photo",
            "/lawn/insights",
            "/lawn/ai",
            "/lawn/notifications",
            "/admin/email-preview",
            "/admin/leads",
            "/admin/reviews",
            "/lawn/applications",
            "/lawn/products",
            "/lawn/compliance",
            "/lawn/scheduling",
            // Customers is an Office-hub card again (it was moved to the
            // Account hub when its card lived there). The alias must follow the
            // card or the bottom bar highlights the wrong tab.
            "/admin/customers",
          ],
        },
        {
          href: "/manage",
          label: "Account",
          Icon: Settings,
          // /admin/customers moved here from Office's aliases — the Customers
          // card itself was removed from the lawn Office page (it duplicated
          // Manage's Customers card), but the alias was left pointing at
          // Office, so the bottom nav highlighted the wrong tab whenever you
          // were actually on the Customers page (reached via Manage).
          aliases: [
            "/admin/users",
            "/admin/billing",
            "/admin/orgs",
            "/admin/org",
          ],
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
          "/admin/customers",
          "/admin/subcontractors",
          "/admin/cost-codes",
          "/admin/reports",
          "/admin/insights",
          "/calendar",
          "/daily-logs",
          "/punch",
          "/change-orders",
          "/submittals",
          "/photos",
          "/admin/email-preview",
        ],
      },
      {
        href: "/manage",
        label: "Account",
        Icon: Settings,
        aliases: [
          "/admin/users",
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
  "/privacy",
  "/terms",
  // Pre-full-auth MFA step-up screen -- same category as /login (the user has
  // a session but hasn't completed sign-in yet), not a normal authenticated
  // page. /account (MFA enrollment itself) keeps normal chrome deliberately.
  "/mfa/challenge",
];

export function isPublicRoute(pathname: string): boolean {
  return (
    PUBLIC_EXACT.includes(pathname) ||
    pathname.startsWith("/q/") || // customer estimate portal (token link)
    pathname.startsWith("/invoices/view/") || // customer invoice portal (token link)
    pathname.startsWith("/co/") || // customer change-order portal (token link)
    pathname.startsWith("/s/") || // reviewer submittal portal (token link)
    pathname.startsWith("/v/") || // customer lawn visit photo portal (token link)
    pathname.startsWith("/lead/") || // public lead capture form (token link)
    pathname.startsWith("/r/") || // public review-rating gate (token link)
    pathname.startsWith("/customer/") || // customer portal sub-routes
    pathname === "/isp/checkout/complete" // ISP subscriber's Stripe return page
  );
}
// ── ISP / fiber module (hidden, per-org) ────────────────────────────────────
// `installs` is a per-ORG feature (organizations.isp_module_enabled), not a
// per-variant one, so it can't live inside the role branches above — those
// only see the role and the build-time variant. Instead the two builders are
// wrapped: the base functions are untouched, and the Installs row is inserted
// only when the caller passes ispModule.
//
// POSITION: inserted right after Home (index 1) — Installs is the headline
// daily surface for the one org that has the module, so it sits second, not
// buried at the bottom under Admin/Billing (desktop) or as the trailing cell
// (mobile). Every existing call site that passes no opts gets a byte-identical
// nav to before, which is the point — no other tenant's chrome changes.
//
// This is UI reachability only. RLS is what protects install data; see the
// header of src/lib/useIspModule.ts.

export type NavOpts = {
  /** organizations.isp_module_enabled for the signed-in user's org. */
  ispModule?: boolean;
};

// Roles that get the Installs tab when the module is on. Customers never do
// (internal pricing + field notes). Sales/accountant have no field surface, so
// it would just be clutter. super_admin's nav is platform-only by design.
const INSTALL_ROLES = new Set([
  "crew",
  "superintendent",
  "project_manager",
  "office",
  "admin",
]);

const INSTALLS_ITEM: NavItem = {
  href: "/installs",
  label: "Installs",
  Icon: Radio,
};

function withIspModule(
  items: NavItem[],
  role: Role | string | null,
  opts?: NavOpts
): NavItem[] {
  if (!opts?.ispModule) return items;
  if (!role || !INSTALL_ROLES.has(role)) return items;
  if (items.some((i) => i.href === "/installs")) return items;
  // Insert as the 2nd item (right after Home). Every INSTALL_ROLES nav starts
  // with a Home row, so index 1 is always after it. Falls back to appending if
  // a nav somehow has no Home row.
  const homeIdx = items.findIndex((i) => i.href === "/dashboard" || i.href === "/lawn");
  const insertAt = homeIdx >= 0 ? homeIdx + 1 : items.length;
  const out = [...items];
  out.splice(insertAt, 0, INSTALLS_ITEM);
  return out;
}

export function buildNavItems(
  role: Role | string | null,
  opts?: NavOpts
): NavItem[] {
  return withIspModule(buildNavItemsBase(role), role, opts);
}

export function buildMobileNav(
  role: Role | string | null,
  opts?: NavOpts
): NavItem[] {
  return withIspModule(buildMobileNavBase(role), role, opts);
}
