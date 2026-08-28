import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import { computeEstimateTotals, formatMoney } from "@/lib/money";
import { PIPELINE, type Role } from "@/lib/roles";
import { FileText, Plus, Zap } from "lucide-react";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";

type EstimateRow = {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  estimate_number: string | null;
  markup_pct: number;
  contingency_pct: number;
  tax_pct: number;
  deposit_pct: number;
  deposit_amount: number;
  jobs: { name: string } | null;
  customers: { name: string | null } | null;
  estimate_line_items: { quantity: number; unit_price: number }[];
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  converted: "Converted",
  rejected: "Rejected",
};

// Status → badge tone. Domain-specific to estimates (invoice/job/daily-log
// pages own their own map) — kept here next to the label map it pairs with.
const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  sent: "brand",
  approved: "success",
  converted: "success",
  rejected: "danger",
};

type EstimateView = {
  id: string;
  status: string;
  title: string | null;
  estimateNumber: string | null;
  jobName: string;
  createdAt: string;
  total: number;
};

// Cards only — the Cards/Table switcher was a no-op (table just rendered the
// same rows as plain line items). Single-element MODES hides the ListToolbar
// switcher and forces `view` to always be "cards".
const MODES: ViewMode[] = ["cards"];

export default async function EstimatesPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role as Role;
  // Admit the sales pipeline: sales + PM + office + admin + super_admin
  // (PIPELINE). sales is the dedicated pre-sale/estimator role; PM/office
  // already author estimates. Was OFFICE_OR_PM, which bounced sales.
  if (!PIPELINE.has(role)) redirect("/dashboard");
  // Estimate creation: the whole pipeline set (sales/PM/office/admin/super_admin)
  const canCreate = PIPELINE.has(role);

  const { data: estimates } = await supabase
    .from("estimates")
    .select(
      "id, status, title, created_at, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, jobs(name), customers(name), estimate_line_items(quantity, unit_price)"
    )
    .order("created_at", { ascending: false });

  const rows: EstimateView[] = (estimates as EstimateRow[] | null ?? []).map((e) => {
    const items = (e.estimate_line_items as { quantity: number; unit_price: number }[]) ?? [];
    const totals = computeEstimateTotals(items, {
      markupPct: Number(e.markup_pct) || 0,
      contingencyPct: Number(e.contingency_pct) || 0,
      taxPct: Number(e.tax_pct) || 0,
      depositPct: Number(e.deposit_pct) || 0,
      depositAmount: Number(e.deposit_amount) || 0,
    });
    const hasPricing =
      totals.markupAmount > 0 ||
      totals.contingencyAmount > 0 ||
      totals.taxAmount > 0 ||
      totals.depositAmount > 0;
    return {
      id: e.id,
      status: e.status,
      title: e.title,
      estimateNumber: e.estimate_number,
      // Standalone (job-less) estimates fall back to the customer name.
      jobName: e.jobs?.name ?? e.customers?.name ?? "—",
      createdAt: e.created_at,
      total: hasPricing ? totals.grandTotal : totals.subtotal,
    };
  });

  return (
    <PageContainer title="Estimates" subtitle="Cost-coded job pricing" maxWidth="list">
      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={rows.length}
        action={
          canCreate ? (
            <div className="flex items-center gap-2">
              {/* Speed-to-quote path: customer + lines on one screen. */}
              <LinkButton href="/estimates/quick" variant="secondary">
                <Zap className="w-4 h-4" />
                Measure &amp; quote
              </LinkButton>
              <LinkButton href="/estimates/new">
                <Plus className="w-4 h-4" />
                New
              </LinkButton>
            </div>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line shadow-sm p-6 text-center">
          <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-900">No estimates yet</p>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
            Build a cost-coded estimate for a job, then preview and send it to
            the customer for approval.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/estimates/${r.id}`}
              className="block bg-surface rounded-lg border border-line shadow-sm p-3 active:bg-gray-50"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate">
                    {r.title || r.jobName}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {r.estimateNumber ? `${r.estimateNumber} · ` : ""}
                    {r.title ? `${r.jobName} · ` : ""}
                    {new Date(r.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </StatusBadge>
                  <span className="text-sm font-semibold text-gray-900">
                    {formatMoney(r.total)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageContainer>
  );
}