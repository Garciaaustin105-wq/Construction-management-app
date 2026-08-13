// Server-side tenant helper: fetches the signed-in user's organization_id +
// role in one round-trip. Used by server pages/routes that need the caller's
// org to (a) set organization_id on a root-table insert, or (b) do an
// explicit org-match check on a service-role write (service-role writes bypass
// RLS `with check`, so the app must enforce the org boundary itself — see the
// multi-tenancy plan, "service-role writes bypass RLS with check").

import type { SupabaseClient } from "@supabase/supabase-js";

export type MyTenant = {
  orgId: string | null; // null for super_admin (platform, no org)
  role: string; // falls back to "crew" when the profile row is missing
  isSuperAdmin: boolean;
};

export async function getMyOrg(
  supabase: SupabaseClient
): Promise<MyTenant | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "crew";
  const orgId = (profile?.organization_id as string | null) ?? null;
  return {
    orgId,
    role,
    isSuperAdmin: role === "super_admin",
  };
}

// Require an org-scoped (non-platform) caller. Returns the caller's tenant or
// a 403-style sentinel. Use for root-table inserts where a null org
// (super_admin without a target org) is not allowed.
export async function requireOrgScoped(
  supabase: SupabaseClient
): Promise<{ ok: true; tenant: MyTenant } | { ok: false; status: number; error: string }> {
  const tenant = await getMyOrg(supabase);
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