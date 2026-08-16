import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import { OFFICE_OR_PM } from "@/lib/roles";
import Link from "next/link";
import { Plus, ClipboardList, Download } from "lucide-react";
import DailyLogFilters from "@/components/DailyLogFilters";

type Row = {
  id: string;
  log_date: string;
  weather: string | null;
  status: string;
  created_at: string;
  jobs: { name: string } | null;
  creator: { full_name: string | null } | null;
};

export default async function DailyLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string; from?: string; to?: string }>;
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
  const role = profile?.role ?? "crew";
  if (!OFFICE_OR_PM.has(role)) redirect("/dashboard");
  const canCreate = role === "office" || role === "admin";

  const sp = await searchParams;
  const jobFilter = sp.job ?? "";
  const statusFilter = sp.status ?? "";
  const fromFilter = sp.from ?? "";
  const toFilter = sp.to ?? "";

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name")
    .order("name");

  let q = supabase
    .from("daily_logs")
    .select(
      "id, log_date, weather, status, created_at, jobs(name), creator:profiles!created_by(full_name)"
    )
    .order("created_at", { ascending: false });
  if (jobFilter) q = q.eq("job_id", jobFilter);
  if (statusFilter) q = q.eq("status", statusFilter);
  if (fromFilter) q = q.gte("log_date", fromFilter);
  if (toFilter) {
    const d = new Date(`${toFilter}T00:00:00`);
    d.setDate(d.getDate() + 1);
    q = q.lt("log_date", d.toISOString());
  }
  const { data: rowsRaw } = await q;
  const rows = (rowsRaw ?? []) as unknown as Row[];

  const exportParams = new URLSearchParams();
  if (jobFilter) exportParams.set("job", jobFilter);
  if (statusFilter) exportParams.set("status", statusFilter);
  if (fromFilter) exportParams.set("from", fromFilter);
  if (toFilter) exportParams.set("to", toFilter);
  const exportHref = `/api/reports/daily-logs?${exportParams.toString()}`;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Daily Logs" subtitle="Jobsite daily reports" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <DailyLogFilters
          jobs={jobs ?? []}
          currentJob={jobFilter}
          currentStatus={statusFilter}
          currentFrom={fromFilter}
          currentTo={toFilter}
        />
        {canCreate && (
          <Link
            href="/daily-logs/new"
            className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" /> New Daily Log
          </Link>
        )}
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center">
            <ClipboardList className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No daily logs yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
              Record daily activities, weather, and crew notes from the field.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const jobName = r.jobs?.name ?? "";
              const authorName = r.creator?.full_name ?? "";
              const weather = r.weather ?? "";
              const statusColor =
                r.status === "reviewed"
                  ? "bg-green-100 text-green-700"
                  : "bg-blue-100 text-blue-700";
              return (
                <Link
                  key={r.id}
                  href={`/daily-logs/${r.id}`}
                  className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">
                        {new Date(r.log_date).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {jobName}
                        {authorName ? ` · ${authorName}` : ""}
                        {weather ? ` · ${weather}` : ""}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColor}`}
                    >
                      {r.status}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
        {rows.length > 0 && (
          <Link
            href={exportHref}
            className="block bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" /> Export Excel ({rows.length})
          </Link>
        )}
      </main>
    </div>
  );
}