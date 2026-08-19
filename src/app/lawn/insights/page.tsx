import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { MANAGEMENT, ACCOUNTING, PIPELINE } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { getMyOrg, type MyTenant } from "@/lib/tenant";
import { getOrgBilling } from "@/lib/billing";
import {
  computeTotal,
  computeEstimateTotals,
  formatMoney,
} from "@/lib/money";
import { startOfWeek, addDays, toISODate, hoursFromMs } from "@/lib/weekUtils";
import { arAgingBuckets, overdueTotal } from "@/lib/insights";
import TopBar from "@/components/TopBar";
import KpiTile from "@/components/charts/KpiTile";
import BarChart, { type BarDatum } from "@/components/charts/BarChart";
import {
  Receipt,
  AlertTriangle,
  DollarSign,
  Repeat,
  Contact,
  Sprout,
  Clock,
  FileText,
  ArrowLeft,
  Sparkles,
} from "lucide-react";

// /lawn/insights — read-only owner analytics dashboard for the lawn variant.
// Office/admin/super_admin only; construction variant is redirected away (this
// page is lawn-flavored — lawn_visits / recurring_schedules metrics). Every
// metric is read via the RLS session client (auto org-scoped — no manual
// organization_id filter), so it can never cross tenants and never needs the
// service-role key. All aggregation is in JS over the fetched rows; no new
// tables / SQL / RLS. Charts are hand-rolled SVG (no chart library) — see
// src/components/charts/*. No "use client" anywhere in this page.

// ---- row shapes (the nested selects) ---------------------------------------
type InvoiceRow = {
  id: string;
  status: string;
  paid_at: string | null;
  due_date: string | null;
  amount_paid: number | null;
  created_at: string;
  customer_id: string | null;
  customers: { name: string | null } | null;
  invoice_line_items: { quantity: number; unit_price: number }[];
};
type EstimateRow = {
  id: string;
  status: string;
  markup_pct: number | null;
  contingency_pct: number | null;
  tax_pct: number | null;
  deposit_pct: number | null;
  deposit_amount: number | null;
  customer_id: string | null;
  customers: { name: string | null } | null;
  estimate_line_items: { quantity: number; unit_price: number }[];
};
type RecurringRow = {
  id: string;
  active: boolean;
  frequency: string;
  interval_weeks: number | null;
  price_per_visit: number | null;
};
type VisitRow = { id: string; status: string; due_date: string; completed_at: string | null };
type TimeRow = {
  id: string;
  clock_in_at: string;
  clock_out_at: string;
  user_id: string;
  user: { id: string; full_name: string | null } | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Last `n` months including the current one, oldest first.
function monthBuckets(n: number) {
  const now = new Date();
  const out: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: monthKey(d), label: MONTHS[d.getMonth()] });
  }
  return out;
}

// Last `n` Monday-based weeks including the current one, oldest first.
function weekBuckets(n: number) {
  const thisMon = startOfWeek(new Date());
  const out: { key: string; label: string; startISO: string; endISO: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addDays(thisMon, -7 * i);
    const end = addDays(start, 6);
    out.push({
      key: toISODate(start),
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      startISO: toISODate(start),
      endISO: toISODate(end),
    });
  }
  return out;
}

function invoiceTotal(inv: InvoiceRow): number {
  return computeTotal(inv.invoice_line_items ?? []);
}
function invoiceBalance(inv: InvoiceRow): number {
  return Math.max(0, invoiceTotal(inv) - (Number(inv.amount_paid ?? 0) || 0));
}
function estimateGrand(est: EstimateRow): number {
  return computeEstimateTotals(est.estimate_line_items ?? [], {
    markupPct: est.markup_pct,
    contingencyPct: est.contingency_pct,
    taxPct: est.tax_pct,
    depositPct: est.deposit_pct,
    depositAmount: est.deposit_amount,
  }).grandTotal;
}

