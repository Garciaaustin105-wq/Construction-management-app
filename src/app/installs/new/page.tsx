import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import { OFFICE_LIKE, type Role } from "@/lib/roles";
import NewInstallForm from "@/components/NewInstallForm";
import { type CustomerOption } from "@/lib/installs";

// Create an install. Office / admin / PM only — crew never author installs,
// they only record field activity on ones assigned to them.
export const dynamic = "force-dynamic";

export default async function NewInstallPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role as Role;
  if (!(OFFICE_LIKE.has(role) || role === "project_manager")) redirect("/installs");
  if (!me.orgId) redirect("/dashboard");

  const { data: org } = await supabase
    .from("organizations")
    .select("isp_module_enabled")
    .eq("id", me.orgId)
    .maybeSingle();
  if (!org?.isp_module_enabled) redirect("/dashboard");

  // Everything the form needs, in parallel — same convention as the other
  // /new pages in this app (submittals, change-orders, punch).
  const [typesRes, customersRes, jobsRes, crewRes] = await Promise.all([
    supabase
      .from("install_types")
      .select("id, name")
      .eq("active", true)
      .order("position"),
    supabase
      .from("customers")
      .select(
        "id, name, contact_name, contact_email, phone, address, service_plan"
      )
      .order("name"),
    supabase
      .from("jobs")
      .select("id, name")
      .eq("type", "construction")
      .order("name"),
    // Assignable field staff. Mirrors JobAssignment's audience.
    supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .in("role", ["crew", "superintendent"])
      .order("full_name"),
  ]);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="New Install" subtitle="Schedule a fiber install or service call" />
      <main className="max-w-md lg:max-w-3xl mx-auto p-4">
        <NewInstallForm
          orgId={me.orgId}
          installTypes={(typesRes.data ?? []) as { id: string; name: string }[]}
          customers={(customersRes.data ?? []) as CustomerOption[]}
          jobs={(jobsRes.data ?? []) as { id: string; name: string }[]}
          crew={
            (crewRes.data ?? []) as {
              id: string;
              full_name: string | null;
              email: string;
              role: string;
            }[]
          }
        />
      </main>
    </div>
  );
}
