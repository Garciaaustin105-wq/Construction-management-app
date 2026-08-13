import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import {
  parseWeekStart,
  addDays,
  toISODate,
  fmtDuration,
  hoursFromMs,
} from "@/lib/weekUtils";
import { formatMoney } from "@/lib/money";
import { Download, ChevronLeft, ChevronRight, Camera, Receipt, Briefcase } from "lucide-react";

export default async function WeeklyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ weekStart?: string }>;
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
  const weekStart = parseWeekStart(sp.weekStart);
  const weekEnd = addDays(weekStart, 7);
  const startISO = weekStart.toISOString();
  const endISO = weekEnd.toISOString();
  const now = Date.now();

  const prevWeek = toISODate(addDays(weekStart, -7));
  const nextWeek = toISODate(addDays(weekStart, 7));
  const fileDate = toISODate(weekStart);
  const weekLabel = `${weekStart.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })} – ${addDays(weekStart, 6).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}`;

  const [timeRes, photoRes, receiptRes, profileRes] = await Promise.all([
    supabase
      .from("time_entries")
      .select(
        "user_id, clock_in_at, clock_out_at, job:jobs(name)"
      )
      .gte("clock_in_at", startISO)
      .lt("clock_in_at", endISO),
    supabase
      .from("photos")
      .select("uploaded_by, created_at, job:jobs(name)")
      .gte("created_at", startISO)
      .lt("created_at", endISO),
    supabase
      .from("receipts")
      .select("uploaded_by, amount, reimbursed, job:jobs(name)")
      .gte("captured_at", startISO)
      .lt("captured_at", endISO),
    supabase.from("profiles").select("id, full_name, role"),
  ]);

  const profiles = new Map<string, { name: string; role: string }>();
  for (const p of (profileRes.data ?? []) as {
    id: string;
    full_name: string | null;
    role: string | null;
  }[]) {
    profiles.set(p.id, { name: p.full_name ?? "Unknown", role: p.role ?? "—" });
  }
  const nameOf = (id: string | null) =>
    (id && profiles.get(id)?.name) ?? "Unknown";

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
    const w = ensure(t.user_id);
    w.ms += Math.max(0, end - new Date(t.clock_in_at).getTime());
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Weekly Report" />

      <main className="max-w-md mx-auto p-4 space-y-4">
        {/* Week navigator */}
        <div className="bg-white rounded-lg p-3 shadow-sm flex items-center justify-between">
          <Link
            href={`/admin/reports/weekly?weekStart=${prevWeek}`}
            className="p-2 rounded-lg hover:bg-gray-100 active:bg-gray-100"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <span className="font-semibold text-gray-900">{weekLabel}</span>
          <Link
            href={`/admin/reports/weekly?weekStart=${nextWeek}`}
            className="p-2 rounded-lg hover:bg-gray-100 active:bg-gray-100"
          >
            <ChevronRight className="w-5 h-5 text-gray-600" />
          </Link>
        </div>

        {/* Download */}
        <a
          href={`/api/reports/weekly?weekStart=${fileDate}`}
          download
          className="w-full bg-green-600 text-white py-4 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2"
        >
          <Download className="w-5 h-5" />
          Download Excel
        </a>

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

        {/* Per-worker cards */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
            By Worker ({rows.length})
          </h2>
          {rows.length === 0 ? (
            <div className="bg-white rounded-lg p-6 text-center shadow-sm">
              <p className="text-sm text-gray-500">
                No activity this week.
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
                    <p className="text-xs text-gray-500 mt-2 truncate">
                      {[...w.projects].join(", ")}
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