import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import SubcontractorsManager, {
  type Subcontractor,
} from "@/components/SubcontractorsManager";
import { MANAGEMENT, type Role } from "@/lib/roles";
import { isSuperAdmin } from "@/lib/roles";

export default async function SubcontractorsPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role as Role;
  // super_admin (no org) manages via the platform view, not here.
  if (isSuperAdmin(role) || !MANAGEMENT.has(role)) redirect("/dashboard");
  const orgId = me.orgId ?? "";

  const { data } = await supabase
    .from("subcontractors")
    .select("id, company, contact_name, trade, phone, email")
    .order("company");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Subcontractors" subtitle={role === "superintendent" ? "Read-only" : "Directory"} />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <SubcontractorsManager
          initial={(data as Subcontractor[]) ?? []}
          canEdit={role === "office" || role === "admin" || role === "project_manager"}
          orgId={orgId}
        />
      </main>
    </div>
  );
}