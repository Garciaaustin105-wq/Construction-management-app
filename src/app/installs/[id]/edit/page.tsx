import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect, notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import { OFFICE_LIKE, type Role } from "@/lib/roles";
import EditInstallForm from "@/components/EditInstallForm";

// Edit an existing install. Office / admin / PM only — the same audience that
// can create one. Crew never reach this page; their writes go through the
// field RPCs, which touch only status/time/notes/materials.
export const dynamic = "force-dynamic";

type Install = {
  id: string;
  job_id: string | null;
  customer_id: string | null;
  install_type_id: string | null;
  title: string;
  status: string;
  price: number | string | null;
  address: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  assigned_crew: string[] | null;
  notes: string | null;
};

export default async function EditInstallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role as Role;
  if (!(OFFICE_LIKE.has(role) || role === "project_manager"))
    redirect(`/installs/${id}`);

  const [installRes, typesRes, customersRes, jobsRes, crewRes] =
    await Promise.all([
      supabase
        .from("installs")
        .select(
          "id, job_id, customer_id, install_type_id, title, status, price, address, scheduled_at, duration_minutes, assigned_crew, notes"
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("install_types")
        .select("id, name, active")
        .order("position"),
      supabase.from("customers").select("id, name").order("name"),
      supabase
        .from("jobs")
        .select("id, name")
        .eq("type", "construction")
        .order("name"),
      supabase
        .from("profiles")
        .select("id, full_name, email, role")
        .in("role", ["crew", "superintendent"])
        .order("full_name"),
    ]);

  if (!installRes.data) notFound();
  const install = installRes.data as unknown as Install;

  // Retired types are still offered when THIS install already uses one —
  // otherwise opening the form would silently blank out its type on save.
  const types = (typesRes.data ?? []) as {
    id: string;
    name: string;
    active: boolean;
  }[];
  const selectableTypes = types.filter(
    (t) => t.active || t.id === install.install_type_id
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Edit Install" subtitle={install.title} />
      <main className="max-w-md lg:max-w-3xl mx-auto p-4">
        <EditInstallForm
          install={install}
          installTypes={selectableTypes}
          customers={(customersRes.data ?? []) as { id: string; name: string }[]}
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
