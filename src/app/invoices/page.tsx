import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { formatMoney, computeTotal } from "@/lib/money";
import { OFFICE_OR_PM, ACCOUNTING, type Role } from "@/lib/roles";
import Link from "next/link";
import { Plus } from "lucide-react";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";

const STATUS_TONE: { [key: string]: BadgeTone } = {
  sent: "brand",
  paid: "success",
  void: "muted",
  draft: "neutral",
};

const STATUS_LABEL: { [key: string]: string } = {
  sent: "Unpaid",
  paid: "Paid",
  void: "Void",
  draft: "Draft",
};

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
          <>
            <div className="space-y-2 lg:hidden">
              {rows.map((inv) => (
                <Link
                  key={inv.id}
                  href={`/invoices/${inv.id}`}
                  className="block bg-surface rounded-lg border border-line shadow-sm p-4 active:bg-gray-50"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">{inv.customerName}</p>
                      <p className="text-sm text-gray-500 truncate">{inv.jobName}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {inv.status === "draft"
                          ? `Created ${new Date(inv.createdAt).toLocaleDateString()}`
                          : inv.paidAt
                          ? `Paid ${new Date(inv.paidAt).toLocaleDateString()}`
                          : `Sent ${new Date(inv.createdAt).toLocaleDateString()}`}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <StatusBadge tone={STATUS_TONE[inv.status] ?? "neutral"}>{STATUS_LABEL[inv.status] ?? inv.status}</StatusBadge>
                      <span className="text-sm font-bold text-gray-900">{formatMoney(inv.total)}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            <div className="hidden lg:block rounded-lg border border-line shadow-sm overflow-hidden">
              <div className="grid grid-cols-[1fr_1fr_120px_120px_130px] gap-3 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-line">
                <span>Customer</span>
                <span>Job</span>
                <span>Status</span>
                <span className="text-right">Total</span>
                <span>Date</span>
              </div>
              <div className="divide-y divide-line">
                {rows.map((inv) => (
                  <Link
                    key={inv.id}
                    href={`/invoices/${inv.id}`}
                    className="grid grid-cols-[1fr_1fr_120px_120px_130px] gap-3 px-4 py-2.5 items-center hover:bg-gray-50 transition-colors"
                  >
                    <span className="min-w-0 truncate font-medium text-gray-900">{inv.customerName}</span>
                    <span className="min-w-0 truncate text-sm text-gray-500">{inv.jobName}</span>
                    <StatusBadge tone={STATUS_TONE[inv.status] ?? "neutral"}>{STATUS_LABEL[inv.status] ?? inv.status}</StatusBadge>
                    <span className="text-right text-sm font-semibold text-gray-900">{formatMoney(inv.total)}</span>
                    <span className="text-sm text-gray-500">
                      {inv.status === "draft"
                        ? new Date(inv.createdAt).toLocaleDateString()
                        : inv.paidAt
                        ? new Date(inv.paidAt).toLocaleDateString()
                        : new Date(inv.createdAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}
      </ClientPullToRefresh>
    </PageContainer>
  );
}