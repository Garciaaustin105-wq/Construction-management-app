import { Fragment } from "react";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import PageContainer from "@/components/PageContainer";
import WeeklyReportFilters from "@/components/WeeklyReportFilters";
import {
  addDays,
  toISODate,
  fmtDuration,
} from "@/lib/weekUtils";
import { resolveReportRange, rangeDayCount } from "@/lib/reports";
import { formatMoney } from "@/lib/money";
import { Download, Camera, Receipt, Briefcase } from "lucide-react";
import { isLawn } from "@/lib/variant";
import { OFFICE_OR_PM, ACCOUNTING } from "@/lib/roles";
import { weeksInRange, bucketByWeek, weekStart, fmtHours } from "@/lib/payrollWeeks";

export const dynamic = "force-dynamic";

// Week cells show hours as a compact number, at most one decimal (shared
// formatter from the payroll weeks helper, which takes hours not ms).
function fmtHoursShort(ms: number): string {
  return fmtHours(ms / 3_600_000);
}

type TimeEntry = {
  id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  note: string | null;
  status: string; // pending | approved | rejected
  job: { name: string | null } | null;
};

// Per-day bucket for a worker's time entries (drives both the day × worker
// grid and the worker × week month grid + drill-downs).
type DayCell = {
  // Payable = clocked out AND not rejected. This is what payroll totals count.
  payableMs: number;
  // Portion of payableMs still awaiting approval (status = pending).
  pendingMs: number;
  // Still clocked in (clock_out_at IS NULL). Live elapsed time — shown but
  // deliberately kept OUT of payroll totals until the worker clocks out, so
  // the number a payroll run sees never changes between page loads.
  openMs: number;
  // All entries for the day, rejected included — the day drill-down layer
  // shows them (with badges) even though rejected hours count nowhere.
  entries: (TimeEntry & { user_id: string })[];
};

