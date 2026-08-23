import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { FIELD_MGMT, type Role } from "@/lib/roles";
import Link from "next/link";
import { Plus, FileText, Download } from "lucide-react";
import SubmittalFilters from "@/components/SubmittalFilters";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import DataTable, { type Column } from "@/components/ui/DataTable";

type Row = {
  id: string;
  submittal_number: string | null;
  title: string;
  csi_section: string | null;
  status: string;
  disposition: string | null;
  ball_in_court: string;
  created_at: string;
  jobs: { name: string } | null;
};

// Submittal status → badge tone. Mirrors the previous statusCls(): closed
// green, returned amber, submitted blue, everything else gray.
const STATUS_TONE: Record<string, BadgeTone> = {
  closed: "success",
  returned: "warning",
  submitted: "brand",
  draft: "neutral",
};

type SubmittalView = {
  id: string;
  submittalNumber: string | null;
  title: string;
  jobName: string;
  csiSection: string;
  status: string;
  ballInCourt: string;
  createdAt: string;
};

const MODES: ViewMode[] = ["cards", "table"];

// The ball-in-court pill was indigo-on-architect / gray otherwise. `brand` is
// the closest tone in the shared palette; office stays neutral.
function courtLabel(v: string): string {
  return v === "architect" ? "Architect" : "Office";
}

export default async function SubmittalsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string; view?: string }>;
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
  const rawView = sp.view as ViewMode | undefined;
  const view: ViewMode = rawView && MODES.includes(rawView) ? rawView : "cards";

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name")
    .order("name");

  let q = supabase
    .from("submittals")
    .select(
      "id, submittal_number, title, csi_section, status, disposition, ball_in_court, created_at, jobs(name)"
    )
    .order("created_at", { ascending: false });
  if (jobFilter) q = q.eq("job_id", jobFilter);
  if (statusFilter) q = q.eq("status", statusFilter);
  const { data: rowsRaw } = await q;
  const rows: SubmittalView[] = ((rowsRaw ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    submittalNumber: r.submittal_number,
    title: r.title,
    jobName: r.jobs?.name ?? "",
    csiSection: r.csi_section ?? "",
    status: r.status,
    ballInCourt: r.ball_in_court,
    createdAt: r.created_at,
  }));

  const exportHref = `/api/reports/submittals?${jobFilter ? `job=${jobFilter}` : ""}${
    statusFilter ? `&status=${statusFilter}` : ""
  }`.replace(/^\/api\/reports\/submittals\?&/, "/api/reports/submittals?");

  const columns: Column<SubmittalView>[] = [
    {
      key: "title",
      header: "Submittal",
      cell: (r) => (
        <span className="font-medium text-gray-900">
          {r.submittalNumber ? `${r.submittalNumber} · ` : ""}
          {r.title}
        </span>
      ),
    },
    { key: "job", header: "Job", cell: (r) => r.jobName || "—" },
    { key: "csi", header: "CSI", hideOnMobile: true, cell: (r) => r.csiSection || "—" },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>
      ),
    },
    {
      key: "court",
      header: "Ball in court",
      hideOnMobile: true,
      cell: (r) => (
        <StatusBadge tone={r.ballInCourt === "architect" ? "brand" : "neutral"}>
          {courtLabel(r.ballInCourt)}
        </StatusBadge>
      ),
    },
    {
      key: "date",
      header: "Created",
      hideOnMobile: true,
      cell: (r) => new Date(r.createdAt).toLocaleDateString(),
    },
  ];

  return (
    <PageContainer title="Submittals" subtitle="Submittal log & review" maxWidth="list">
      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={rows.length}
        action={
          canCreate ? (
            <LinkButton href="/submittals/new">
              <Plus className="w-4 h-4" />
              New
            </LinkButton>
          ) : undefined
        }
        filters={
          <div className="w-full">
            <SubmittalFilters
              jobs={jobs ?? []}
              currentJob={jobFilter}
              currentStatus={statusFilter}
            />
          </div>
        }
      />

      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line shadow-sm p-6 text-center">
          <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-900">No submittals yet</p>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
            Track submittals to architects, owners, and reviewers.
          </p>
        </div>
      ) : view === "table" ? (
        <DataTable columns={columns} rows={rows} rowHref={(r) => `/submittals/${r.id}`} />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/submittals/${r.id}`}
              className="block bg-surface rounded-lg border border-line shadow-sm p-3 active:bg-gray-50"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate">
                    {r.submittalNumber ? `${r.submittalNumber} · ` : ""}
                    {r.title}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {r.jobName}
                    {r.csiSection ? ` · ${r.csiSection}` : ""}
                    {` · ${new Date(r.createdAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>
                  <StatusBadge tone={r.ballInCourt === "architect" ? "brand" : "neutral"}>
                    {courtLabel(r.ballInCourt)}
                  </StatusBadge>
                </div>
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
          <Download className="w-4 h-4" /> Export Excel
        </Link>
      )}
    </PageContainer>
  );
}
