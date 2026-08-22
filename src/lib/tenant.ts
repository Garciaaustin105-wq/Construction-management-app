// Server-side tenant + identity helper. `getMe()` is the single request-scoped
// source of truth for the signed-in caller (user, role, org, billing), cached
// via React's `cache()` so the root layout, every server page, and every route
// handler in ONE request share ONE `getUser()` + ONE `profiles`/`organizations`
// read instead of each re-fetching. This is the Tier 1 perf fix: it collapses
// the duplicate `auth.getUser()` (proxy → layout → page → getMyOrg was up to
// 4×) and the per-page `profiles` re-read across ~90 call sites.
//
// `getMyOrg` / `requireOrgScoped` are kept as backward-compatible thin wrappers
// over `getMe` so existing call sites keep working during the sweep; new code
// should call `getMe()` directly. `getMyOrg`'s old `supabase` param is now
// optional and ignored (the cached `getMe` makes its own client).

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

export type MyTenant = {
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
  // The caller's org display name (from the same embed; null for super_admin).
  // Folded in so pages that show the workspace name (dashboard, TopBar) don't
  // each re-query organizations.
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

// Request-scoped cached identity. `cache()` memoizes per request, so the first
// caller in a render pays the 1 getUser + 1 (profiles ⋈ organizations) hop and
// every later caller in the same request gets the same resolved value. The
// `organizations` embed (PostgREST) collapses the old separate profiles +
// organizations round trips into one. Falls back to null when signed out.
export const getMe = cache(async (): Promise<MyTenant | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "role, organization_id, organizations(name, plan, plan_status, trial_ends_at, app_variant)"
    )
    .eq("id", user.id)
    .maybeSingle();

  const role = profile?.role ?? "crew";
  const hasProfile = !!profile;
  const orgId = (profile?.organization_id as string | null) ?? null;
  // PostgREST returns embeds as arrays; a many-to-one (one org per profile) is
  // a 0- or 1-element array. Take the first, if any.
  const org = (profile?.organizations as
    | { name: string | null; plan: string | null; plan_status: string | null; trial_ends_at: string | null; app_variant: string | null }[]
    | null)?.[0] ?? null;

  return {
    user,
    orgId,
    role,
    hasProfile,
    isSuperAdmin: role === "super_admin",
    orgName: org?.name ?? null,
    plan: org?.plan ?? null,
    planStatus: org?.plan_status ?? null,
    trialEndsAt: org?.trial_ends_at ?? null,
    appVariant: org?.app_variant === "lawn" ? "lawn" : "construction",
  };
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