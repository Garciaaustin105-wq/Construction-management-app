import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import CostCodesManager from "@/components/CostCodesManager";

export default async function CostCodesPage() {
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
  if ((profile?.role ?? "crew") !== "office") redirect("/dashboard");

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Cost Codes" subtitle="The shared job-costing backbone" />
      <main className="max-w-md mx-auto p-4">
        <CostCodesManager />
      </main>
    </div>
  );
}