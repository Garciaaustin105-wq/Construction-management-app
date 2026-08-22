import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
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
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Cost Codes" subtitle="The shared job-costing backbone" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <CostCodesManager orgId={orgId} />
      </main>
    </div>
  );
}