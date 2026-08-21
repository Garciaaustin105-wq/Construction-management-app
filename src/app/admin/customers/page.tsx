import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import CustomersManager, {
  type Customer,
} from "@/components/CustomersManager";
import { MANAGEMENT, PIPELINE, ACCOUNTING, isSuperAdmin } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { MessagesSquare } from "lucide-react";

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
  // Admit management + sales (PIPELINE — leads) + accountant (ACCOUNTING — read).
  // super_admin (no org) manages via the platform view, not here. Edit (canEdit)
  // stays office/admin; sales/accountant get the read-only directory below.
  if (
    isSuperAdmin(role) ||
    !(MANAGEMENT.has(role) || PIPELINE.has(role) || ACCOUNTING.has(role))
  )
    redirect("/dashboard");
  const orgId = (profile?.organization_id as string | null) ?? "";

  const { data } = await supabase
    .from("customers")
    .select("id, name, contact_name, contact_email, phone, address, notes")
    .order("name");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title="Customers"
        subtitle={
          role === "office" || role === "admin" ? "Directory" : "Read-only"
        }
      />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-3">
        {/* Client Portal (invite customers to the authed portal + reply to
            their messages) used to be its own top-level nav tab, listing the
            same customers as this page — it read as a duplicate "Customers"
            tab. It's construction-only (the lawn deploy blocks the route),
            so it's linked from here instead, next to the list it shares. */}
        {!isLawn() && (role === "office" || role === "admin") && (
          <Link
            href="/admin/clients"
            className="flex items-center gap-2 bg-white border border-gray-300 text-gray-900 px-4 py-3 rounded-lg font-semibold text-sm active:bg-gray-50"
          >
            <MessagesSquare className="w-4 h-4" />
            Client Portal & Messages
          </Link>
        )}
        <CustomersManager
          initial={(data as Customer[]) ?? []}
          canEdit={role === "office" || role === "admin"}
          orgId={orgId}
        />
      </main>
    </div>
  );
}