import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import OrgSettingsForm from "./OrgSettingsForm";
import { getMyOrg } from "@/lib/tenant";

// Org business-info settings. admin edits their own org; super_admin opens any
// org READ-ONLY (via ?org=<id>) — super_admin cannot mutate org identity (see
// super_admin_readonly_orgs.sql + the /api/org admin-only gate).
export default async function OrgSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenant = await getMyOrg(supabase);
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
    .select("id, name, address, phone, email, logo_path")
    .eq("id", targetOrgId)
    .single();

  if (!orgRow) redirect("/dashboard");

  // Only the org's own admin may edit. super_admin opens the page read-only
  // (platform overview; org identity is not super_admin-mutable).
  const canEdit = tenant.role === "admin";

  return <OrgSettingsForm org={orgRow} canEdit={canEdit} />;
}