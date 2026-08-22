import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { MANAGEMENT, ACCOUNTING, PIPELINE } from "@/lib/roles";
import { isConstruction } from "@/lib/variant";
import { getMe, type MyTenant } from "@/lib/tenant";
import { getOrgBilling } from "@/lib/billing";
import { formatMoney } from "@/lib/money";
import { startOfWeek, addDays, toISODate, hoursFromMs } from "@/lib/weekUtils";
import TopBar from "@/components/TopBar";
import KpiTile from "@/components/charts/KpiTile";
import BarChart, { type BarDatum } from "@/components/charts/BarChart";
import {
  invoiceTotal,
  invoiceBalance,
  arAgingBuckets,
  overdueTotal,
  salesPipeline,
  collectedThisMonth,
  crewHoursByWorker,
  jobProfitability,
  monthBuckets,
  monthKey,
} from "@/lib/insights";
import {
  Receipt,
  AlertTriangle,
  DollarSign,
  FileText,
  Briefcase,
  Clock,
  GitBranch,
  TrendingUp,
  ArrowLeft,
  Sparkles,
} from "lucide-react";

// /admin/insights — construction command center. The differentiator that keeps
// the contractor on our platform after the payments pivot handed bookkeeping
// off to their own QuickBooks/Xero/FreshBooks: the books live in the provider,
// but the INSIGHTS (job profitability, AR aging, pipeline, crew productivity)
// live HERE because we hold both sides (revenue via invoices, cost via
// time_entries/materials/change_orders). Office/admin/PM/super_admin only
// (PMs run jobs, so they're admitted — mirrors /admin/reports). Construction
// variant only; lawn has its own /lawn/insights.
//
// Every read uses the RLS session client (createClient) — auto org-scoped, no
// manual organization_id filter, no service role, so it can never cross
// tenants and never trips 42P17. All aggregation is in JS over fetched rows
// (matches the established JobBudget.tsx / reports pattern). No new SQL. No
// "use client". Charts are hand-rolled SVG (no chart library).

// ---- row shapes (the nested selects) ---------------------------------------
type InvoiceRow = {
  id: string;
  status: string;
  paid_at: string | null;
  due_date: string | null;
  amount_paid: number | null;
  created_at: string;
  customer_id: string | null;
  job_id: string | null;
  customers: { name: string | null } | null;
  invoice_line_items: { quantity: number; unit_price: number }[];
};
type EstimateRow = {
  id: string;
  status: string;
  job_id: string;
  created_at: string;
  markup_pct: number | null;
  contingency_pct: number | null;
  tax_pct: number | null;
  deposit_pct: number | null;
  deposit_amount: number | null;
  estimate_line_items: { quantity: number; unit_price: number; internal_cost: number | null }[];
};
type JobRow = {
  id: string;
  name: string;
  status: string | null;
  customer_id: string | null;
  labor_rate: number | null;
  customers: { name: string | null } | null;
};
type TimeRow = {
  id: string;
  job_id: string;
  clock_in_at: string;
  clock_out_at: string;
  user_id: string;
  user: { id: string; full_name: string | null } | null;
};
type ReceiptRow = { id: string; job_id: string; amount: number | null };
type ChangeOrderRow = {
  id: string;
  job_id: string;
  title: string;
  amount: number | null;
  is_credit: boolean | null;
  status: string;
  created_at: string;
};

