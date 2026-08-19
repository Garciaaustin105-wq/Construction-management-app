import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isLawn, isConstruction } from "@/lib/variant";
import { captureException } from "@sentry/nextjs";

// Next 16 root proxy. Two jobs, in order:
//   1. Variant gate — a CLEAN TWO-WAY split. Each deploy hides the OTHER
//      variant's surfaces (defense-in-depth BEHIND the UI hiding: the nav, hub
//      pages, and dashboard already omit them; this ensures a user who types the
//      URL or fetches the API can't reach them either):
//        lawn deploy (isLawn())         → redirect construction PAGES to /lawn,
//                                          404 construction APIs.
//        construction deploy (isConstruction()) → redirect lawn PAGES to
//                                          /dashboard, 404 lawn APIs.
//   2. Refresh the Supabase auth session cookie on every allowed request — the
//      standard Supabase SSR pattern that keeps signed-in users' sessions alive.
//      (This was the proxy's original and only job before the Terra Verde split.)
//
// The gate runs BEFORE updateSession: a blocked page redirects without doing
// session work (the browser then loads the allowed landing, which refreshes the
// session there). The inactive variant's branch is a dead branch the compiler
// drops (NEXT_PUBLIC_APP_VARIANT is inlined at build time) — no runtime cost.
//
// The lawn cron routes (/api/lawn/cron/*) are NOT blocked in either variant:
// they are CRON_SECRET-protected (not a UI surface) and idempotent (the
// unique(recurring_schedule_id, due_date) index ignores duplicate inserts), so
// both deploys running them is safe and redundant.
//
// Per-page server guards still handle auth; this proxy does NOT gate on the
// session, only on the build variant. See src/lib/variant.ts + navItems.ts.
//
// The whole body is wrapped in try/catch so an unexpected throw in the variant
// gate or updateSession is reported to Sentry (edge runtime) and rethrown —
// INERT until SENTRY_DSN is set (captureException no-ops without a DSN).

const BLOCKED_PAGE_PREFIXES = [
  "/admin/projects", // construction job creator
  "/jobs", // covers /jobs/[id], /jobs/[id]/gantt, /jobs/[id]/inspections
  "/change-orders", // /change-orders, /new, /[id]
  "/submittals", // /submittals, /new, /[id]
  "/daily-logs", // /daily-logs, /new, /[id]
  "/punch", // /punch, /new, /[id]
  "/receipts", // construction material receipts
  "/admin/reports/receipts", // construction receipts report (lawn has no receipts)
  "/photos", // construction photo library (lawn uses /crew/photo)
  "/field", // construction field hub (lawn uses /lawn/my-route)
  "/crew/rfi", // construction crew RFI
  "/crew/daily-log", // construction crew daily log
  "/crew/punch", // construction crew punch list
  "/admin/subcontractors", // construction subcontractors + [id]
  "/admin/cost-codes", // construction cost codes
  "/admin/clients", // construction Client Portal office page (lawn has no clients)
  "/co/", // change-order public portal (construction)
  "/s/", // submittal public portal (construction)
];

const BLOCKED_API_PREFIXES = [
  "/api/change-orders",
  "/api/submittals",
  "/api/clients", // construction client-portal invite (office invites a customer)
  "/api/proposals", // construction proposals/e-sign (lawn has no contract proposals)
  "/api/reports/change-orders",
  "/api/reports/submittals",
  "/api/reports/daily-logs",
  "/api/reports/job-inspections",
  "/api/reports/job-schedule",
];

// Mirror blocklists for the CONSTRUCTION deploy: lawn surfaces hidden there.
// Lawn pages redirect to /dashboard (the construction home); lawn user-facing
// APIs 404. /api/lawn/cron/* is intentionally NOT here (see header comment).
const LAWN_BLOCKED_PAGE_PREFIXES = [
  "/lawn", // covers /lawn, /lawn/new, /lawn/schedules/[id], /lawn/calendar,
  // /lawn/routes, /lawn/services, /lawn/weather, /lawn/billing,
  // /lawn/my-route, /lawn/visits/[id]
];

const LAWN_BLOCKED_API_PREFIXES = [
  "/api/lawn/visits",
  "/api/lawn/weather",
  "/api/lawn/billing",
];

export async function proxy(request: NextRequest) {
  try {
    const { pathname } = request.nextUrl;
    const isApi = pathname.startsWith("/api/");

    if (isLawn()) {
      if (isApi) {
        // Construction API route: 404 (page routes redirect, but a direct fetch
        // shouldn't reach construction data either).
        if (BLOCKED_API_PREFIXES.some((p) => pathname.startsWith(p))) {
          return new NextResponse("Not Found", { status: 404 });
        }
      } else if (BLOCKED_PAGE_PREFIXES.some((p) => pathname.startsWith(p))) {
        // Construction page: redirect to the lawn landing.
        const url = request.nextUrl.clone();
        url.pathname = "/lawn";
        url.search = "";
        return NextResponse.redirect(url);
      }
    } else if (isConstruction()) {
      if (isApi) {
        // Lawn API route: 404 (direct fetch shouldn't reach lawn data).
        if (LAWN_BLOCKED_API_PREFIXES.some((p) => pathname.startsWith(p))) {
          return new NextResponse("Not Found", { status: 404 });
        }
      } else if (LAWN_BLOCKED_PAGE_PREFIXES.some((p) => pathname.startsWith(p))) {
        // Lawn page: redirect to the construction landing.
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.search = "";
        return NextResponse.redirect(url);
      }
    }

    // Allowed route: refresh the Supabase session.
    return updateSession(request);
  } catch (err) {
    // Edge runtime — sentry.edge.config is loaded by instrumentation. Capture
    // and rethrow so the request still fails the same way; we just get a report.
    captureException(err);
    throw err;
  }
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files (manifest.json included so the
    // PWA manifest is served without a session round-trip). /api/** is
    // intentionally included so the blocked-API check can run.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|manifest.json)$).*)",
  ],
};