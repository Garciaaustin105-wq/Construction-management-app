import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import CostCodesManager from "@/components/CostCodesManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

export default async function CostCodesPage() {
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
  // office + admin manage the code library; super_admin (no org) uses the
  // platform view instead.
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");
  const orgId = (profile?.organization_id as string | null) ?? "";

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Cost Codes" subtitle="The shared job-costing backbone" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <CostCodesManager orgId={orgId} />
      </main>
    </div>
  );
}