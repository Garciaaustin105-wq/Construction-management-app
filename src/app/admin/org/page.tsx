import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import OrgSettingsForm from "./OrgSettingsForm";
import { getMe } from "@/lib/tenant";

// Org business-info settings. admin edits their own org; super_admin opens any
// org READ-ONLY (via ?org=<id>) — super_admin cannot mutate org identity (see
// super_admin_readonly_orgs.sql + the /api/org admin-only gate).
export default async function OrgSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) redirect("/login");

  const isSuperAdmin = tenant.isSuperAdmin;
  if (tenant.role !== "admin" && !isSuperAdmin) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  let targetOrgId: string;
  if (isSuperAdmin && params.org) {
    targetOrgId = params.org;
  } else if (tenant.orgId) {
    targetOrgId = tenant.orgId;
  } else {
    redirect("/dashboard");
  }

  const { data: orgRow } = await supabase
    .from("organizations")
    .select(
      "id, name, address, phone, email, logo_path, default_labor_rate, default_labor_cost_rate, default_mobilization_hours"
    )
    .eq("id", targetOrgId)
    .single();

  if (!orgRow) redirect("/dashboard");

  // Only the org's own admin may edit. super_admin opens the page read-only
  // (platform overview; org identity is not super_admin-mutable).
  const canEdit = tenant.role === "admin";

  // Landscape labor defaults are lawn-only. Resolved here from the cached
  // tenant read rather than looked up in the client.
  return (
    <OrgSettingsForm
      org={orgRow}
      canEdit={canEdit}
      isLawn={tenant.appVariant === "lawn"}
    />
  );
}