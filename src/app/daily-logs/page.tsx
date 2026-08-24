import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { FIELD_MGMT, type Role } from "@/lib/roles";
import Link from "next/link";
import { Plus, ClipboardList, Download } from "lucide-react";
import DailyLogFilters from "@/components/DailyLogFilters";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import DataTable, { type Column } from "@/components/ui/DataTable";

type Row = {
  id: string;
  log_date: string;
  weather: string | null;
  status: string;
  created_at: string;
  jobs: { name: string } | null;
  creator: { full_name: string | null } | null;
};

// Daily-log status → badge tone. Previously inline: reviewed green, everything
// else (submitted) blue.
const STATUS_TONE: Record<string, BadgeTone> = {
  reviewed: "success",
  submitted: "brand",
};

type DailyLogView = {
  id: string;
  logDate: string;
  jobName: string;
  authorName: string;
  weather: string;
  status: string;
};

// Cards only — the Cards/Table switcher was a no-op (table just rendered the
// same rows as plain line items). Single-element MODES hides the ListToolbar
// switcher and forces `view` to always be "cards".
const MODES: ViewMode[] = ["cards"];

export default async function DailyLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string; from?: string; to?: string; view?: string }>;
}) {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role as Role;
  // Field-management review: superintendent + PM + office + admin/super_admin.
  // Authoring (canCreate) stays office/admin.
  if (!FIELD_MGMT.has(role)) redirect("/dashboard");
  const canCreate = role === "office" || role === "admin";

  const sp = await searchParams;
  const jobFilter = sp.job ?? "";
  const statusFilter = sp.status ?? "";
  const fromFilter = sp.from ?? "";
  const toFilter = sp.to ?? "";
  const rawView = sp.view as ViewMode | undefined;
  const view: ViewMode = rawView && MODES.includes(rawView) ? rawView : "cards";

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
  const rows: DailyLogView[] = ((rowsRaw ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    logDate: r.log_date,
    jobName: r.jobs?.name ?? "",
    authorName: r.creator?.full_name ?? "",
    weather: r.weather ?? "",
    status: r.status,
  }));

  const exportParams = new URLSearchParams();
  if (jobFilter) exportParams.set("job", jobFilter);
  if (statusFilter) exportParams.set("status", statusFilter);
  if (fromFilter) exportParams.set("from", fromFilter);
  if (toFilter) exportParams.set("to", toFilter);
  const exportHref = `/api/reports/daily-logs?${exportParams.toString()}`;

  const columns: Column<DailyLogView>[] = [
    {
      key: "date",
      header: "Date",
      cell: (r) => (
        <span className="font-medium text-gray-900">
          {new Date(r.logDate).toLocaleDateString()}
        </span>
      ),
    },
    { key: "job", header: "Job", cell: (r) => r.jobName || "—" },
    { key: "author", header: "Author", hideOnMobile: true, cell: (r) => r.authorName || "—" },
    { key: "weather", header: "Weather", hideOnMobile: true, cell: (r) => r.weather || "—" },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>
      ),
    },
  ];

  return (
    <PageContainer title="Daily Logs" subtitle="Jobsite daily reports" maxWidth="list">
      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={rows.length}
        action={
          canCreate ? (
            <LinkButton href="/daily-logs/new">
              <Plus className="w-4 h-4" />
              New
            </LinkButton>
          ) : undefined
        }
        filters={
          <div className="w-full">
            <DailyLogFilters
              jobs={jobs ?? []}
              currentJob={jobFilter}
              currentStatus={statusFilter}
              currentFrom={fromFilter}
              currentTo={toFilter}
            />
          </div>
        }
      />

      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line shadow-sm p-6 text-center">
          <ClipboardList className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-900">No daily logs yet</p>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
            Record daily activities, weather, and crew notes from the field.
          </p>
        </div>
      ) : view === "table" ? (
        <DataTable columns={columns} rows={rows} rowHref={(r) => `/daily-logs/${r.id}`} />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/daily-logs/${r.id}`}
              className="block bg-surface rounded-lg border border-line shadow-sm p-3 active:bg-gray-50"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate">
                    {new Date(r.logDate).toLocaleDateString()}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {r.jobName}
                    {r.authorName ? ` · ${r.authorName}` : ""}
                    {r.weather ? ` · ${r.weather}` : ""}
                  </p>
                </div>
                <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <Link
          href={exportHref}
          className="flex items-center justify-center gap-2 bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50"
        >
          <Download className="w-4 h-4" /> Export Excel ({rows.length})
        </Link>
      )}
    </PageContainer>
  );
}
