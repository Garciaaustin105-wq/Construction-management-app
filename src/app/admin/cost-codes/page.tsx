import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import CostCodesManager from "@/components/CostCodesManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

export default async function CostCodesPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role;
  // office + admin manage the code library; super_admin (no org) uses the
  // platform view instead.
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");
  const orgId = me.orgId ?? "";

  return (
    <PageContainer title="Cost Codes" subtitle="The shared job-costing backbone" maxWidth="list">
      <CostCodesManager orgId={orgId} />
    </PageContainer>
  );
}