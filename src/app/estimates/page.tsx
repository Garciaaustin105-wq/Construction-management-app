import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import { computeEstimateTotals, formatMoney } from "@/lib/money";
import { PIPELINE, type Role } from "@/lib/roles";
import { FileText } from "lucide-react";
import PageContainer from "@/components/PageContainer";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import EstimatesNewMenu from "@/components/EstimatesNewMenu";
import EstimateTemplatesManager, { type TemplateWithItems } from "@/components/EstimateTemplatesManager";

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
// switcher and forces `view` to always be "cards". Unrelated to the `tab`
// param below (?tab=estimates|templates) — ListToolbar owns `?view=` for its
// own mode switcher, so the two params never collide.
const MODES: ViewMode[] = ["cards"];

export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const tab: "estimates" | "templates" = sp.tab === "templates" ? "templates" : "estimates";

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

  let rows: EstimateView[] = [];
  let templateRows: TemplateWithItems[] = [];

  if (tab === "estimates") {
    const { data: estimates } = await supabase
      .from("estimates")
      .select(
        "id, status, title, created_at, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, jobs(name), customers(name), estimate_line_items(quantity, unit_price)"
      )
      .order("created_at", { ascending: false });

    rows = (estimates as EstimateRow[] | null ?? []).map((e) => {
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
  } else {
    const { data: templateData } = await supabase
      .from("estimate_templates")
      .select(
        "id, name, description, estimate_template_items(description, quantity, unit, unit_price, internal_cost, section, position)"
      )
      .order("name");

    templateRows = (templateData as TemplateWithItems[] | null) ?? [];
  }

  const count = tab === "estimates" ? rows.length : templateRows.length;

  return (
    <PageContainer title="Estimates" subtitle="Cost-coded job pricing & templates" maxWidth="wide">
      {/* Estimates vs Templates — was two separate top-level nav tabs
          ("Estimates" and "Templates"), consolidated into one page since
          Templates is estimate config, not a distinct feature. */}
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          <Link
            href="/estimates"
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "estimates" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            Estimates
          </Link>
          <Link
            href="/estimates?tab=templates"
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "templates" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            Templates
          </Link>
        </div>
      </div>

      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={count}
        action={canCreate ? <EstimatesNewMenu /> : undefined}
      />

      {tab === "estimates" ? (
        rows.length === 0 ? (
          <div className="bg-surface rounded-lg border border-line shadow-sm p-6 text-center">
            <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-900">No estimates yet</p>
            <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
              Build a cost-coded estimate for a job, then preview and send it to
              the customer for approval.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2 lg:hidden">
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
            </div>

            <div className="hidden lg:block rounded-lg border border-line shadow-sm overflow-hidden">
              <div className="grid grid-cols-[1fr_140px_120px_120px_110px] gap-3 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-line">
                <span>Customer / Job</span>
                <span>Estimate #</span>
                <span>Status</span>
                <span className="text-right">Total</span>
                <span>Date</span>
              </div>
              <div className="divide-y divide-line">
                {rows.map((r) => (
                  <Link
                    key={r.id}
                    href={`/estimates/${r.id}`}
                    className="grid grid-cols-[1fr_140px_120px_120px_110px] gap-3 px-4 py-2.5 items-center hover:bg-gray-50 transition-colors"
                  >
                    <span className="min-w-0 truncate font-medium text-gray-900">
                      {r.title || r.jobName}
                    </span>
                    <span className="text-sm text-gray-500 truncate">
                      {r.estimateNumber ?? "—"}
                    </span>
                    <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </StatusBadge>
                    <span className="text-right text-sm font-semibold text-gray-900">
                      {formatMoney(r.total)}
                    </span>
                    <span className="text-sm text-gray-500">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </>
        )
      ) : (
        <EstimateTemplatesManager
          initial={templateRows}
          orgId={me.orgId ?? ""}
        />
      )}
    </PageContainer>
  );
}
