import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { computeTotal } from "@/lib/money";
import { OFFICE_OR_PM, ACCOUNTING, type Role } from "@/lib/roles";
import Link from "next/link";
import { Plus } from "lucide-react";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import InvoicesList from "@/components/invoices/InvoicesList";

// Cards only — the Cards/Table switcher was a no-op (table just rendered the
// same rows as plain line items, no reorganization), so the choice is removed
// and every list stays in the polished card view. A single-element MODES also
// hides the ListToolbar switcher (it only renders when modes.length > 1) and
// forces `view` to always resolve to "cards" (MODES.includes("table") is false),
// so even a bookmarked ?view=table URL renders cards.
const MODES: ViewMode[] = ["cards"];

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role as Role;
  if (!(OFFICE_OR_PM.has(role) || ACCOUNTING.has(role))) redirect("/dashboard");
  const canCreate = role === "office" || role === "admin" || role === "project_manager";
  const statusFilter = sp.status ?? "all";
  let query = supabase.from("invoices").select("id, status, paid_at, created_at, amount_paid, jobs(name), customers(name), invoice_line_items(quantity, unit_price)").order("created_at", { ascending: false });
  if (statusFilter !== "all") query = query.eq("status", statusFilter);
  const { data: invoices } = await query;
  const rows = (invoices ?? []).map((inv) => {
    const items = (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    const invTotal = computeTotal(items);
    const amountPaid = Number((inv as { amount_paid?: number | null }).amount_paid ?? 0) || 0;
    return {
      id: inv.id, status: inv.status, paidAt: inv.paid_at, createdAt: inv.created_at,
      jobName: (inv.jobs as unknown as { name: string } | null)?.name ?? "Standalone",
      customerName: (inv.customers as unknown as { name: string } | null)?.name ?? "—",
      total: inv.status === "sent" && amountPaid > 0 ? Math.max(0, invTotal - amountPaid) : invTotal,
      depositApplied: inv.status === "sent" && amountPaid > 0,
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
    <PageContainer title="Invoices" subtitle={`${rows.length} total`} maxWidth="wide">
      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={rows.length}
        action={canCreate ? <LinkButton href="/invoices/new"><Plus className="w-4 h-4" />New Invoice</LinkButton> : undefined}
        filters={filterOptions.map((opt) => (
          <Link
            key={opt.value}
            href={`/invoices?status=${opt.value}`}
            className={`px-3 py-1 rounded-full ${opt.value === statusFilter ? "bg-blue-600 text-white" : "bg-white text-gray-700 border border-gray-200"}`}
          >
            {opt.label}
          </Link>
        ))}
      />
      <ClientPullToRefresh>
        {rows.length === 0 ? (
          <div className="bg-surface rounded-lg border border-line shadow-sm">
            <EmptyState
              icon={EmptyIcons.FileText}
              title="No invoices yet"
              description="Invoices are created when a customer approves an estimate."
            />
          </div>
        ) : (
          <InvoicesList rows={rows} />
        )}
      </ClientPullToRefresh>
    </PageContainer>
  );
}