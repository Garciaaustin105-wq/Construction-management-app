import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import SubcontractorsManager, {
  type Subcontractor,
} from "@/components/SubcontractorsManager";

const MANAGEMENT = new Set(["office", "superintendent", "project_manager"]);

export default async function SubcontractorsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!MANAGEMENT.has(role)) redirect("/dashboard");

  const { data } = await supabase
    .from("subcontractors")
    .select("id, company, contact_name, trade, phone, email")
    .order("company");

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Subcontractors" subtitle={role === "office" ? "Directory" : "Read-only"} />
      <main className="max-w-md mx-auto p-4">
        <SubcontractorsManager
          initial={(data as Subcontractor[]) ?? []}
          canEdit={role === "office"}
        />
      </main>
    </div>
  );
}