import { redirect } from "next/navigation";
import { getMe, type MyTenant } from "@/lib/tenant";
import type { Role } from "@/lib/roles";

// Server-page role gate. Collapses the boilerplate repeated across ~50 pages:
//   const me = await getMe();
//   if (!me) redirect("/login");
//   if (!ALLOWED.has(me.role as never)) redirect("/dashboard");
// into one call:
//   const me = await requireRole(OFFICE_OR_PM);
// `getMe()` is request-cached, so a page that also reads me.orgId / me.orgName
// / me.plan after the gate shares the single get_my_tenant() RPC resolve.
//
// Returns the full MyTenant (non-null) so callers destructure exactly as they
// did after the hand-rolled gate. The redirect target defaults to /dashboard
// (the construction hub); lawn pages pass "/lawn" where appropriate. Variant
// cross-redirects (e.g. a lawn super_admin → /dashboard, or a construction
// user on /lawn → /dashboard via the proxy) stay in the page — this helper only
// owns the role-set gate.

export async function requireRole(
  allowed: Set<Role>,
  redirectTo = "/dashboard"
): Promise<MyTenant> {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!allowed.has(me.role as Role)) redirect(redirectTo);
  return me;
}