export default async function WeeklyReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    job?: string;
    worker?: string;
    code?: string;
    weekStart?: string; // legacy
    expand?: string; // drill-down: "<workerId>:<weekStartISO YYYY-MM-DD>"
    day?: string; // drill-down: ISO date inside the expanded week
  }>;
}) {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const reportRole = me.role;
  // Admit office/admin/PM/super_admin + accountant (read-only financials).
  if (
    !(
      OFFICE_OR_PM.has(reportRole as never) ||
      ACCOUNTING.has(reportRole as never)
    )
  )
    redirect("/dashboard");

  const sp = await searchParams;
  // The job filter only matches job-attributed entries. A shift entry has
  // job_id IS NULL, so on the lawn variant (where logged time is all shifts)
  // a ?job= param would silently exclude every hour — stale links included.
  // The filter is hidden there, and a stale param is ignored rather than
  // honored, so the hide is honest.
  const jobId = isLawn() ? null : sp.job || null;
  const workerId = sp.worker || null;
  const codeId = sp.code || null;
  const { from, toInclusive } = resolveReportRange(sp.from, sp.to, sp.weekStart);
  const dayCount = rangeDayCount(from, toInclusive);

  const startISO = from.toISOString();
  const endISO = addDays(toInclusive, 1).toISOString();
  // Async server component — runs once per request, so Date.now() is the
  // request time (used to compute elapsed time for still-open shifts), not a
  // client-render side effect. react-hooks/purity is a false positive here.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const rangeLabel = `${from.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} – ${toInclusive.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;

  // Dropdown data + report queries in parallel. Filters apply to time_entries
  // + receipts (job/worker/code) and photos (job/worker only — no cost code).
  // Jobs filter is variant-aware: lawn jobs in the lawn variant (the old
  // `type=construction` filter left the dropdown empty + made the report show
  // "No activity" in a lawn deploy). Cost codes are a construction surface —
  // skipped in lawn.
  const jobType = isLawn() ? "lawn" : "construction";
  const [jobsRes, workersRes, codesRes, timeRes, photoRes, receiptRes, profileRes] =
    await Promise.all([
      supabase.from("jobs").select("id, name").eq("type", jobType).order("name"),
      supabase.from("profiles").select("id, full_name").order("full_name"),
      isLawn()
        ? Promise.resolve({ data: [] })
        : supabase.from("cost_codes").select("id, code, name").order("code"),
      (() => {
        let q = supabase
          .from("time_entries")
          // status drives the approval flag on every cell; job_id being
          // NULL is a whole-route SHIFT entry (not "no job").
          .select(
            "id, user_id, note, clock_in_at, clock_out_at, status, job:jobs(name)"
          )
          .gte("clock_in_at", startISO)
          .lt("clock_in_at", endISO);
        if (jobId) q = q.eq("job_id", jobId);
        if (workerId) q = q.eq("user_id", workerId);
        if (codeId) q = q.eq("cost_code_id", codeId);
        return q;
      })(),
      (() => {
        let q = supabase
          .from("photos")
          .select("uploaded_by, created_at, job:jobs(name)")
          .gte("created_at", startISO)
          .lt("created_at", endISO);
        if (jobId) q = q.eq("job_id", jobId);
        if (workerId) q = q.eq("uploaded_by", workerId);
        return q;
      })(),
      (() => {
        let q = supabase
          .from("receipts")
          .select("uploaded_by, amount, reimbursed, job:jobs(name)")
          .gte("captured_at", startISO)
          .lt("captured_at", endISO);
        if (jobId) q = q.eq("job_id", jobId);
        if (workerId) q = q.eq("uploaded_by", workerId);
        if (codeId) q = q.eq("cost_code_id", codeId);
        return q;
      })(),
      supabase.from("profiles").select("id, full_name, role"),
    ]);

  const jobs = (jobsRes.data ?? []) as { id: string; name: string }[];
  const workerOptions = ((workersRes.data ?? []) as { id: string; full_name: string | null }[]).map(
    (p) => ({ id: p.id, name: p.full_name ?? "Unknown" })
  );
  const costCodes = ((codesRes.data ?? []) as { id: string; code: string; name: string }[]).map(
    (c) => ({ id: c.id, label: `${c.code} · ${c.name}` })
  );

  const profiles = new Map<string, { name: string; role: string }>();
  for (const p of (profileRes.data ?? []) as {
    id: string;
    full_name: string | null;
    role: string | null;
  }[]) {
    profiles.set(p.id, { name: p.full_name ?? "Unknown", role: p.role ?? "—" });
  }
  type PhotoRow = { uploaded_by: string | null; job: { name: string | null } | null };
  type ReceiptRow = {
    uploaded_by: string | null;
    amount: number | null;
    reimbursed: boolean | null;
    job: { name: string | null } | null;
  };

  const workers = new Map<
    string,
    {
      name: string;
      role: string;
      // Payroll hours: clocked out + not rejected.
      ms: number;
      openMs: number;
      byDay: Record<string, DayCell>;
      projects: Set<string>;
      photos: number;
      submitted: number;
      paidBack: number;
      owed: number;
    }
  >();
  function ensure(id: string) {
    if (!workers.has(id)) {
      const p = profiles.get(id);
      workers.set(id, {
        name: p?.name ?? "Unknown",
        role: p?.role ?? "—",
        ms: 0,
        openMs: 0,
        byDay: {},
        projects: new Set(),
        photos: 0,
        submitted: 0,
        paidBack: 0,
        owed: 0,
      });
    }
    return workers.get(id)!;
  }

  for (const t of (timeRes.data ?? []) as unknown as (TimeEntry & { user_id: string })[]) {
    const w = ensure(t.user_id);
    const j = t.job?.name;
    if (j) w.projects.add(j);
    const day = toISODate(new Date(t.clock_in_at));
    const cell =
      w.byDay[day] ??
      (w.byDay[day] = { payableMs: 0, pendingMs: 0, openMs: 0, entries: [] });
    cell.entries.push(t);
    // Rejected hours are not payable and count in NO total; they still show
    // up in the day drill-down so approvers can see what was rejected.
    if (t.status === "rejected") continue;
    const inMs = new Date(t.clock_in_at).getTime();
    const outMs = t.clock_out_at ? new Date(t.clock_out_at).getTime() : null;
    const elapsed = Math.max(0, (outMs ?? now) - inMs);
    if (outMs === null) {
      // Still clocked in — kept out of the payroll total (w.ms) on purpose.
      w.openMs += elapsed;
      cell.openMs += elapsed;
    } else {
      w.ms += elapsed;
      cell.payableMs += elapsed;
      if (t.status === "pending") {
        cell.pendingMs += elapsed;
      }
    }
  }
  for (const p of (photoRes.data ?? []) as unknown as PhotoRow[]) {
    if (!p.uploaded_by) continue;
    const w = ensure(p.uploaded_by);
    w.photos += 1;
    const j = p.job?.name;
    if (j) w.projects.add(j);
  }
  for (const r of (receiptRes.data ?? []) as unknown as ReceiptRow[]) {
    if (!r.uploaded_by) continue;
    const w = ensure(r.uploaded_by);
    const amt = Number(r.amount ?? 0);
    w.submitted += amt;
    if (r.reimbursed) w.paidBack += amt;
    else w.owed += amt;
    const j = r.job?.name;
    if (j) w.projects.add(j);
  }

  const rows = [...workers.entries()]
    .map(([id, w]) => ({ id, ...w }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Payroll total = closed, non-rejected hours only.
  const totalPayableMs = rows.reduce((s, r) => s + r.ms, 0);
  const totalOpenMs = rows.reduce((s, r) => s + r.openMs, 0);
  const totalPhotos = rows.reduce((s, r) => s + r.photos, 0);
  const totalSubmitted = rows.reduce((s, r) => s + r.submitted, 0);
  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);

  // Day columns for the on-screen timesheet grid (one per day in the range).
  // Ranges ≤ 14 days render the day × worker grid; longer ranges render the
  // worker × week month grid below instead of the old "too wide" wall.
  const showTimesheet = dayCount <= 14;
  const dayColumns: string[] = [];
  for (let d = 0; d < dayCount; d++) dayColumns.push(toISODate(addDays(from, d)));
  const dayTotals: Record<string, number> = {};
  for (const iso of dayColumns) dayTotals[iso] = 0;
  for (const r of rows) {
    for (const iso of dayColumns) dayTotals[iso] += r.byDay[iso]?.payableMs ?? 0;
  }

  // ---- Month view buckets (worker × week) ----
  // Weeks are Monday–Sunday via the shared payroll-weeks helper: one column
  // per week overlapping the range, plus a Monday–Sunday bucketing of each
  // worker's day map (payable hours, plus pending/open as cell flags).
  const weekBuckets = weeksInRange(toISODate(from), toISODate(toInclusive));
  const weekCols: { startISO: string; endISO: string; label: string }[] =
    weekBuckets.map((w) => ({ startISO: w.start, endISO: w.end, label: w.label }));
  type WeekFlags = { pendingMs: number; openMs: number };
  const workerWeeks = new Map<string, { ms: number[]; flags: WeekFlags[] }>();
  const weekTotals: number[] = weekCols.map(() => 0);
  const weekFlags: WeekFlags[] = weekCols.map(() => ({ pendingMs: 0, openMs: 0 }));
  for (const r of rows) {
    const payableDay: Record<string, number> = {};
    const pendingDay: Record<string, number> = {};
    const openDay: Record<string, number> = {};
    for (const [iso, cell] of Object.entries(r.byDay)) {
      if (cell.payableMs > 0) payableDay[iso] = cell.payableMs;
      if (cell.pendingMs > 0) pendingDay[iso] = cell.pendingMs;
      if (cell.openMs > 0) openDay[iso] = cell.openMs;
    }
    const ms = bucketByWeek(payableDay, weekBuckets);
    const pending = bucketByWeek(pendingDay, weekBuckets);
    const open = bucketByWeek(openDay, weekBuckets);
    const flags = weekCols.map((_, wi) => ({
      pendingMs: pending[wi],
      openMs: open[wi],
    }));
    for (let wi = 0; wi < weekCols.length; wi++) {
      weekTotals[wi] += ms[wi];
      weekFlags[wi].pendingMs += flags[wi].pendingMs;
      weekFlags[wi].openMs += flags[wi].openMs;
    }
    workerWeeks.set(r.id, { ms, flags });
  }

  // ---- Drill-down (server-side URL state) ----
  // ?expand=<workerId>:<Monday ISO>  → that worker's 7 days for that week.
  // ?day=<ISO> (+ expand)            → that day's individual time entries.
  const expand = sp.expand ?? "";
  const dayFilter = sp.day ?? "";
  const [expWorkerId, expWeekStartISO] = expand.split(":");
  const expWorkerRow = expWorkerId
    ? rows.find((r) => r.id === expWorkerId)
    : undefined;
  const expWeekValid =
    expWorkerRow !== undefined &&
    weekCols.some((c) => c.startISO === expWeekStartISO);

  // Filter query string for the Excel download link.
  const exportQs = new URLSearchParams();
  if (sp.from) exportQs.set("from", sp.from);
  else exportQs.set("from", toISODate(from));
  if (sp.to) exportQs.set("to", sp.to);
  else exportQs.set("to", toISODate(toInclusive));
  if (jobId) exportQs.set("job", jobId);
  if (workerId) exportQs.set("worker", workerId);
  if (codeId) exportQs.set("code", codeId);
  const exportHref = `/api/reports/weekly?${exportQs.toString()}`;

  // Href builder for the expand/day drill-down links — preserves the active
  // filters so the grid under a drill-down matches the visible numbers.
  function reportHref(opts?: { expand?: string | null; day?: string | null }) {
    let qs = exportQs.toString();
    if (opts?.expand) qs += `&expand=${encodeURIComponent(opts.expand)}`;
    if (opts?.day) qs += `&day=${encodeURIComponent(opts.day)}`;
    return `/admin/reports/weekly?${qs}`;
  }

  const current = {
    job: jobId ?? "",
    worker: workerId ?? "",
    code: codeId ?? "",
    from: toISODate(from),
    to: toISODate(toInclusive),
  };

  const pendingDot = (
    <span
      className="ml-1 inline-block w-2 h-2 rounded-full bg-amber-400 align-middle"
      title="Hours awaiting approval"
    />
  );
  const openDot = (
    <span
      className="ml-1 inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse align-middle"
      title="Still clocked in — live time, not in payroll total until clocked out"
    />
  );

  return (
    <PageContainer title="Timesheets & payroll" subtitle={rangeLabel} maxWidth="list" backHref="/admin/reports" backLabel="Reports">
      {/* Filters (date range + job / worker / cost code). Job cost codes are
          a construction surface; the job filter is hidden on lawn, where all
          time is shift time that no job filter would ever match. */}
      <div className="bg-white rounded-lg p-3 shadow-sm">
        <WeeklyReportFilters
          jobs={jobs}
          workers={workerOptions}
          costCodes={costCodes}
          current={current}
          showCostCode={!isLawn()}
          showJob={!isLawn()}
        />
        {!isLawn() && jobId && (
          <p className="mt-2 text-[11px] text-gray-500">
            Filtering by job — whole-route shift entries (no job) are excluded
            from these numbers. Clear the job filter to see all time.
          </p>
        )}
      </div>

      {/* Download */}
      <a
        href={exportHref}
        download
        className="w-full bg-green-600 text-white py-4 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2"
      >
        <Download className="w-5 h-5" />
        Download Excel
      </a>

      {dayCount > 31 && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Range is {dayCount} days — the Daily Hours sheet is omitted from the
          Excel export (too wide). All other sheets still include the full range.
        </p>
      )}

      {/* Totals strip */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <p className="text-xs text-gray-500">Total hours</p>
          <p className="text-lg font-bold text-gray-900">
            {fmtDuration(totalPayableMs)}
          </p>
          {totalOpenMs > 0 && (
            <p className="text-[10px] text-green-700">
              + {fmtDuration(totalOpenMs)} still on the clock
            </p>
          )}
        </div>
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <p className="text-xs text-gray-500">Photos</p>
          <p className="text-lg font-bold text-gray-900">{totalPhotos}</p>
        </div>
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <p className="text-xs text-gray-500">Receipts submitted</p>
          <p className="text-lg font-bold text-gray-900">
            {formatMoney(totalSubmitted)}
          </p>
        </div>
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <p className="text-xs text-gray-500">Owed to crew</p>
          <p className="text-lg font-bold text-amber-700">
            {formatMoney(totalOwed)}
          </p>
        </div>
      </div>

      {/* On-screen timesheet — the in-app "timesheet" (the Excel export has
          the Daily Hours sheet). Ranges ≤ 14 days render the day × worker
          grid; longer ranges render the worker × week month grid with
          drill-down instead of the old "too wide" message. */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
          Timesheet
        </h2>
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center shadow-sm">
            <p className="text-sm text-gray-500">
              No activity in this range{jobId || workerId || codeId ? " for these filters" : ""}.
            </p>
          </div>
        ) : !showTimesheet ? (
          /* ---- Month view: worker × week ---- */
          <div className="space-y-2">
            <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
              <table className="w-full text-sm border-collapse min-w-[480px]">
                <thead>
                  <tr className="text-[10px] uppercase text-gray-500">
                    <th className="text-left font-semibold px-2 py-2 sticky left-0 bg-white">
                      Worker
                    </th>
                    {weekCols.map((wk) => (
                      <th key={wk.startISO} className="font-semibold px-2 py-2 text-center">
                        {wk.label}
                      </th>
                    ))}
                    <th className="font-semibold px-2 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => {
                    const wk = workerWeeks.get(w.id)!;
                    const isExpanded = expWeekValid && expWorkerId === w.id;
                    return (
                      <Fragment key={w.id}>
                        <tr className={`border-t border-gray-100 ${isExpanded ? "bg-blue-50/50" : ""}`}>
                          <td className={`px-2 py-2 font-medium text-gray-900 sticky left-0 truncate max-w-[140px] ${isExpanded ? "bg-blue-50/70" : "bg-white"}`}>
                            {w.name}
                          </td>
                          {weekCols.map((c, wi) => {
                            const ms = wk.ms[wi];
                            const flags = wk.flags[wi];
                            // Click toggles the week drill-down for this worker.
                            const target = `${w.id}:${c.startISO}`;
                            const href = reportHref({
                              expand: target === expand ? null : target,
                            });
                            return (
                              <td key={c.startISO} className="px-0 py-0">
                                <Link
                                  href={href}
                                  className={`block w-full text-center px-2 py-2 font-mono tabular-nums hover:bg-gray-50 ${
                                    ms > 0 ? "text-gray-900" : "text-gray-300"
                                  }`}
                                >
                                  {ms > 0 ? fmtHoursShort(ms) : "—"}
                                  {flags.pendingMs > 0 && pendingDot}
                                  {flags.openMs > 0 && openDot}
                                </Link>
                              </td>
                            );
                          })}
                          <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums text-gray-900">
                            {fmtHoursShort(w.ms)}
                            {w.openMs > 0 && openDot}
                          </td>
                        </tr>
                        {isExpanded && (
                          /* ---- Week layer: that worker's 7 days ---- */
                          <tr className="border-t border-gray-100">
                            <td colSpan={weekCols.length + 2} className="px-3 py-2 bg-blue-50/40">
                              <WeekDrillDown
                                worker={expWorkerRow}
                                weekStartISO={expWeekStartISO}
                                dayFilter={dayFilter}
                                reportHref={reportHref}
                                now={now}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                    <td className="px-2 py-2 text-gray-600 sticky left-0 bg-gray-50">
                      Weekly total
                    </td>
                    {weekTotals.map((ms, wi) => (
                      <td
                        key={wi}
                        className="px-2 py-2 text-center font-mono tabular-nums text-gray-900"
                      >
                        {ms > 0 ? fmtHoursShort(ms) : "—"}
                        {weekFlags[wi].pendingMs > 0 && pendingDot}
                        {weekFlags[wi].openMs > 0 && openDot}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-gray-900">
                      {fmtHoursShort(totalPayableMs)}
                      {totalOpenMs > 0 && openDot}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-500">
              Hours are Monday–Sunday weeks. <span className="inline-block w-2 h-2 rounded-full bg-amber-400 align-middle" /> unapproved
              (pending) hours —{" "}
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 align-middle" /> still
              clocked in (live time, kept out of payroll totals until clocked
              out). Rejected hours are excluded everywhere. Click a cell to see
              that worker&rsquo;s days.
            </p>
          </div>
        ) : (
          /* ---- ≤ 14 days: the original day × worker grid ---- */
          <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[640px]">
              <thead>
                <tr className="text-[10px] uppercase text-gray-500">
                  <th className="text-left font-semibold px-2 py-2 sticky left-0 bg-white">
                    Worker
                  </th>
                  {dayColumns.map((iso) => {
                    const d = new Date(iso + "T00:00:00");
                    return (
                      <th key={iso} className="font-semibold px-2 py-2 text-center">
                        {d.toLocaleDateString([], { weekday: "short" })}
                        <br />
                        {d.getDate()}
                      </th>
                    );
                  })}
                  <th className="font-semibold px-2 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-2 py-2 font-medium text-gray-900 sticky left-0 bg-white truncate max-w-[140px]">
                      {w.name}
                    </td>
                    {dayColumns.map((iso) => {
                      const cell = w.byDay[iso];
                      const ms = cell?.payableMs ?? 0;
                      const isOpen = (cell?.openMs ?? 0) > 0;
                      const hasPending = (cell?.pendingMs ?? 0) > 0;
                      return (
                        <td
                          key={iso}
                          className={`px-2 py-2 text-center font-mono tabular-nums ${
                            ms > 0 ? "text-gray-900" : "text-gray-300"
                          }`}
                        >
                          {ms > 0 ? fmtDuration(ms) : "—"}
                          {isOpen && openDot}
                          {hasPending && pendingDot}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums text-gray-900">
                      {fmtDuration(w.ms)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                  <td className="px-2 py-2 text-gray-600 sticky left-0 bg-gray-50">
                    Daily total
                  </td>
                  {dayColumns.map((iso) => (
                    <td
                      key={iso}
                      className="px-2 py-2 text-center font-mono tabular-nums text-gray-900"
                    >
                      {dayTotals[iso] > 0 ? fmtDuration(dayTotals[iso]) : "—"}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-gray-900">
                    {fmtDuration(totalPayableMs)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Per-worker cards */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
          By Worker ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center shadow-sm">
            <p className="text-sm text-gray-500">
              No activity in this range{jobId || workerId || codeId ? " for these filters" : ""}.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((w, i) => (
              <div key={i} className="bg-white rounded-lg p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">
                      {w.name}
                    </p>
                    <p className="text-xs text-gray-500 capitalize">
                      {w.role}
                    </p>
                  </div>
                  <div className="ml-2 text-right flex-shrink-0">
                    <span className="text-sm font-bold text-gray-900">
                      {fmtDuration(w.ms)}
                    </span>
                    {w.openMs > 0 && (
                      <p className="text-[10px] text-green-700">
                        {fmtDuration(w.openMs)} on clock now
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-2 text-center">
                  <div className="bg-gray-50 rounded p-1">
                    <Briefcase className="w-3 h-3 text-gray-400 mx-auto" />
                    <p className="text-xs font-semibold text-gray-900">
                      {w.projects.size}
                    </p>
                    <p className="text-[10px] text-gray-400">projects</p>
                  </div>
                  <div className="bg-gray-50 rounded p-1">
                    <Camera className="w-3 h-3 text-gray-400 mx-auto" />
                    <p className="text-xs font-semibold text-gray-900">
                      {w.photos}
                    </p>
                    <p className="text-[10px] text-gray-400">photos</p>
                  </div>
                  <div className="bg-gray-50 rounded p-1">
                    <Receipt className="w-3 h-3 text-gray-400 mx-auto" />
                    <p className="text-xs font-semibold text-gray-900">
                      {formatMoney(w.owed)}
                    </p>
                    <p className="text-[10px] text-gray-400">owed</p>
                  </div>
                </div>
                {w.projects.size > 0 && (
                  <p className="text-xs text-gray-500 mt-2">
                    {[...w.projects].sort().join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}

// ---- Week + day drill-down layers (server-rendered; no client state) ----
// props type is loose on purpose — reportHref is a closure over the page's
// filter params.
function WeekDrillDown({
  worker,
  weekStartISO,
  dayFilter,
  reportHref,
  now,
}: {
  worker: { id: string; name: string; byDay: Record<string, DayCell> };
  weekStartISO: string;
  dayFilter: string;
  reportHref: (opts?: { expand?: string | null; day?: string | null }) => string;
  now: number;
}) {
  // Same legend dots as the grid above — local copies because this is a
  // separate component from the page body.
  const pendingDot = (
    <span
      className="ml-1 inline-block w-2 h-2 rounded-full bg-amber-400 align-middle"
      title="Hours awaiting approval"
    />
  );
  const openDot = (
    <span
      className="ml-1 inline-block w-2 h-2 rounded-full bg-green-500 align-middle"
      title="Still clocked in"
    />
  );
  // Monday of the clicked week comes from the shared payroll-weeks helper
  // (weeks in this grid are the same Monday–Sunday buckets).
  const mondayISO = weekStart(weekStartISO);
  const dayISOs: string[] = [];
  for (let d = 0; d < 7; d++) {
    dayISOs.push(toISODate(addDays(new Date(`${mondayISO}T00:00:00`), d)));
  }
  const anything = dayISOs.some((iso) => worker.byDay[iso]);

  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-gray-700">
        {worker.name} — week of{" "}
        {new Date(`${weekStartISO}T00:00:00`).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        })}
      </p>
      {!anything && (
        <p className="text-xs text-gray-400">No hours logged this week.</p>
      )}
      <div className="divide-y divide-gray-100">
        {dayISOs.map((iso) => {
          const cell = worker.byDay[iso];
          const ms = cell?.payableMs ?? 0;
          const d = new Date(`${iso}T00:00:00`);
          const entries = cell?.entries ?? [];
          const isDayOpen = dayFilter === iso;
          return (
            <div key={iso} className="py-1">
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={reportHref({ day: iso === dayFilter ? null : iso })}
                  className={`text-xs font-medium truncate ${
                    entries.length === 0 && ms === 0
                      ? "text-gray-300"
                      : "text-gray-800 hover:text-blue-700"
                  }`}
                >
                  {d.toLocaleDateString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                  {ms > 0 && (cell?.pendingMs ?? 0) > 0 && pendingDot}
                </Link>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {(cell?.openMs ?? 0) > 0 && openDot}
                  {(cell?.pendingMs ?? 0) > 0 && (
                    <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">
                      pending
                    </span>
                  )}
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      ms > 0 ? "font-semibold text-gray-900" : "text-gray-300"
                    }`}
                  >
                    {ms > 0 ? fmtHoursShort(ms) : "—"}
                  </span>
                </div>
              </div>
              {/* ---- Day layer: the individual entries ---- */}
              {isDayOpen &&
                entries.map((e) => {
                  const rejected = e.status === "rejected";
                  const outMs = e.clock_out_at
                    ? new Date(e.clock_out_at).getTime()
                    : null;
                  return (
                    <div
                      key={e.id}
                      className={`pl-4 py-1 flex items-center justify-between gap-2 border-l-2 ${
                        rejected ? "border-red-200" : "border-gray-100"
                      }`}
                    >
                      <p
                        className={`text-xs truncate ${
                          rejected ? "text-gray-400 line-through" : "text-gray-700"
                        }`}
                      >
                        {new Date(e.clock_in_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {outMs !== null ? (
                          <>
                            {" → "}
                            {new Date(e.clock_out_at!).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </>
                        ) : (
                          <span className="text-green-600"> · still on</span>
                        )}
                        <span className="text-gray-500">
                          {" · "}
                          {/* job_id IS NULL = a whole-route Shift entry */}
                          {e.job?.name || "Shift"}
                        </span>
                        {e.note && (
                          <span className="text-gray-400"> · {e.note}</span>
                        )}
                      </p>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className={`font-mono text-xs tabular-nums ${
                            rejected ? "text-gray-300 line-through" : "text-gray-700"
                          }`}
                        >
                          {fmtHoursShort(
                            Math.max(
                              0,
                              (outMs ?? now) -
                                new Date(e.clock_in_at).getTime()
                            )
                          )}
                        </span>
                        <span
                          className={`text-[10px] rounded px-1 border ${
                            rejected
                              ? "text-red-700 bg-red-50 border-red-200"
                              : e.status === "approved"
                              ? "text-green-700 bg-green-50 border-green-200"
                              : "text-amber-700 bg-amber-50 border-amber-200"
                          }`}
                        >
                          {e.status}
                        </span>
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}