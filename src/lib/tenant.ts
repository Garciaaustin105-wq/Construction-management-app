// Server-side tenant + identity helper. `getMe()` is the single request-scoped
// source of truth for the signed-in caller (user, role, org, billing), cached
// via React's `cache()` so the root layout, every server page, and every route
// handler in ONE request share ONE `getUser()` + ONE `profiles`/`organizations`
// read instead of each re-fetching. This is the Tier 1 perf fix: it collapses
// the duplicate `auth.getUser()` (proxy → layout → page → getMyOrg was up to
// 4×) and the per-page `profiles` re-read across ~90 call sites.
//
// TWO ENTRY POINTS, because pages and route handlers have different economics:
//
//   getMe()          → identity + org/billing. 3 reads (getUser, profiles,
//                      organizations). Use in PAGES: the root layout already
//                      calls it, so `cache()` makes every later caller in that
//                      render free, and the org fields (orgName / plan /
//                      planStatus / trialEndsAt / appVariant) are already paid
//                      for.
//   getMeIdentity()  → identity ONLY. 2 reads (getUser, profiles). Use in ROUTE
//                      HANDLERS that need nothing but user / orgId / role /
//                      hasProfile / isSuperAdmin. An API request renders NO root
//                      layout, so `cache()` has nothing to dedup against and the
//                      caller pays every read itself — bundling the organizations
//                      row there is a wasted round trip. This path restores the
//                      2-read cost the hand-written `getUser()` + `profiles`
//                      preamble had before the sweep.
//
// `getMe()` is layered ON TOP of `getMeIdentity()` (plus `getOrgRow()`), and both
// are cached, so a request that calls both still does ONE getUser + ONE profiles
// read. `getMe()`'s return type and field set are unchanged — the ~68 shipped
// pages that read `me.orgName` / `me.plan` / `me.appVariant` are unaffected.
//
// `getMyOrg` / `requireOrgScoped` are kept as backward-compatible thin wrappers
// over `getMe` so existing call sites keep working during the sweep; new code
// should call `getMe()` (pages) or `getMeIdentity()` (routes) directly.
// `getMyOrg`'s old `supabase` param is now optional and ignored (the cached
// `getMe` makes its own client).

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

// Request-scoped cached IDENTITY — getUser + profiles, nothing else (2 reads).
// `cache()` memoizes per request, so the first caller in a render pays them ONCE
// and every later caller in the same request gets the same resolved value
// (including `getMe()`, which is layered on top). Falls back to null when signed
// out.
//
// This is the right entry point for route handlers: an API request renders no
// root layout, so there is no earlier caller to share with, and pulling the
// organizations row for a handler that only checks `role` is a wasted round trip.
export const getMeIdentity = cache(async (): Promise<MyIdentity | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .maybeSingle();

  const role = profile?.role ?? "crew";

  return {
    user,
    orgId: (profile?.organization_id as string | null) ?? null,
    role,
    hasProfile: !!profile,
    isSuperAdmin: role === "super_admin",
  };
});

// Request-scoped cached ORGANIZATION row (1 read), keyed by orgId so a request
// that resolves the same org twice pays once. Returns null when the row is
// missing; callers supply their own defaults.
//
// NOTE: this is a SEPARATE query, NOT a PostgREST `organizations(...)` embed on
// the profiles select in getMeIdentity. The embed requires a DECLARED FK
// profiles.organization_id → organizations.id; multi_tenancy_a.sql declares it
// via `add column if not exists ... references` which is a NO-OP when the column
// already existed without the FK — so the FK is NOT reliably declared in the
// live DB, and the embed 400s (PGRST108), which nulled the whole profiles select
// and broke every caller (dashboard showed "no workspace profile", role fell
// back to "crew", billing tab vanished). The separate `.eq("id", orgId)` query
// needs no FK. Re-enable the embed only after `alter table profiles add
// constraint ... foreign key (organization_id) references organizations(id)` is
// confirmed live.
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

// Identity + org/billing (3 reads), composed from the two cached helpers above
// so calling both in one request still does ONE getUser + ONE profiles read.
// Field set is unchanged — every existing page caller keeps working as-is.
// The org read is skipped entirely for super_admin (orgId null).
const NO_ORG: MyOrg = {
  orgName: null,
  plan: null,
  planStatus: null,
  trialEndsAt: null,
  appVariant: "construction",
};

export const getMe = cache(async (): Promise<MyTenant | null> => {
  const id = await getMeIdentity();
  if (!id) return null;
  if (!id.orgId) return { ...id, ...NO_ORG };
  const org = await getOrgRow(id.orgId);
  return { ...id, ...(org ?? NO_ORG) };
});

// Backward-compatible alias over the cached `getMe`. The `supabase` arg is now
// optional + ignored (kept so un-swept callers / other branches don't break).
// Prefer `getMe()` in new code. All in-tree call sites have been migrated.
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