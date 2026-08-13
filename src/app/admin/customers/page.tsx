import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import { Building2, Phone, Mail } from "lucide-react";
import { MANAGEMENT } from "@/lib/roles";

export default async function CustomersPage() {
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
    .from("customers")
    .select("id, name, contact_name, contact_email, phone")
    .order("name");

  const customers = (data ?? []) as {
    id: string;
    name: string;
    contact_name: string | null;
    contact_email: string | null;
    phone: string | null;
  }[];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title="Customers"
        subtitle={role === "office" || role === "admin" ? "Directory" : "Read-only"}
      />
      <main className="max-w-md mx-auto p-4">
        <div className="space-y-2">
          {customers.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-6">
              No customers yet.
            </p>
          )}
          {customers.map((c) => (
            <Link
              key={c.id}
              href={`/admin/customers/${c.id}`}
              className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
            >
              <p className="font-semibold text-gray-900 truncate flex items-center gap-1">
                <Building2 className="w-4 h-4 text-gray-400 flex-shrink-0" />
                {c.name}
              </p>
              {c.contact_name && (
                <p className="text-xs text-gray-500 truncate">{c.contact_name}</p>
              )}
              <div className="flex flex-col gap-0.5 mt-1">
                {c.phone && (
                  <span className="text-xs text-gray-600 inline-flex items-center gap-1">
                    <Phone className="w-3 h-3" /> {c.phone}
                  </span>
                )}
                {c.contact_email && (
                  <span className="text-xs text-gray-600 inline-flex items-center gap-1 truncate">
                    <Mail className="w-3 h-3" /> {c.contact_email}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}