export default async function LawnInsightsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenant: MyTenant | null = await getMyOrg(supabase);
  if (!tenant) redirect("/login");
  // Lawn insights: management + accountant (read-only) + sales (pipeline).
  // Was OFFICE_LIKE; widened so accountant/sales/PM/super can read lawn analytics.
  if (
    !(
      MANAGEMENT.has(tenant.role as never) ||
      ACCOUNTING.has(tenant.role as never) ||
      PIPELINE.has(tenant.role as never)
    )
  )
    redirect("/dashboard");
  // Lawn-only page — construction variant has no lawn analytics surface.
  if (!isLawn()) redirect("/dashboard");

  const now = new Date();
  const todayISO = toISODate(now);
  const thisWeekStart = startOfWeek(now);
  const currentMonthKey = monthKey(now);

  const months = monthBuckets(12);
  const weeks = weekBuckets(12);

  const thirteenMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString();
  const twelveWeeksAgoISO = weeks[0].startISO;
  const eightWeeksAgoISO = toISODate(addDays(thisWeekStart, -7 * 7));

  const [
    invoicesRes,
    estimatesRes,
    recurringRes,
    customersRes,
    visitsRes,
    timeRes,
    billing,
  ] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "id, status, paid_at, due_date, amount_paid, created_at, customer_id, customers(name), invoice_line_items(quantity, unit_price)"
      )
      .gte("created_at", thirteenMonthsAgo),
    supabase
      .from("estimates")
      .select(
        "id, status, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, customer_id, customers(name), estimate_line_items(quantity, unit_price)"
      ),
    supabase
      .from("recurring_schedules")
      .select("id, active, frequency, interval_weeks, price_per_visit"),
    supabase.from("customers").select("id", { count: "exact", head: true }),
    supabase
      .from("lawn_visits")
      .select("id, status, due_date, completed_at")
      .gte("due_date", twelveWeeksAgoISO),
    supabase
      .from("time_entries")
      .select("id, clock_in_at, clock_out_at, user_id, user:profiles(id, full_name)")
      .not("clock_out_at", "is", null)
      .gte("clock_out_at", eightWeeksAgoISO),
    getOrgBilling(supabase, tenant.orgId!),
  ]);

  const invoices = (invoicesRes.data as unknown as InvoiceRow[]) ?? [];
  const estimates = (estimatesRes.data as unknown as EstimateRow[]) ?? [];
  const recurring = (recurringRes.data as unknown as RecurringRow[]) ?? [];
  const activeCustomers = customersRes.count ?? 0;
  const visits = (visitsRes.data as unknown as VisitRow[]) ?? [];
  const times = (timeRes.data as unknown as TimeRow[]) ?? [];

  // ---- KPI tiles -----------------------------------------------------------
  const outstandingAR = invoices
    .filter((i) => i.status === "sent")
    .reduce((s, i) => s + invoiceBalance(i), 0);
  const aging = arAgingBuckets(invoices, todayISO);
  const overdueAR = overdueTotal(aging);
  const collectedThisMonth = invoices
    .filter((i) => i.status === "paid" && i.paid_at && monthKey(new Date(i.paid_at)) === currentMonthKey)
    .reduce((s, i) => s + invoiceTotal(i), 0);

  // Annualized recurring run-rate: price_per_visit × visits/year (active only).
  // weekly/biweekly → 52 / interval_weeks; monthly → 12.
  const recurringAnnualized = recurring
    .filter((r) => r.active)
    .reduce((s, r) => {
      const price = Number(r.price_per_visit ?? 0) || 0;
      const perYear =
        r.frequency === "monthly"
          ? 12
          : Math.round(52 / Math.max(1, r.interval_weeks || 1));
      return s + price * perYear;
    }, 0);

  const visitsDoneThisWeek = visits.filter(
    (v) =>
      v.status === "done" &&
      v.completed_at &&
      new Date(v.completed_at) >= thisWeekStart &&
      new Date(v.completed_at) < addDays(thisWeekStart, 7)
  ).length;

  const crewHoursThisWeek = times
    .filter((t) => {
      const out = new Date(t.clock_out_at);
      return out >= thisWeekStart && out < addDays(thisWeekStart, 7);
    })
    .reduce((s, t) => s + hoursFromMs(new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime()), 0);

  const pipelineValue = estimates
    .filter((e) => e.status === "draft" || e.status === "sent" || e.status === "approved")
    .reduce((s, e) => s + estimateGrand(e), 0);

  // ---- Charts --------------------------------------------------------------
  // 1. Revenue collected per month (12 mo) — paid invoices by paid_at month.
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

  // 2. Visits per week pending vs done vs skipped (12 wk) — bucketed by due_date.
  const visitsByWeek: BarDatum[] = weeks.map((w) => {
    const inWeek = visits.filter((v) => v.due_date >= w.startISO && v.due_date <= w.endISO);
    return {
      label: w.label,
      segments: [
        { value: inWeek.filter((v) => v.status === "done").length, color: "#16a34a", name: "Done" },
        { value: inWeek.filter((v) => v.status === "pending").length, color: "#f59e0b", name: "Pending" },
        { value: inWeek.filter((v) => v.status === "skipped").length, color: "#9ca3af", name: "Skipped" },
      ],
    };
  });

  // 3. Invoices by status (+ overdue subset shown separately).
  const sentCount = invoices.filter((i) => i.status === "sent").length;
  const paidCount = invoices.filter((i) => i.status === "paid").length;
  const voidCount = invoices.filter((i) => i.status === "void").length;
  const overdueCount = invoices.filter(
    (i) => i.status === "sent" && i.due_date && i.due_date < todayISO
  ).length;
  const invoicesByStatus: BarDatum[] = [
    { label: "Sent", segments: [{ value: sentCount, color: "#f59e0b" }] },
    { label: "Overdue", segments: [{ value: overdueCount, color: "#ef4444" }] },
    { label: "Paid", segments: [{ value: paidCount, color: "#16a34a" }] },
    { label: "Void", segments: [{ value: voidCount, color: "#9ca3af" }] },
  ];

  // 4. Estimates by status.
  const estimatesByStatus: BarDatum[] = [
    { label: "Draft", segments: [{ value: estimates.filter((e) => e.status === "draft").length, color: "#9ca3af" }] },
    { label: "Sent", segments: [{ value: estimates.filter((e) => e.status === "sent").length, color: "#3b82f6" }] },
    { label: "Approved", segments: [{ value: estimates.filter((e) => e.status === "approved").length, color: "#16a34a" }] },
    { label: "Rejected", segments: [{ value: estimates.filter((e) => e.status === "rejected").length, color: "#ef4444" }] },
  ];

  // 5. Crew hours per crew (last 8 weeks) — top 6 by hours.
  const hoursByCrew = new Map<string, number>();
  const crewName = new Map<string, string>();
  for (const t of times) {
    const ms = new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime();
    hoursByCrew.set(t.user_id, (hoursByCrew.get(t.user_id) ?? 0) + hoursFromMs(ms));
    if (t.user?.full_name) crewName.set(t.user_id, t.user.full_name);
  }
  const crewBars: BarDatum[] = [...hoursByCrew.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, hrs]) => ({
      label: (crewName.get(id) || "Crew").split(" ")[0],
      segments: [{ value: hrs, color: "#16a34a" }],
    }));

  // 6. Top customers by collected revenue (paid invoices).
  const revByCustomer = new Map<string, number>();
  const customerName = new Map<string, string>();
  for (const i of invoices) {
    if (i.status !== "paid") continue;
    const c = i.customer_id;
    if (!c) continue;
    revByCustomer.set(c, (revByCustomer.get(c) ?? 0) + invoiceTotal(i));
    if (i.customers?.name) customerName.set(c, i.customers.name);
  }
  const topCustomers: BarDatum[] = [...revByCustomer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, v]) => ({
      label: (customerName.get(id) || "Unknown").split(" ")[0].slice(0, 8),
      segments: [{ value: v, color: "#16a34a" }],
    }));

  // Plan / MRR banner.
  const mrr = billing ? (billing.subscriptionAmountCents ?? 0) / 100 : 0;
  const planLabel = billing?.plan ?? tenant.plan ?? "—";
  const planStatusLabel = billing?.planStatus ?? tenant.planStatus;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Insights" subtitle="Owner dashboard" />
      <main className="max-w-md lg:max-w-6xl mx-auto p-4 space-y-4">
        <Link
          href="/lawn"
          className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Lawn
        </Link>

        {/* Plan / MRR banner */}
        <div className="bg-white rounded-lg p-4 shadow-sm flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-green-700" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-gray-900">
              {planLabel}
              {planStatusLabel ? (
                <span className="ml-2 text-[11px] uppercase tracking-wide text-gray-400 font-medium">
                  {planStatusLabel}
                </span>
              ) : null}
            </p>
            <p className="text-xs text-gray-500">
              Monthly plan {formatMoney(mrr)} · {activeCustomers} customer{activeCustomers === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {/* KPI tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <KpiTile label="Outstanding A/R" value={formatMoney(outstandingAR)} icon={Receipt} />
          <KpiTile label="Overdue A/R" value={formatMoney(overdueAR)} icon={AlertTriangle} tone={overdueAR > 0 ? "red" : "default"} />
          <KpiTile label="Collected (mo)" value={formatMoney(collectedThisMonth)} icon={DollarSign} tone="green" />
          <KpiTile label="Recurring / yr" value={formatMoney(recurringAnnualized)} icon={Repeat} tone="blue" />
          <KpiTile label="Active customers" value={String(activeCustomers)} icon={Contact} tone="blue" />
          <KpiTile label="Visits done (wk)" value={String(visitsDoneThisWeek)} icon={Sprout} tone="green" />
          <KpiTile label="Crew hrs (wk)" value={crewHoursThisWeek.toFixed(1)} icon={Clock} />
          <KpiTile label="Estimate pipeline" value={formatMoney(pipelineValue)} icon={FileText} />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartCard title="Revenue collected per month" subtitle="Last 12 months (paid invoices)">
            <BarChart data={revenueByMonth} formatValue={(n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`)} showTotals />
          </ChartCard>

          <ChartCard title="Visits per week" subtitle="Done · pending · skipped (12 weeks)">
            <BarChart data={visitsByWeek} formatValue={(n) => String(Math.round(n))} showTotals />
          </ChartCard>

          <ChartCard title="Invoices by status" subtitle="All invoices in range">
            <BarChart data={invoicesByStatus} formatValue={(n) => String(Math.round(n))} showTotals />
          </ChartCard>

          <ChartCard title="A/R aging" subtitle="Open invoice balances by days past due">
            <BarChart
              data={[
                { label: "Current", segments: [{ value: aging.current, color: "#16a34a" }] },
                { label: "0-30", segments: [{ value: aging.d0_30, color: "#f59e0b" }] },
                { label: "31-60", segments: [{ value: aging.d31_60, color: "#f97316" }] },
                { label: "61-90", segments: [{ value: aging.d61_90, color: "#ef4444" }] },
                { label: "90+", segments: [{ value: aging.d90_plus, color: "#7f1d1d" }] },
              ]}
              formatValue={(n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`)}
              showTotals
              emptyText="No open invoices"
            />
          </ChartCard>

          <ChartCard title="Estimates by status" subtitle="All estimates">
            <BarChart data={estimatesByStatus} formatValue={(n) => String(Math.round(n))} showTotals />
          </ChartCard>

          <ChartCard title="Crew hours per crew" subtitle="Last 8 weeks, top 6">
            <BarChart data={crewBars} formatValue={(n) => `${Math.round(n)}h`} showTotals emptyText="No time clocked yet" />
          </ChartCard>

          <ChartCard title="Top customers by revenue" subtitle="Collected (paid invoices)">
            <BarChart data={topCustomers} formatValue={(n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`)} showTotals emptyText="No paid invoices yet" />
          </ChartCard>
        </div>

        <p className="text-[11px] text-gray-400 text-center pt-1">
          All figures are scoped to your organization. Revenue is from paid
          invoices; A/R is open invoice balances. Recurring/yr is an annualized
          run-rate from active schedules.
        </p>
      </main>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg p-4 shadow-sm">
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      {subtitle && <p className="text-[11px] text-gray-400 mb-2">{subtitle}</p>}
      {children}
    </div>
  );
}