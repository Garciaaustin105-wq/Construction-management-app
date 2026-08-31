import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { MANAGEMENT, ACCOUNTING, PIPELINE } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { getMe, type MyTenant } from "@/lib/tenant";
import { getOrgBilling } from "@/lib/billing";
import {
  computeTotal,
  computeEstimateTotals,
  formatMoney,
} from "@/lib/money";
import { startOfWeek, addDays, toISODate, hoursFromMs } from "@/lib/weekUtils";
import { arAgingBuckets, overdueTotal } from "@/lib/insights";
// Man-hour pricing maths — see the module for why duration alone cannot price
// labour. This page is currently the module's only consumer.
import { buildBaseline, classifyMeasurement, lotSizeBand, BASELINE_DEFAULTS, type Measurement } from "@/lib/manHours";
import PageContainer from "@/components/PageContainer";
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
  estimated_duration_minutes?: number | null;
  service_type?: string | null;
  id: string;
  active: boolean;
  frequency: string;
  interval_weeks: number | null;
  price_per_visit: number | null;
};
type VisitRow = {
  id: string;
  status: string;
  due_date: string;
  completed_at: string | null;
  // Time model (2026-08-23): started_at is stamped by the visit-detail Start
  // action. Both ends present = a measurable on-site duration.
  started_at: string | null;
  // Measured window (geofence): the figure pricing trusts. Null on both =
  // never measured (the dominant case until crews drive a route with pins).
  on_site_first_at: string | null;
  on_site_last_at: string | null;
  job_id: string;
  crew_id: string | null;
  recurring_schedule_id: string | null;
};
type TimeRow = {
  id: string;
  clock_in_at: string;
  clock_out_at: string;
  user_id: string;
  user: { id: string; full_name: string | null } | null;
};
// Shifts that recorded a crew size — the join partner for man-hours. Only
// leads write crew_size, so this is a small set.
type CrewSizeRow = {
  crew_size: number;
  clock_in_at: string;
  clock_out_at: string | null;
  user_id: string;
};
type LotRow = { id: string; lot_sqft: number | string | null };

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
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant: MyTenant | null = await getMe();
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
    servicesRes,
    lotsRes,
    crewSizeRes,
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
      .select("id, active, frequency, interval_weeks, price_per_visit, estimated_duration_minutes, service_type"),
    supabase.from("customers").select("id", { count: "exact", head: true }),
    supabase
      .from("lawn_visits")
      .select("id, status, due_date, completed_at, started_at, on_site_first_at, on_site_last_at, job_id, crew_id, recurring_schedule_id")
      .gte("due_date", twelveWeeksAgoISO),
    supabase
      .from("time_entries")
      .select("id, clock_in_at, clock_out_at, user_id, user:profiles(id, full_name)")
      .not("clock_out_at", "is", null)
      .gte("clock_out_at", eightWeeksAgoISO),
    getOrgBilling(supabase, tenant.orgId!),
    // Catalog durations, so a visit whose schedule has no override still
    // resolves an estimate. Cheap: one small org-scoped table.
    supabase.from("lawn_services").select("name, default_duration_minutes"),
    // Lot areas — the denominator of the per-1,000-sqft labour rate.
    supabase.from("lawn_jobs").select("id, lot_sqft"),
    // Shifts with a recorded crew size (only leads record one). A separate —
    // not the 8-week — fetch, so widening coverage here can't change the
    // crew-hours charts above.
    supabase
      .from("time_entries")
      .select("crew_size, clock_in_at, clock_out_at, user_id")
      .not("crew_size", "is", null)
      .gte("clock_in_at", twelveWeeksAgoISO),
  ]);

  const invoices = (invoicesRes.data as unknown as InvoiceRow[]) ?? [];
  const estimates = (estimatesRes.data as unknown as EstimateRow[]) ?? [];
  const recurring = (recurringRes.data as unknown as RecurringRow[]) ?? [];
  const activeCustomers = customersRes.count ?? 0;
  const visits = (visitsRes.data as unknown as VisitRow[]) ?? [];
  const times = (timeRes.data as unknown as TimeRow[]) ?? [];
  const serviceDurations =
    (servicesRes.data as unknown as {
      name: string;
      default_duration_minutes: number | null;
    }[]) ?? [];
  const lots = (lotsRes.data as unknown as LotRow[]) ?? [];
  const crewSizes = (crewSizeRes.data as unknown as CrewSizeRow[]) ?? [];

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

  // ---- Actual vs estimated on-site time -----------------------------------
  // Only visits with BOTH started_at and completed_at can be measured. The
  // estimate resolves the same way everywhere else: schedule override ->
  // service catalog default -> unknown (excluded from the estimate average).
  const scheduleById = new Map(recurring.map((r) => [r.id, r]));
  const serviceDefaultByName = new Map(
    serviceDurations.map((sv) => [sv.name, sv.default_duration_minutes])
  );

  const timedVisits = visits.filter((v) => v.started_at && v.completed_at);
  const actualMinutes = timedVisits.map((v) =>
    Math.max(
      0,
      (new Date(v.completed_at!).getTime() - new Date(v.started_at!).getTime()) / 60000
    )
  );
  const avgActualMinutes =
    actualMinutes.length > 0
      ? actualMinutes.reduce((a, b) => a + b, 0) / actualMinutes.length
      : null;

  const estimatedMinutes = timedVisits
    .map((v) => {
      const sched = v.recurring_schedule_id
        ? scheduleById.get(v.recurring_schedule_id)
        : undefined;
      const override = sched?.estimated_duration_minutes ?? null;
      if (override !== null) return override;
      const svcName = sched?.service_type ?? null;
      return svcName ? serviceDefaultByName.get(svcName) ?? null : null;
    })
    .filter((m): m is number => m !== null);
  const avgEstimatedMinutes =
    estimatedMinutes.length > 0
      ? estimatedMinutes.reduce((a, b) => a + b, 0) / estimatedMinutes.length
      : null;

  const crewHoursThisWeek = times
    .filter((t) => {
      const out = new Date(t.clock_out_at);
      return out >= thisWeekStart && out < addDays(thisWeekStart, 7);
    })
    .reduce((s, t) => s + hoursFromMs(new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime()), 0);

  const pipelineValue = estimates
    .filter((e) => e.status === "draft" || e.status === "sent" || e.status === "approved")
    .reduce((s, e) => s + estimateGrand(e), 0);

  // ---- Measured labour baseline (man-hours) --------------------------------
  // The payoff of the crew model: measured on-site window × crew size, priced
  // per 1,000 sqft. crew_size lives on time_entries, so each visit joins to
  // the SHIFT covering its measured arrival (same org — RLS scopes; the
  // visit's on_site_first_at between clock_in_at and
  // coalesce(clock_out_at, now())). Several shifts can cover one visit (each
  // crew member clocks their own); the lead's crew_size is the one that
  // counts, so prefer a shift from the visit's assigned crew member, else the
  // latest clock-in. No covering shift, or no crew size on it → the multiplier
  // is UNKNOWN and the row is excluded as missing data — never assumed to be 1.
  const lotsById = new Map(
    lots.map((l) => [l.id, Number(l.lot_sqft) > 0 ? Number(l.lot_sqft) : null])
  );
  const sizesDesc = [...crewSizes].sort(
    (a, b) => new Date(b.clock_in_at).getTime() - new Date(a.clock_in_at).getTime()
  );
  function coveringCrewSize(anchor: string, crewId: string | null): number | null {
    const covering = sizesDesc.find(
      (s) =>
        s.clock_in_at <= anchor &&
        (!s.clock_out_at || s.clock_out_at >= anchor)
    );
    // find() already returned the latest clock-in; re-scan for the lead's
    // shift so a second crew member's shift never outranks the lead's number.
    const lead = sizesDesc.find(
      (s) =>
        s.user_id === crewId &&
        s.clock_in_at <= anchor &&
        (!s.clock_out_at || s.clock_out_at >= anchor)
    );
    return (lead ?? covering)?.crew_size ?? null;
  }
  const measurements: Measurement[] = visits
    .filter((v) => v.on_site_first_at && v.on_site_last_at)
    .map((v) => {
      const anchor = v.on_site_first_at!;
      const ms = Math.max(
        0,
        new Date(v.on_site_last_at!).getTime() - new Date(anchor).getTime()
      );
      const lot = lotsById.get(v.job_id) ?? null;
      const size = coveringCrewSize(anchor, v.crew_id);
      return {
        visitId: v.id,
        onSiteMs: ms > 0 ? ms : null,
        // 0 = unknown covering-shift size; buildBaseline excludes it as
        // missing data (flag null), never as an outlier.
        crewSize: size ?? 0,
        lotSqft: lot,
      };
    });

  const BAND_ORDER = ["under-5k", "5k-10k", "10k-20k", "20k-1acre", "1acre-plus", "unknown"];
  const measuredVisits = measurements.length;
  const bandRows = BAND_ORDER.map((band) => {
    const group = measurements.filter((m) => lotSizeBand(m.lotSqft ?? 0) === band);
    return { band, ...buildBaseline(group) };
  }).filter((r) => r.n > 0);
  const cleanMeasurements = bandRows.reduce((s, r) => s + r.n, 0);

  // Why rows are excluded. flag === null exclusions are MISSING DATA — no lot
  // size on file, or no crew size on the covering shift — not outliers, and
  // presented as exactly that.
  const excludedReasons = { missingLot: 0, missingCrew: 0, tooLong: 0, tooShort: 0, noDeparture: 0 };
  for (const m of measurements) {
    const flag = classifyMeasurement(m);
    if (flag === "too_long") excludedReasons.tooLong++;
    else if (flag === "too_short") excludedReasons.tooShort++;
    else if (flag === "no_departure") excludedReasons.noDeparture++;
    else if ((m.lotSqft ?? 0) <= 0) excludedReasons.missingLot++;
    else if (m.crewSize <= 0) excludedReasons.missingCrew++;
  }
  const excludedTotal =
    excludedReasons.tooLong + excludedReasons.tooShort + excludedReasons.noDeparture +
    excludedReasons.missingLot + excludedReasons.missingCrew;

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
    <PageContainer title="Insights" subtitle="Owner dashboard" maxWidth="wide">
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
        {/* Hidden until at least one visit has been Started — otherwise this
            renders an empty tile on every org from day one. */}
        {avgActualMinutes !== null && (
          <KpiTile
            label="Avg on site"
            value={`${Math.round(avgActualMinutes)} min`}
            sub={
              avgEstimatedMinutes === null
                ? `${timedVisits.length} timed visit${timedVisits.length === 1 ? "" : "s"}`
                : `est ${Math.round(avgEstimatedMinutes)} min \u00b7 ${timedVisits.length} timed`
            }
            icon={Clock}
            tone={
              avgEstimatedMinutes !== null && avgActualMinutes > avgEstimatedMinutes * 1.2
                ? "amber"
                : "default"
            }
          />
        )}
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

      {/* Measured labour — the man-hour payoff. Sits below the charts because
          it only becomes meaningful once measured visits accumulate; the EMPTY
          state below is what users see first, so it explains what will fill it. */}
      <ChartCard
        title="Measured labour"
        subtitle="Median man-minutes per 1,000 sqft by lot-size band — geofence on-site time × the shift's crew size"
      >
        {measuredVisits === 0 ? (
          <div className="py-2 space-y-1">
            <p className="text-sm font-medium text-gray-700">No measured visits yet</p>
            <p className="text-xs text-gray-500 max-w-lg">
              Crews record this automatically — once they clock in and work a
              route with map pins, each stop&apos;s on-site window and head
              count start landing here. Nobody has to fill anything in; a
              measured route just needs phones along for the ride.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-gray-400 text-left">
                    <th className="py-1 pr-4 font-medium">Lot size</th>
                    <th className="py-1 pr-4 font-medium">Median man-min / 1k sqft</th>
                    <th className="py-1 font-medium">n</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {bandRows.map((r) => (
                    <tr key={r.band}>
                      <td className="py-1.5 pr-4 text-gray-700">{r.band}</td>
                      <td className="py-1.5 pr-4 font-semibold tabular-nums text-gray-900">
                        {r.medianManMinutesPer1000.toFixed(1)}
                      </td>
                      <td className="py-1.5 font-medium tabular-nums text-gray-500">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              Based on {cleanMeasurements} clean measurement{cleanMeasurements === 1 ? "" : "s"}
              {measuredVisits !== cleanMeasurements &&
                ` from ${measuredVisits} measured visit${measuredVisits === 1 ? "" : "s"}`}
              .
              {excludedTotal > 0 && " Excluded: "}
              {excludedReasons.missingLot > 0 && `${excludedReasons.missingLot} with no lot size on file (missing data, not outliers)`}
              {excludedReasons.missingCrew > 0 && `${excludedReasons.missingLot > 0 ? ", " : ""}${excludedReasons.missingCrew} with no crew size on the covering shift (missing data)`}
              {excludedReasons.tooLong > 0 && `${excludedReasons.missingLot + excludedReasons.missingCrew > 0 ? ", " : ""}${excludedReasons.tooLong} well over the expected range`}
              {excludedReasons.tooShort > 0 && `${excludedTotal > excludedReasons.tooShort ? ", " : ""}${excludedReasons.tooShort} under the ${BASELINE_DEFAULTS.minOnSiteMinutes}-minute floor`}
              {excludedReasons.noDeparture > 0 && `${excludedTotal > excludedReasons.noDeparture ? ", " : ""}${excludedReasons.noDeparture} with no departure recorded`}
              {excludedTotal > 0 && "."}
            </p>
            {cleanMeasurements < 30 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <span className="font-semibold">Provisional</span> — below 30
                clean measurements, treat every figure as directional. Averages
                over small samples move with a single unusual stop; 30+ is
                where a median starts meaning something.
              </p>
            )}
          </div>
        )}
      </ChartCard>

      <p className="text-[11px] text-gray-400 text-center pt-1">
        All figures are scoped to your organization. Revenue is from paid
        invoices; A/R is open invoice balances. Recurring/yr is an annualized
        run-rate from active schedules.
      </p>
    </PageContainer>
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