import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import CustomersManager, {
  type Customer,
} from "@/components/CustomersManager";
import { MANAGEMENT, isSuperAdmin } from "@/lib/roles";

export default async function CustomersPage() {
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
    .from("customers")
    .select("id, name, contact_name, contact_email, phone, address, notes")
    .order("name");

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title="Customers"
        subtitle={
          role === "office" || role === "admin" ? "Directory" : "Read-only"
        }
      />
      <main className="max-w-md mx-auto p-4">
        <CustomersManager
          initial={(data as Customer[]) ?? []}
          canEdit={role === "office" || role === "admin"}
          orgId={orgId}
        />
      </main>
    </div>
  );
}