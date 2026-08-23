import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import CustomersManager, {
  type Customer,
} from "@/components/CustomersManager";
import { MANAGEMENT, PIPELINE, ACCOUNTING, isSuperAdmin, type Role } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { getBusinessTypes } from "@/lib/businessTypes.server";
import { MessagesSquare } from "lucide-react";

export default async function CustomersPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role as Role;
  // super_admin (no org) manages via the platform view, not here.
  // Admit management + sales (PIPELINE — leads) + accountant (ACCOUNTING — read).
  // super_admin (no org) manages via the platform view, not here. Edit (canEdit)
  // stays office/admin; sales/accountant get the read-only directory below.
  if (
    isSuperAdmin(role) ||
    !(MANAGEMENT.has(role) || PIPELINE.has(role) || ACCOUNTING.has(role))
  )
    redirect("/dashboard");
  const orgId = me.orgId ?? "";

  // Gap 2: an ISP-ONLY org has no construction clients, so the Client Portal
  // (authed customer accounts + threaded messages, built for construction) is
  // noise on their busiest screen — and worse, it advertises a subscriber login
  // that ISP customers deliberately do not get.
  //
  // "ISP-only" is the precise test, not "has ISP": Terra Vista is
  // construction + isp and still runs real construction clients through the
  // portal, so hiding it from them would remove a feature they use. An org with
  // NO declared types (business_types.sql not yet run) falls through to the
  // existing behaviour rather than losing the link.
  const businessTypes = await getBusinessTypes(me.orgId);
  const ispOnly =
    businessTypes.length > 0 && businessTypes.every((t) => t === "isp");

  const { data } = await supabase
    .from("customers")
    .select("id, name, contact_name, contact_email, phone, address, service_plan, notes")
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
        {!isLawn() && !ispOnly && (role === "office" || role === "admin") && (
          <Link
            href="/admin/clients"
            className="flex items-center gap-2 bg-white border border-gray-300 text-gray-900 px-4 py-3 rounded-lg font-semibold text-sm active:bg-gray-50"
          >
            <MessagesSquare className="w-4 h-4" />
            Client Portal & Messages
          </Link>
        )}
        {/* CustomersManager reads ?add=1 via useSearchParams (the dashboard's
            "Add customer" deep link), which requires a Suspense boundary. */}
        <Suspense fallback={null}>
          <CustomersManager
            initial={(data as Customer[]) ?? []}
            canEdit={role === "office" || role === "admin"}
            orgId={orgId}
          />
        </Suspense>
      </main>
    </div>
  );
}