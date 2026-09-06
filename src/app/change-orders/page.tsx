import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { FIELD_MGMT, type Role } from "@/lib/roles";
import Link from "next/link";
import { Plus, ClipboardList, Download } from "lucide-react";
import { formatMoney } from "@/lib/money";
import ChangeOrderFilters from "@/components/ChangeOrderFilters";
import PageContainer from "@/components/PageContainer";
import { LinkButton } from "@/components/ui/Button";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";

type Row = {
  id: string;
  co_number: string | null;
  title: string;
  amount: number;
  is_credit: boolean;
  status: string;
  created_at: string;
  jobs: { name: string } | null;
};

// Change-order status → badge tone. Mirrors the previous statusCls() colors:
// approved green, rejected/void red, sent/submitted blue, everything else gray.
const STATUS_TONE: Record<string, BadgeTone> = {
  approved: "success",
  rejected: "danger",
  void: "danger",
  sent: "brand",
  submitted: "brand",
  draft: "neutral",
};

type ChangeOrderView = {
  id: string;
  coNumber: string | null;
  title: string;
  jobName: string;
  status: string;
  createdAt: string;
  signedAmount: number;
};

// Cards only — the Cards/Table switcher was a no-op (table just rendered the
// same rows as plain line items). Single-element MODES hides the ListToolbar
// switcher and forces `view` to always be "cards".
const MODES: ViewMode[] = ["cards"];

export default async function ChangeOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string }>;
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

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name")
    .order("name");

  let q = supabase
    .from("change_orders")
    .select(
      "id, co_number, title, amount, is_credit, status, created_at, jobs(name)"
    )
    .order("created_at", { ascending: false });
  if (jobFilter) q = q.eq("job_id", jobFilter);
  if (statusFilter) q = q.eq("status", statusFilter);
  const { data: rowsRaw } = await q;
  const rows: ChangeOrderView[] = ((rowsRaw ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    coNumber: r.co_number,
    title: r.title,
    jobName: r.jobs?.name ?? "",
    status: r.status,
    createdAt: r.created_at,
    signedAmount: r.is_credit ? -r.amount : r.amount,
  }));

  const exportHref = `/api/reports/change-orders?${jobFilter ? `job=${jobFilter}` : ""}${
    statusFilter ? `&status=${statusFilter}` : ""
  }`.replace(/^\/api\/reports\/change-orders\?&/, "/api/reports/change-orders?");

  return (
    <PageContainer title="Change Orders" subtitle="Scope & price changes" maxWidth="list">
      <ListToolbar
        modes={MODES}
        defaultMode="cards"
        count={rows.length}
        action={
          canCreate ? (
            <LinkButton href="/change-orders/new">
              <Plus className="w-4 h-4" />
              New
            </LinkButton>
          ) : undefined
        }
        filters={
          <div className="w-full">
            <ChangeOrderFilters
              jobs={jobs ?? []}
              currentJob={jobFilter}
              currentStatus={statusFilter}
            />
          </div>
        }
      />

      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line shadow-sm p-6 text-center">
          <ClipboardList className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-900">No change orders yet</p>
          <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
            Manage and track changes to your project scope and price.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/change-orders/${r.id}`}
              className="block bg-surface rounded-lg border border-line shadow-sm p-3 active:bg-gray-50"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate">
                    {r.coNumber ? `${r.coNumber} · ` : ""}
                    {r.title}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {r.jobName}
                    {` · ${new Date(r.createdAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-sm font-semibold text-gray-900">
                    {formatMoney(r.signedAmount)}
                  </span>
                  <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                    {r.status.replace("_", " ")}
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
