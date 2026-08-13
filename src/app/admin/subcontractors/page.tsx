import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import SubcontractorsManager, {
  type Subcontractor,
} from "@/components/SubcontractorsManager";
import { MANAGEMENT } from "@/lib/roles";
import { isSuperAdmin } from "@/lib/roles";

export default async function SubcontractorsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  // super_admin (no org) manages via the platform view, not here.
  if (isSuperAdmin(role) || !MANAGEMENT.has(role)) redirect("/dashboard");
  const orgId = (profile?.organization_id as string | null) ?? "";

  const { data } = await supabase
    .from("subcontractors")
    .select("id, company, contact_name, trade, phone, email")
    .order("company");

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Subcontractors" subtitle={role === "superintendent" ? "Read-only" : "Directory"} />
      <main className="max-w-md mx-auto p-4">
        <SubcontractorsManager
          initial={(data as Subcontractor[]) ?? []}
          canEdit={role === "office" || role === "admin" || role === "project_manager"}
          orgId={orgId}
        />
      </main>
    </div>
  );
}