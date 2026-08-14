import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";
import { formatMoney, computeTotal } from "@/lib/money";
import { OFFICE_OR_PM } from "@/lib/roles";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
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
  // Admit office / admin / project_manager / super_admin so every management
  // role can open the list (was office/admin/PM, which bounced super_admin back
  // to /dashboard). Invoice creation stays office/admin/PM (see /invoices/new).
  if (!OFFICE_OR_PM.has(role)) redirect("/dashboard");
  const canCreate =
    role === "office" || role === "admin" || role === "project_manager";

  const statusFilter = params.status ?? "all";

  let query = supabase
    .from("invoices")
    .select(
      "id, status, paid_at, created_at, jobs(name), customers(name), invoice_line_items(quantity, unit_price)"
    )
    .order("created_at", { ascending: false });

  if (statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data: invoices } = await query;

  const rows = (invoices ?? []).map((inv) => {
    const items = (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    return {
      id: inv.id,
      status: inv.status,
      paidAt: inv.paid_at,
      createdAt: inv.created_at,
      jobName: (inv.jobs as unknown as { name: string } | null)?.name ?? "—",
      customerName: (inv.customers as unknown as { name: string } | null)?.name ?? "—",
      total: computeTotal(items),
    };
  });

  const unpaidCount = rows.filter((r) => r.status === "sent").length;

  const filterOptions = [
    { value: "all", label: "All" },
    { value: "sent", label: `Unpaid (${unpaidCount})` },
    { value: "paid", label: "Paid" },
    { value: "void", label: "Void" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Invoices" subtitle={`${rows.length} total`} />

      <main className="max-w-md mx-auto p-4 space-y-4">
        {canCreate && (
          <Link
            href="/invoices/new"
            className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" />
            New Invoice
          </Link>
        )}

        <div className="flex gap-2 overflow-x-auto -mx-4 px-4">
          {filterOptions.map((opt) => (
            <Link
              key={opt.value}
              href={`/invoices?status=${opt.value}`}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium ${
                statusFilter === opt.value
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-200"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        <ClientPullToRefresh>
          {rows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.FileText}
                title="No invoices yet"
                description="Invoices are created when a customer approves an estimate."
              />
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((inv) => (
                <Link
                  key={inv.id}
                  href={`/invoices/${inv.id}`}
                  className="block bg-white rounded-lg p-4 shadow-sm active:bg-gray-50"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">
                        {inv.customerName}
                      </p>
                      <p className="text-sm text-gray-500 truncate">{inv.jobName}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {inv.paidAt
                          ? `Paid ${new Date(inv.paidAt).toLocaleDateString()}`
                          : `Sent ${new Date(inv.createdAt).toLocaleDateString()}`}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <StatusBadge status={inv.status} />
                      <span className="text-sm font-bold text-gray-900">
                        {formatMoney(inv.total)}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </ClientPullToRefresh>
      </main>

    </div>
  );
}