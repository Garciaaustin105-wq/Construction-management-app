import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { FIELD_MGMT, type Role } from "@/lib/roles";
import Link from "next/link";
import { Plus, CheckSquare } from "lucide-react";
import PunchFilters from "@/components/PunchFilters";
import PunchExportButton from "@/components/PunchExportButton";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import DataTable, { type Column } from "@/components/ui/DataTable";

type Row = {
  id: string;
  title: string;
  location: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  jobs: { name: string } | null;
  assignee: { full_name: string | null } | null;
};

// Punch status/priority → badge tone. Mirrors the previous statusCls() /
// priorityCls() colors.
const STATUS_TONE: Record<string, BadgeTone> = {
  complete: "success",
  in_progress: "warning",
  void: "muted",
  open: "neutral",
};
const PRIORITY_TONE: Record<string, BadgeTone> = {
  high: "danger",
  low: "muted",
  normal: "neutral",
};

type PunchView = {
  id: string;
  title: string;
  jobName: string;
  location: string;
  assigneeName: string;
  status: string;
  priority: string;
  dueDate: string | null;
};

// Cards only — the Cards/Table switcher was a no-op (table just rendered the
// same rows as plain line items). Single-element MODES hides the ListToolbar
// switcher and forces `view` to always be "cards".
const MODES: ViewMode[] = ["cards"];

export default async function PunchPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string; priority?: string; view?: string }>;
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
  const priorityFilter = sp.priority ?? "";
  const rawView = sp.view as ViewMode | undefined;
  const view: ViewMode = rawView && MODES.includes(rawView) ? rawView : "cards";

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name")
    .order("name");

  let q = supabase
    .from("punch_items")
    .select(
      "id, title, location, status, priority, due_date, created_at, assigned_to, jobs(name), assignee:profiles!assigned_to(full_name)"
    )
    .order("created_at", { ascending: false });
  if (jobFilter) q = q.eq("job_id", jobFilter);
  if (statusFilter) q = q.eq("status", statusFilter);
  if (priorityFilter) q = q.eq("priority", priorityFilter);
  const { data: rowsRaw } = await q;
  const rows: PunchView[] = ((rowsRaw ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    title: r.title,
    jobName: r.jobs?.name ?? "",
    location: r.location ?? "",
    assigneeName: r.assignee?.full_name ?? "",
    status: r.status,
    priority: r.priority,
    dueDate: r.due_date,
  }));

  const exportRows = rows.map((r) => ({
    title: r.title,
    job: r.jobName,
    location: r.location,
    assignee: r.assigneeName,
    status: r.status,
    priority: r.priority,
    due: r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "",
  }));

  const columns: Column<PunchView>[] = [
    {
      key: "title",
      header: "Item",
      cell: (r) => <span className="font-medium text-gray-900">{r.title}</span>,
    },
    { key: "job", header: "Job", cell: (r) => r.jobName || "—" },
    { key: "location", header: "Location", hideOnMobile: true, cell: (r) => r.location || "—" },
    { key: "assignee", header: "Assignee", hideOnMobile: true, cell: (r) => r.assigneeName || "—" },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
          {r.status.replace("_", " ")}
        </StatusBadge>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      hideOnMobile: true,
      cell: (r) => (
        <StatusBadge tone={PRIORITY_TONE[r.priority] ?? "neutral"}>{r.priority}</StatusBadge>
      ),
    },
    {
      key: "due",
      header: "Due",
      align: "right",
      hideOnMobile: true,
      cell: (r) => (r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "—"),
    },
  ];

  return (
    <PageContainer title="Punch List" subtitle="Closeout items & deficiencies" maxWidth="list">
      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={rows.length}
        action={
          canCreate ? (
            <LinkButton href="/punch/new">
              <Plus className="w-4 h-4" />
              New
            </LinkButton>
          ) : undefined
        }
        filters={
          <div className="w-full">
            <PunchFilters
              jobs={jobs ?? []}
              currentJob={jobFilter}
              currentStatus={statusFilter}
              currentPriority={priorityFilter}
            />
          </div>
        }
      />

      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line shadow-sm p-6 text-center">
          <CheckSquare className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-900">No punch items yet</p>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
            Track closeout items, deficiencies, and incomplete work.
          </p>
        </div>
      ) : view === "table" ? (
        <DataTable columns={columns} rows={rows} rowHref={(r) => `/punch/${r.id}`} />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/punch/${r.id}`}
              className="block bg-surface rounded-lg border border-line shadow-sm p-3 active:bg-gray-50"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate">{r.title}</p>
                  <p className="text-xs text-muted truncate">
                    {r.jobName}
                    {r.location ? ` · ${r.location}` : ""}
                    {r.assigneeName ? ` · ${r.assigneeName}` : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                    {r.status.replace("_", " ")}
                  </StatusBadge>
                  <StatusBadge tone={PRIORITY_TONE[r.priority] ?? "neutral"}>
                    {r.priority}
                  </StatusBadge>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length > 0 && <PunchExportButton rows={exportRows} />}
    </PageContainer>
  );
}