export default async function ConstructionInsightsPage() {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant: MyTenant | null = await getMe();
  if (!tenant) redirect("/login");
  // Insights = the broad read surface: management (office/admin/super/PM) +
  // accountant (read-only financials) + sales (pipeline). Crew/customer bounce.
  if (
    !(
      MANAGEMENT.has(tenant.role as never) ||
      ACCOUNTING.has(tenant.role as never) ||
      PIPELINE.has(tenant.role as never)
    )
  )
    redirect("/dashboard");
  // Construction-only page — lawn has its own /lawn/insights.
  if (!isConstruction()) redirect("/lawn/insights");

  const now = new Date();
  const todayISO = toISODate(now);
  const thisWeekStart = startOfWeek(now);
  const weekEnd = addDays(thisWeekStart, 7);
  const currentMonthKey = monthKey(now);
  const months = monthBuckets(12);
  const thirteenMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString();

  // Stage 1: construction jobs (the anchor set). Every downstream read is
  // filtered by job_id IN this set, so lawn invoices/estimates/time/receipts
  // (which carry lawn job_ids) are excluded automatically.
  const { data: jobsData } = await supabase
    .from("jobs")
    .select("id, name, status, customer_id, labor_rate, customers(name)")
    .eq("type", "construction")
    .order("name");
  const jobs = (jobsData as unknown as JobRow[]) ?? [];

  const jobIds = jobs.map((j) => j.id);

  // No construction jobs yet → render the empty state without fanning out
  // (an empty `.in()` filter is undefined behavior in PostgREST).
  if (jobIds.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
        <TopBar title="Insights" subtitle="Construction command center" />
        <main className="max-w-md lg:max-w-6xl mx-auto p-4 space-y-4">
          <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-blue-700 font-semibold">
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </Link>
          <div className="bg-white rounded-lg p-8 shadow-sm text-center">
            <Briefcase className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No construction jobs yet.</p>
            <p className="text-xs text-gray-400 mt-1">
              Insights appear once you have jobs with estimates, invoices, or crew time.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const [invoicesRes, estimatesRes, timeRes, receiptsRes, changeOrdersRes, billing] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "id, status, paid_at, due_date, amount_paid, created_at, customer_id, job_id, customers(name), invoice_line_items(quantity, unit_price)"
      )
      .in("job_id", jobIds)
      .gte("created_at", thirteenMonthsAgo),
    supabase
      .from("estimates")
      .select(
        "id, status, job_id, created_at, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, estimate_line_items(quantity, unit_price, internal_cost)"
      )
      .in("job_id", jobIds),
    // All closed time entries for construction jobs (no date bound) — feeds
    // both per-job actual labor cost (profitability) and the weekly crew chart
    // (filtered in JS). Bounded by job count; phase-2 SECURITY DEFINER rollup
    // if volume ever demands it.
    supabase
      .from("time_entries")
      .select("id, job_id, clock_in_at, clock_out_at, user_id, user:profiles(id, full_name)")
      .in("job_id", jobIds)
      .not("clock_out_at", "is", null),
    supabase.from("receipts").select("id, job_id, amount").in("job_id", jobIds),
    supabase
      .from("change_orders")
      .select("id, job_id, title, amount, is_credit, status, created_at")
      .in("job_id", jobIds),
    getOrgBilling(supabase, tenant.orgId!),
  ]);

  const invoices = (invoicesRes.data as unknown as InvoiceRow[]) ?? [];
  const estimates = (estimatesRes.data as unknown as EstimateRow[]) ?? [];
  const times = (timeRes.data as unknown as TimeRow[]) ?? [];
  const receipts = (receiptsRes.data as unknown as ReceiptRow[]) ?? [];
  const changeOrders = (changeOrdersRes.data as unknown as ChangeOrderRow[]) ?? [];

  // ---- group job-anchored rows by job_id ------------------------------------
  const estByJob = new Map<string, EstimateRow>();
  for (const e of estimates) {
    const ex = estByJob.get(e.job_id);
    if (!ex || e.created_at > ex.created_at) estByJob.set(e.job_id, e);
  }
  const approvedCOsByJob = new Map<string, { amount: number | null; is_credit: boolean | null }[]>();
  const openCOs: ChangeOrderRow[] = [];
  for (const co of changeOrders) {
    if (co.status === "approved") {
      const arr = approvedCOsByJob.get(co.job_id) ?? [];
      arr.push({ amount: co.amount, is_credit: co.is_credit });
      approvedCOsByJob.set(co.job_id, arr);
    } else if (co.status === "draft" || co.status === "submitted" || co.status === "sent") {
      openCOs.push(co);
    }
  }
  const timesByJob = new Map<string, TimeRow[]>();
  for (const t of times) {
    const arr = timesByJob.get(t.job_id) ?? [];
    arr.push(t);
    timesByJob.set(t.job_id, arr);
  }
  const receiptsByJob = new Map<string, ReceiptRow[]>();
  for (const r of receipts) {
    const arr = receiptsByJob.get(r.job_id) ?? [];
    arr.push(r);
    receiptsByJob.set(r.job_id, arr);
  }

  // ---- per-job profitability (the headline) ---------------------------------
  type ProfitRow = {
    job: JobRow;
    p: ReturnType<typeof jobProfitability>;
  };
  const profitRows: ProfitRow[] = [];
  for (const job of jobs) {
    const p = jobProfitability({
      estimate: estByJob.get(job.id) ?? null,
      changeOrdersApproved: approvedCOsByJob.get(job.id) ?? [],
      timeEntries: timesByJob.get(job.id) ?? [],
      receipts: receiptsByJob.get(job.id) ?? [],
      laborRate: job.labor_rate,
    });
    if (!p.hasEstimate) continue; // no contract value → not in the table
    profitRows.push({ job, p });
  }
  profitRows.sort((a, b) => b.p.projectedMargin - a.p.projectedMargin);

  const totalContractValue = profitRows.reduce((s, r) => s + r.p.contractValue, 0);
  const totalProjectedMargin = profitRows.reduce((s, r) => s + r.p.projectedMargin, 0);
  const projectedGrossMarginPct =
    totalContractValue > 0 ? (totalProjectedMargin / totalContractValue) * 100 : 0;

  // ---- KPI tiles ------------------------------------------------------------
  const outstandingAR = invoices
    .filter((i) => i.status === "sent")
    .reduce((s, i) => s + invoiceBalance(i), 0);
  const aging = arAgingBuckets(invoices, todayISO);
  const overdueAR = overdueTotal(aging);
  const collected = collectedThisMonth(invoices, currentMonthKey);
  const pipeline = salesPipeline(estimates);
  const activeJobs = jobs.filter((j) => j.status !== "completed").length;
  const crewHoursThisWeek = times
    .filter((t) => {
      const out = new Date(t.clock_out_at);
      return out >= thisWeekStart && out < weekEnd;
    })
    .reduce((s, t) => s + hoursFromMs(new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime()), 0);
  const openCOValue = openCOs.reduce((s, co) => {
    const amt = Number(co.amount ?? 0) || 0;
    return s + (co.is_credit ? -amt : amt);
  }, 0);

  // ---- Charts --------------------------------------------------------------
  // 1. Revenue collected per month (12 mo).
  const revenueByMonth: BarDatum[] = months.map((m) => ({
    label: m.label,
    segments: [
      {
        value: invoices
          .filter((i) => i.status === "paid" && i.paid_at && monthKey(new Date(i.paid_at)) === m.key)
          .reduce((s, i) => s + invoiceTotal(i), 0),
      },
    ],
  }));

  // 2. A/R aging buckets ($).
  const agingBars: BarDatum[] = [
    { label: "Current", segments: [{ value: aging.current, color: "#16a34a" }] },
    { label: "0-30", segments: [{ value: aging.d0_30, color: "#f59e0b" }] },
    { label: "31-60", segments: [{ value: aging.d31_60, color: "#f97316" }] },
    { label: "61-90", segments: [{ value: aging.d61_90, color: "#ef4444" }] },
    { label: "90+", segments: [{ value: aging.d90_plus, color: "#7f1d1d" }] },
  ];

  // 3. Invoices by status (+ overdue subset).
  const invoicesByStatus: BarDatum[] = [
    { label: "Sent", segments: [{ value: invoices.filter((i) => i.status === "sent").length, color: "#f59e0b" }] },
    {
      label: "Overdue",
      segments: [
        { value: invoices.filter((i) => i.status === "sent" && i.due_date && i.due_date < todayISO).length, color: "#ef4444" },
      ],
    },
    { label: "Paid", segments: [{ value: invoices.filter((i) => i.status === "paid").length, color: "#16a34a" }] },
    { label: "Void", segments: [{ value: invoices.filter((i) => i.status === "void").length, color: "#9ca3af" }] },
  ];

  // 4. Estimates by status.
  const estimatesByStatus: BarDatum[] = [
    { label: "Draft", segments: [{ value: estimates.filter((e) => e.status === "draft").length, color: "#9ca3af" }] },
    { label: "Sent", segments: [{ value: estimates.filter((e) => e.status === "sent").length, color: "#3b82f6" }] },
    { label: "Approved", segments: [{ value: estimates.filter((e) => e.status === "approved").length, color: "#16a34a" }] },
    { label: "Rejected", segments: [{ value: estimates.filter((e) => e.status === "rejected").length, color: "#ef4444" }] },
  ];

  // 5. Crew hours per crew (all history, top 6).
  const crewBars: BarDatum[] = crewHoursByWorker(times, 6).map((c) => ({
    label: c.name.split(" ")[0],
    segments: [{ value: c.hours, color: "#16a34a" }],
  }));

  // 6. Top jobs by projected margin (top 6).
  const topJobsBars: BarDatum[] = profitRows.slice(0, 6).map((r) => ({
    label: (r.job.name || "Untitled").split(" ").slice(0, 2).join(" ").slice(0, 10),
    segments: [{ value: r.p.projectedMargin, color: r.p.projectedMargin >= 0 ? "#16a34a" : "#ef4444" }],
  }));

  // Plan banner.
  const mrr = billing ? (billing.subscriptionAmountCents ?? 0) / 100 : 0;
  const planLabel = billing?.plan ?? tenant.plan ?? "—";
  const planStatusLabel = billing?.planStatus ?? tenant.planStatus;

  const moneyAxis = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Insights" subtitle="Construction command center" />
      <main className="max-w-md lg:max-w-6xl mx-auto p-4 space-y-4">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-blue-700 font-semibold">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </Link>

        {/* Plan banner */}
        <div className="bg-white rounded-lg p-4 shadow-sm flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-blue-700" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-gray-900">
              {planLabel}
              {planStatusLabel ? (
                <span className="ml-2 text-[11px] uppercase tracking-wide text-gray-400 font-medium">{planStatusLabel}</span>
              ) : null}
            </p>
            <p className="text-xs text-gray-500">
              Monthly plan {formatMoney(mrr)} · {activeJobs} active job{activeJobs === 1 ? "" : "s"} · {jobs.length} total
            </p>
          </div>
        </div>

        {/* KPI tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <KpiTile label="Outstanding A/R" value={formatMoney(outstandingAR)} icon={Receipt} />
          <KpiTile label="Overdue A/R" value={formatMoney(overdueAR)} icon={AlertTriangle} tone={overdueAR > 0 ? "red" : "default"} />
          <KpiTile label="Collected (mo)" value={formatMoney(collected)} icon={DollarSign} tone="green" />
          <KpiTile label="Pipeline value" value={formatMoney(pipeline.value)} icon={FileText} sub={`${pipeline.count} active`} />
          <KpiTile label="Active jobs" value={String(activeJobs)} icon={Briefcase} tone="blue" />
          <KpiTile label="Crew hrs (wk)" value={crewHoursThisWeek.toFixed(1)} icon={Clock} />
          <KpiTile label="Open change orders" value={String(openCOs.length)} icon={GitBranch} sub={formatMoney(openCOValue)} />
          <KpiTile
            label="Projected gross margin"
            value={`${projectedGrossMarginPct.toFixed(1)}%`}
            icon={TrendingUp}
            tone={projectedGrossMarginPct > 0 ? "green" : projectedGrossMarginPct < 0 ? "red" : "default"}
            sub={formatMoney(totalProjectedMargin)}
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartCard title="Revenue collected per month" subtitle="Last 12 months (paid invoices)">
            <BarChart data={revenueByMonth} formatValue={moneyAxis} showTotals emptyText="No paid invoices yet" />
          </ChartCard>

          <ChartCard title="A/R aging" subtitle="Open invoice balances by days past due">
            <BarChart data={agingBars} formatValue={moneyAxis} showTotals emptyText="No open invoices" />
          </ChartCard>

          <ChartCard title="Invoices by status" subtitle="Construction invoices (last 13 mo)">
            <BarChart data={invoicesByStatus} formatValue={(n) => String(Math.round(n))} showTotals />
          </ChartCard>

          <ChartCard title="Estimates by status" subtitle="All construction estimates">
            <BarChart data={estimatesByStatus} formatValue={(n) => String(Math.round(n))} showTotals />
          </ChartCard>

          <ChartCard title="Crew hours per crew" subtitle="All construction jobs, top 6">
            <BarChart data={crewBars} formatValue={(n) => `${Math.round(n)}h`} showTotals emptyText="No time clocked yet" />
          </ChartCard>

          <ChartCard title="Top jobs by projected margin" subtitle="Estimate contract − estimated cost">
            <BarChart data={topJobsBars} formatValue={moneyAxis} showTotals emptyText="No estimates yet" />
          </ChartCard>
        </div>

        {/* Per-job profitability table — the headline */}
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 pb-2">
            <p className="text-sm font-semibold text-gray-900">Job profitability</p>
            <p className="text-[11px] text-gray-400">
              Contract = latest estimate + approved change orders · Est cost = internal cost (or sell price fallback) ·
              Actual = closed crew hours × labor rate + receipts
            </p>
          </div>
          {profitRows.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-gray-500">No jobs with estimates yet.</p>
              <p className="text-xs text-gray-400 mt-1">
                Create an estimate for a job to see projected margin here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Job</th>
                    <th className="text-right font-semibold px-3 py-2">Contract</th>
                    <th className="text-right font-semibold px-3 py-2">Est cost</th>
                    <th className="text-right font-semibold px-3 py-2">Actual labor</th>
                    <th className="text-right font-semibold px-3 py-2">Material</th>
                    <th className="text-right font-semibold px-3 py-2">Proj. margin</th>
                    <th className="text-right font-semibold px-3 py-2">Margin %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {profitRows.slice(0, 12).map(({ job, p }) => {
                    const neg = p.projectedMargin < -0.005;
                    const pos = p.projectedMargin > 0.005;
                    return (
                      <tr key={job.id}>
                        <td className="px-3 py-2">
                          <Link href={`/jobs/${job.id}`} className="font-medium text-gray-900 hover:underline">
                            {job.name || "Untitled"}
                          </Link>
                          <div className="text-[10px] text-gray-400 truncate max-w-[12rem]">
                            {job.customers?.name ?? "—"}
                          </div>
                          <div className="flex gap-1 mt-0.5">
                            {p.laborRateMissing && p.actualLaborHours > 0 && (
                              <span className="text-[9px] uppercase tracking-wide bg-amber-100 text-amber-700 rounded px-1">
                                Rate not set
                              </span>
                            )}
                            {!p.hasInternalCost && (
                              <span className="text-[9px] uppercase tracking-wide bg-gray-100 text-gray-500 rounded px-1">
                                No internal cost
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-right px-3 py-2 tabular-nums">{formatMoney(p.contractValue)}</td>
                        <td className="text-right px-3 py-2 tabular-nums">{formatMoney(p.estimatedCost)}</td>
                        <td className="text-right px-3 py-2 tabular-nums">
                          {p.laborRateMissing
                            ? p.actualLaborHours > 0
                              ? `${p.actualLaborHours.toFixed(1)}h`
                              : "—"
                            : formatMoney(p.actualLaborCost)}
                        </td>
                        <td className="text-right px-3 py-2 tabular-nums">{formatMoney(p.actualMaterialCost)}</td>
                        <td
                          className={`text-right px-3 py-2 tabular-nums font-semibold ${
                            neg ? "text-red-600" : pos ? "text-green-600" : "text-gray-400"
                          }`}
                        >
                          {formatMoney(p.projectedMargin)}
                        </td>
                        <td
                          className={`text-right px-3 py-2 tabular-nums font-semibold ${
                            neg ? "text-red-600" : pos ? "text-green-600" : "text-gray-400"
                          }`}
                        >
                          {p.contractValue > 0 ? `${p.projectedMarginPct.toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {profitRows.length > 0 && (
                  <tfoot className="bg-gray-50 font-semibold text-gray-900">
                    <tr>
                      <td className="px-3 py-2">Total ({profitRows.length})</td>
                      <td className="text-right px-3 py-2 tabular-nums">{formatMoney(totalContractValue)}</td>
                      <td className="text-right px-3 py-2 tabular-nums">
                        {formatMoney(profitRows.reduce((s, r) => s + r.p.estimatedCost, 0))}
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">
                        {formatMoney(profitRows.reduce((s, r) => s + r.p.actualLaborCost, 0))}
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">
                        {formatMoney(profitRows.reduce((s, r) => s + r.p.actualMaterialCost, 0))}
                      </td>
                      <td
                        className={`text-right px-3 py-2 tabular-nums ${
                          totalProjectedMargin < -0.005 ? "text-red-600" : totalProjectedMargin > 0.005 ? "text-green-600" : "text-gray-500"
                        }`}
                      >
                        {formatMoney(totalProjectedMargin)}
                      </td>
                      <td
                        className={`text-right px-3 py-2 tabular-nums ${
                          projectedGrossMarginPct < -0.005 ? "text-red-600" : projectedGrossMarginPct > 0.005 ? "text-green-600" : "text-gray-500"
                        }`}
                      >
                        {totalContractValue > 0 ? `${projectedGrossMarginPct.toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>

        <p className="text-[11px] text-gray-400 text-center pt-1">
          All figures scoped to your organization&rsquo;s construction jobs. Margin is projected (contract − estimated
          cost), not realized. Labor uses a single blended job rate — per-role costing is coming.
        </p>
      </main>
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg p-4 shadow-sm">
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      {subtitle && <p className="text-[11px] text-gray-400 mb-2">{subtitle}</p>}
      {children}
    </div>
  );
}