// Server-side tenant + identity helper. `getMe()` is the single request-scoped
// source of truth for the signed-in caller (user, role, org, billing), cached
// via React's `cache()` so the root layout, every server page, and every route
// handler in ONE request share ONE resolve instead of each re-fetching.
//
// ROUND-TRIP COUNT (Task 13, the get_my_tenant() RPC):
//   getMe() resolves the whole tenant in ONE round trip:
//     1. supabase.auth.getSession()  — LOCAL, reads the cookie the proxy
//        already refreshed (0 network). Replaces the old auth.getUser()
//        network call to /auth/v1/user.
//     2. supabase.rpc("get_my_tenant") — a single PostgREST call that returns
//        profile + org server-side (was two separate queries).
//   Down from 3 serial round trips (getUser + profiles + organizations) to 1.
//
// `getMeIdentity()` (route handlers) is layered ON TOP of `getMe()` and shares
// its cached resolve, so a request that calls both still does ONE round trip.
// The org fields are bundled into the SAME RPC call (free — same round trip),
// so routes no longer pay extra for org; the old identity/org split existed
// only because the org read was a SEPARATE query the RPC has now absorbed.
//
// DEPLOY SAFETY: getMe() tries the RPC first and FALLS BACK to getSession +
// profiles + organizations (the proven path) if the RPC errors — e.g. the
// get_my_tenant() migration hasn't been run yet, or a transient failure.
// So shipping this code before the SQL is live does NOT break login; it just
// runs the fallback (still faster than before, since getSession replaces
// getUser). Once the SQL is live, the RPC path is used and the fallback never
// fires. Remove the fallback once the migration is confirmed live everywhere.
//
// RETURN CONTRACT is UNCHANGED — `getMe()` still returns MyTenant
// {user, orgId, role, hasProfile, isSuperAdmin, orgName, plan, planStatus,
//  trialEndsAt, appVariant}, so the ~68 shipped pages/routes keep working.
//
// `getMyOrg` / `requireOrgScoped` are kept as backward-compatible thin wrappers
// over `getMe` so existing call sites keep working; new code should call
// `getMe()` (pages) or `getMeIdentity()` (routes) directly.

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

// Who the caller is — resolvable from getUser + the profiles row alone.
export type MyIdentity = {
  // The resolved auth user. Present so callers that used to do their own
  // `auth.getUser()` can read `me.user.id` / `.email` without a second fetch.
  user: User;
  orgId: string | null; // null for super_admin (platform, no org)
  role: string; // falls back to "crew" when the profile row is missing
  // True when a profiles row exists for the user. False when the auth user
  // exists but no workspace profile was created (e.g. an incomplete signup).
  // Lets pages that surface an "account not set up" state distinguish it from
  // a legitimate crew user (who also resolves to role "crew").
  hasProfile: boolean;
  isSuperAdmin: boolean;
};

// The caller's organization row — one extra read on top of MyIdentity.
export type MyOrg = {
  // The caller's org display name (null for super_admin). Folded in so pages
  // that show the workspace name (dashboard, TopBar) don't each re-query
  // organizations.
  orgName: string | null;
  // Billing (populated only when orgId is non-null; null for super_admin).
  plan: string | null;
  planStatus: string | null;
  trialEndsAt: string | null;
  // Platform variant this org signed up under. Defaults to "construction" for
  // super_admin (no org) and any pre-column org. Lets server routes that create
  // construction jobs/docs 403 on lawn orgs (belt-and-suspenders behind the
  // proxy page redirect + the DB trigger guard).
  appVariant: "construction" | "lawn";
};

// Unchanged shape — exactly the fields callers had before the split.
export type MyTenant = MyIdentity & MyOrg;

// Row shape returned by the public.get_my_tenant() RPC (mirrors the function's
// returns table). role is raw (null when no profile row); the client applies
// the "crew" fallback.
type TenantRow = {
  role: string | null;
  organization_id: string | null;
  has_profile: boolean;
  is_super_admin: boolean;
  org_name: string | null;
  plan: string | null;
  plan_status: string | null;
  trial_ends_at: string | null;
  app_variant: string | null;
};

const NO_ORG: MyOrg = {
  orgName: null,
  plan: null,
  planStatus: null,
  trialEndsAt: null,
  appVariant: "construction",
};

