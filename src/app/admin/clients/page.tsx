import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import ClientManager, {
  type ClientRow,
} from "@/app/admin/clients/ClientManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

// Office Client Portal management — invite customers to the authed client portal
// (magic-link sign-in) and run the bidirectional message inbox. Construction-
// only surface (the lawn deploy 404/redirects it via proxy.ts), gated to office
// / admin / super_admin. Mirrors admin/customers' skeleton.
export default async function ClientsPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role;
  if (!isOfficeLike(role)) redirect("/dashboard");
  // super_admin has no org → no customers to manage here; bounce to platform.
  if (isSuperAdmin(role)) redirect("/admin/orgs");

  // RLS scopes both reads to this org.
  const [custRes, profilesRes] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, contact_name, contact_email, phone")
      .order("name"),
    // A customer is "invited" when a profiles row links to them (role='customer'
    // + customer_id set). We don't expose last_sign_in_at (auth.users, service-
    // role only) in v1 — invited/not-invited is enough to drive the UI.
    supabase
      .from("profiles")
      .select("id, customer_id")
      .eq("role", "customer")
      .not("customer_id", "is", null),
  ]);

  const customers = (custRes.data ?? []) as {
    id: string;
    name: string;
    contact_name: string | null;
    contact_email: string | null;
    phone: string | null;
  }[];
  const invitedIds = new Set(
    ((profilesRes.data ?? []) as { id: string; customer_id: string }[]).map(
      (p) => p.customer_id
    )
  );

  const rows: ClientRow[] = customers.map((c) => ({
    ...c,
    invited: invitedIds.has(c.id),
  }));

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Client Portal" subtitle="Invite customers & reply to messages" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <ClientManager initial={rows} canEdit={role === "office" || role === "admin"} />
      </main>
    </div>
  );
}