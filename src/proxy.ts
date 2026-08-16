import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isLawn } from "@/lib/variant";

// Next 16 root proxy. Two jobs, in order:
//   1. Variant gate (lawn deploy only) — redirect construction-only PAGES to
//      /lawn and 404 construction-only APIs. This is defense-in-depth BEHIND the
//      UI hiding: the nav, hub pages, and dashboard already omit these surfaces
//      for lawn; this just ensures a user who types /change-orders or /jobs/<id>
//      (or fetches a construction API) can't reach them.
//   2. Refresh the Supabase auth session cookie on every allowed request — the
//      standard Supabase SSR pattern that keeps signed-in users' sessions alive.
//      (This was the proxy's original and only job before the Terra Verde split.)
//
// The gate runs BEFORE updateSession: a blocked page redirects without doing
// session work (the browser then loads /lawn, an allowed route, which refreshes
// the session there). In the construction build isLawn() is false at build time
// (NEXT_PUBLIC_APP_VARIANT inlined), so the gate is a dead branch the compiler
// drops — no runtime cost, construction behavior unchanged.
//
// Per-page server guards still handle auth; this proxy does NOT gate on the
// session, only on the build variant. See src/lib/variant.ts + navItems.ts.

const BLOCKED_PAGE_PREFIXES = [
  "/admin/projects", // construction job creator
  "/jobs", // covers /jobs/[id], /jobs/[id]/gantt, /jobs/[id]/inspections
  "/change-orders", // /change-orders, /new, /[id]
  "/submittals", // /submittals, /new, /[id]
  "/daily-logs", // /daily-logs, /new, /[id]
  "/punch", // /punch, /new, /[id]
  "/receipts", // construction material receipts
  "/photos", // construction photo library (lawn uses /crew/photo)
  "/field", // construction field hub (lawn uses /lawn/my-route)
  "/crew/rfi", // construction crew RFI
  "/crew/daily-log", // construction crew daily log
  "/crew/punch", // construction crew punch list
  "/admin/subcontractors", // construction subcontractors + [id]
  "/admin/cost-codes", // construction cost codes
  "/co/", // change-order public portal (construction)
  "/s/", // submittal public portal (construction)
];

const BLOCKED_API_PREFIXES = [
  "/api/change-orders",
  "/api/submittals",
  "/api/reports/change-orders",
  "/api/reports/submittals",
  "/api/reports/daily-logs",
  "/api/reports/job-inspections",
  "/api/reports/job-schedule",
];

export async function proxy(request: NextRequest) {
  if (isLawn()) {
    const { pathname } = request.nextUrl;
    if (pathname.startsWith("/api/")) {
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
  }

  // Allowed route (or construction variant): refresh the Supabase session.
  return updateSession(request);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files (manifest.json included so the
    // PWA manifest is served without a session round-trip). /api/** is
    // intentionally included so the blocked-API check can run.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|manifest.json)$).*)",
  ],
};