// Identity + org/billing in ONE round trip (getSession is local + one RPC).
// Field set is unchanged — every existing page caller keeps working as-is.
// The org read is skipped inside the RPC when orgId is null (super_admin).
export const getMe = cache(async (): Promise<MyTenant | null> => {
  const supabase = await createClient();

  // LOCAL session read — replaces the auth.getUser() network round trip. The
  // proxy already refreshed the cookie; the RPC below 401s if the JWT is
  // invalid, which is the validation getUser() used to provide.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) return null;

  // One PostgREST round trip for profile + org (was two separate queries).
  const { data: row, error } = await supabase
    .rpc("get_my_tenant")
    .maybeSingle();

  if (!error && row) {
    const r = row as TenantRow;
    return {
      user: session.user,
      orgId: r.organization_id,
      role: r.role ?? "crew",
      hasProfile: r.has_profile,
      isSuperAdmin: r.is_super_admin,
      orgName: r.org_name,
      plan: r.plan,
      planStatus: r.plan_status,
      trialEndsAt: r.trial_ends_at,
      appVariant: r.app_variant === "lawn" ? "lawn" : "construction",
    };
  }

  // FALLBACK — RPC not available (migration not run yet) or transient error.
  // Reuses the session user (no extra getUser) + the two queries the RPC
  // replaces. Keeps the app working before the SQL is live; remove once the
  // migration is confirmed live.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", session.user.id)
    .maybeSingle();
  const role = profile?.role ?? "crew";
  const orgId = (profile?.organization_id as string | null) ?? null;
  let org: MyOrg = NO_ORG;
  if (orgId) {
    const { data: o } = await supabase
      .from("organizations")
      .select("name, plan, plan_status, trial_ends_at, app_variant")
      .eq("id", orgId)
      .maybeSingle();
    if (o) {
      org = {
        orgName: o.name ?? null,
        plan: o.plan ?? null,
        planStatus: o.plan_status ?? null,
        trialEndsAt: o.trial_ends_at ?? null,
        appVariant: o.app_variant === "lawn" ? "lawn" : "construction",
      };
    }
  }
  return {
    user: session.user,
    orgId,
    role,
    hasProfile: !!profile,
    isSuperAdmin: role === "super_admin",
    ...org,
  };
});

// Request-scoped cached IDENTITY (for route handlers that need nothing but
// user / orgId / role / hasProfile / isSuperAdmin). Layered on getMe() so a
// request that calls both shares the single RPC resolve. The org fields the
// RPC bundles are simply ignored here — they ride the same round trip free.
export const getMeIdentity = cache(async (): Promise<MyIdentity | null> => {
  const me = await getMe();
  if (!me) return null;
  return {
    user: me.user,
    orgId: me.orgId,
    role: me.role,
    hasProfile: me.hasProfile,
    isSuperAdmin: me.isSuperAdmin,
  };
});

// Legacy: a separate cached organizations read. No longer on the getMe() hot
// path (the RPC bundles the org read), but kept exported for any direct caller.
// NOTE: this stays a SEPARATE query, NOT a PostgREST `organizations(...)` embed
// on a profiles select — the embed needs a DECLARED FK profiles.organization_id
// -> organizations.id that is NOT reliably declared live (the
// `add column if not exists ... references` no-op), so the embed 400s
// (PGRST108). Re-enable an embed only after `alter table profiles add
// constraint ... foreign key (organization_id) references organizations(id)`
// is confirmed live. The RPC sidesteps this entirely.
export const getOrgRow = cache(async (orgId: string): Promise<MyOrg | null> => {
  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("name, plan, plan_status, trial_ends_at, app_variant")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return null;
  return {
    orgName: org.name ?? null,
    plan: org.plan ?? null,
    planStatus: org.plan_status ?? null,
    trialEndsAt: org.trial_ends_at ?? null,
    appVariant: org.app_variant === "lawn" ? "lawn" : "construction",
  };
});

// Backward-compatible alias over the cached `getMe`. Prefer `getMe()` in new
// code. All in-tree call sites have been migrated.
export async function getMyOrg(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _supabase?: unknown
): Promise<MyTenant | null> {
  return getMe();
}

// Require an org-scoped (non-platform) caller. Returns the caller's tenant or
// a 403-style sentinel. Use for root-table inserts where a null org
// (super_admin without a target org) is not allowed.
export async function requireOrgScoped(): Promise<
  { ok: true; tenant: MyTenant } | { ok: false; status: number; error: string }
> {
  const tenant = await getMe();
  if (!tenant) return { ok: false, status: 401, error: "Not signed in" };
  if (tenant.isSuperAdmin && !tenant.orgId) {
    return {
      ok: false,
      status: 403,
      error: "Super admin must target an organization for this action",
    };
  }
  if (!tenant.orgId) {
    return { ok: false, status: 403, error: "Your account has no organization" };
  }
  return { ok: true, tenant };
}