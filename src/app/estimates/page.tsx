import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import { computeEstimateTotals, formatMoney } from "@/lib/money";
import { PIPELINE, type Role } from "@/lib/roles";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";

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
  // — see /estimates/new gate. Was office/admin only, which locked PM out of
  // authoring (a PM-discrepancy bug) and excluded sales.
  const canCreate = PIPELINE.has(role);

  const { data: estimates } = await supabase
    .from("estimates")
    .select(
      "id, status, title, created_at, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, jobs(name), customers(name), estimate_line_items(quantity, unit_price)"
    )
    .order("created_at", { ascending: false });

  const rows = (estimates as EstimateRow[] | null ?? []).map((e) => {
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
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Estimates" subtitle="Cost-coded job pricing" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        {canCreate && (
          <Link
            href="/estimates/new"
            className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" />
            New Estimate
          </Link>
        )}

        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center">
            <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No estimates yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
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
                className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {r.title || r.jobName}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {r.estimateNumber ? `${r.estimateNumber} · ` : ""}
                      {r.title ? `${r.jobName} · ` : ""}
                      {new Date(r.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    <span className="text-sm font-semibold text-gray-900">
                      {formatMoney(r.total)}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}