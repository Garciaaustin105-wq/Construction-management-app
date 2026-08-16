import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import WeeklyReportFilters from "@/components/WeeklyReportFilters";
import {
  addDays,
  toISODate,
  fmtDuration,
  hoursFromMs,
} from "@/lib/weekUtils";
import { resolveReportRange, rangeDayCount } from "@/lib/reports";
import { formatMoney } from "@/lib/money";
import { Download, Camera, Receipt, Briefcase } from "lucide-react";
import { isLawn } from "@/lib/variant";

export const dynamic = "force-dynamic";

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
  }>;
}) {
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
  const reportRole = profile?.role ?? "crew";
  if (reportRole !== "office" && reportRole !== "admin") redirect("/dashboard");

  const sp = await searchParams;
  const jobId = sp.job || null;
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
          .select("user_id, clock_in_at, clock_out_at, job:jobs(name)")
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
  type TimeRow = {
    user_id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    job: { name: string | null } | null;
  };
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
      ms: number;
      // Per-day ms bucketed by the clock-in date — drives the on-screen
      // timesheet grid. (A shift spanning midnight is attributed to its
      // clock-in day; same convention as the Excel "Daily Hours" sheet.)
      byDay: Record<string, number>;
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

  for (const t of (timeRes.data ?? []) as unknown as TimeRow[]) {
    const end = t.clock_out_at ? new Date(t.clock_out_at).getTime() : now;
    const elapsed = Math.max(0, end - new Date(t.clock_in_at).getTime());
    const w = ensure(t.user_id);
    w.ms += elapsed;
    const day = toISODate(new Date(t.clock_in_at));
    w.byDay[day] = (w.byDay[day] ?? 0) + elapsed;
    const j = t.job?.name;
    if (j) w.projects.add(j);
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

  const rows = [...workers.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const totalHours = rows.reduce((s, r) => s + hoursFromMs(r.ms), 0);
  const totalPhotos = rows.reduce((s, r) => s + r.photos, 0);
  const totalSubmitted = rows.reduce((s, r) => s + r.submitted, 0);
  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);

  // Day columns for the on-screen timesheet grid (one per day in the range).
  // The grid is only rendered for ranges of 2 weeks or shorter — longer ranges
  // are too wide on mobile; the Excel export still has the Daily Hours sheet.
  const showTimesheet = dayCount <= 14;
  const dayColumns: string[] = [];
  for (let d = 0; d < dayCount; d++) dayColumns.push(toISODate(addDays(from, d)));
  const dayTotals: Record<string, number> = {};
  for (const iso of dayColumns) dayTotals[iso] = 0;
  for (const r of rows) {
    for (const iso of dayColumns) dayTotals[iso] += r.byDay[iso] ?? 0;
  }

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

  const current = {
    job: jobId ?? "",
    worker: workerId ?? "",
    code: codeId ?? "",
    from: toISODate(from),
    to: toISODate(toInclusive),
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Per-Worker Report" subtitle={rangeLabel} />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <Link href="/admin/reports" className="text-xs text-blue-600 font-medium">
          ← All reports
        </Link>

        {/* Filters (date range + job / worker / cost code) */}
        <div className="bg-white rounded-lg p-3 shadow-sm">
          <WeeklyReportFilters
            jobs={jobs}
            workers={workerOptions}
            costCodes={costCodes}
            current={current}
            showCostCode={!isLawn()}
          />
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
              {fmtDuration(totalHours * 3_600_000)}
            </p>
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

        {/* On-screen timesheet — day × worker hours grid (the in-app
            "timesheet"; the Excel export already has a Daily Hours sheet).
            Only for ranges ≤ 14 days so it stays readable on mobile. */}
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
            <div className="bg-white rounded-lg p-4 shadow-sm">
              <p className="text-sm text-gray-500">
                This range is {dayCount} days — too wide for the on-screen grid.
                Switch to a 2-week or shorter range to see the day-by-day
                timesheet, or download the Excel (Daily Hours sheet).
              </p>
            </div>
          ) : (
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
                        const ms = w.byDay[iso] ?? 0;
                        return (
                          <td
                            key={iso}
                            className={`px-2 py-2 text-center font-mono tabular-nums ${
                              ms > 0 ? "text-gray-900" : "text-gray-300"
                            }`}
                          >
                            {ms > 0 ? fmtDuration(ms) : "—"}
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
                      {fmtDuration(totalHours * 3_600_000)}
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
                    <span className="text-sm font-bold text-gray-900">
                      {fmtDuration(w.ms)}
                    </span>
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
      </main>
    </div>
  );
}