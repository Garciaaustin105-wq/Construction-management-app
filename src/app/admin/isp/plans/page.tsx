import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import IspPlansManager from "@/components/IspPlansManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";

export const dynamic = "force-dynamic";

// The org's fiber/ISP plan catalog. Hidden behind organizations.isp_module_enabled
// like the rest of the module — an org without it gets the same /dashboard
// bounce as /installs, and would see nothing anyway because RLS returns no rows.

export default async function IspPlansPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (isSuperAdmin(me.role) || !isOfficeLike(me.role)) redirect("/dashboard");
  if (!me.orgId) redirect("/dashboard");
  if (!(await isIspOrg(me.orgId))) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title="Internet Plans"
        subtitle="The packages you sell to subscribers"
      />
      <main className="max-w-md lg:max-w-3xl mx-auto p-4">
        <IspPlansManager orgId={me.orgId} />
      </main>
    </div>
  );
}
