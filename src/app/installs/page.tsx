import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import { Plus, Radio, AlertTriangle, Clock } from "lucide-react";
import { OFFICE_LIKE, FIELD_MGMT, type Role } from "@/lib/roles";
import InstallFilters from "@/components/InstallFilters";
import {
  statusCls,
  statusLabel,
  money,
  whenLabel,
  priorityCls,
  priorityLabel,
} from "@/lib/installs";

// Installs list — the ISP / fiber module's main office surface.
//
// VISIBILITY: this page is reachable only when the caller's org has
// `isp_module_enabled` (checked below and redirected away otherwise), but the
// real protection is RLS: a user in any other org gets zero rows from every
// query here regardless of how they reached the URL. The flag gates the tab and
// the page; RLS gates the data. See src/lib/useIspModule.ts.
//
// Crew see this page too, filtered by RLS to installs they're assigned to —
// it's their work list. They get no create button and no filters they can't
// act on.
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  price: number | string | null;
  address: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  has_open_problem: boolean;
  completion_outcome: string | null;
  install_types: { name: string } | null;
  customers: { name: string } | null;
};

export default async function InstallsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    priority?: string;
    problems?: string;
    attention?: string;
  }>;
}) {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role as Role;

  // Customers never get the internal installs list (they'd see price + notes).
  if (role === "customer") redirect("/dashboard");

  // Module gate. Server-side twin of the nav gate — someone who types /installs
  // in an org without the module lands back on their dashboard instead of an
  // empty page that looks broken.
  if (!me.orgId) redirect("/dashboard");
  const { data: org } = await supabase
    .from("organizations")
    .select("isp_module_enabled")
    .eq("id", me.orgId)
    .maybeSingle();
  if (!org?.isp_module_enabled) redirect("/dashboard");

  const canCreate = OFFICE_LIKE.has(role) || role === "project_manager";
  const isOfficeSide = FIELD_MGMT.has(role);

  const sp = await searchParams;
  const statusFilter = sp.status ?? "";
  const priorityFilter = sp.priority ?? "";
  const problemsOnly = sp.problems === "1";
  // "Needs attention" is the office's real working queue: anything a crew left
  // unfinished OR anything with a problem still open. It deliberately spans two
  // columns, because those are two different ways the same install can be
  // stuck and the office cares about both in one list.
  const attentionOnly = sp.attention === "1";

  const SELECT =
    "id, title, status, priority, price, address, scheduled_at, started_at, has_open_problem, completion_outcome, install_types(name), customers(name)";
  const base = () =>
    supabase
      .from("installs")
      .select(SELECT)
      .order("scheduled_at", { ascending: true, nullsFirst: false })
      .limit(500);

  let rowsUnsorted: Row[];

  if (attentionOnly) {
    // "Needs attention" spans TWO columns — an unfinished visit
    // (status = needs_followup) or an open problem (has_open_problem). Rather
    // than one `.or()` filter, this runs both as plain `.eq` queries and merges
    // them. Two reasons: `.eq` is the filter shape used everywhere else in this
    // codebase (`.or()` appears nowhere, so it would be the one untested query
    // form in the app), and merging two independently-capped result sets can't
    // lose an attention item behind the 500-row limit the way a single capped
    // query could.
    const [followupRes, problemRes] = await Promise.all([
      base().eq("status", "needs_followup"),
      base().eq("has_open_problem", true),
    ]);
    const merged = new Map<string, Row>();
    for (const r of [
      ...((followupRes.data ?? []) as unknown as Row[]),
      ...((problemRes.data ?? []) as unknown as Row[]),
    ]) {
      merged.set(r.id, r); // an install can match both; dedupe by id
    }
    rowsUnsorted = [...merged.values()];
  } else {
    let q = base();
    if (statusFilter) q = q.eq("status", statusFilter);
    if (priorityFilter) q = q.eq("priority", priorityFilter);
    if (problemsOnly) q = q.eq("has_open_problem", true);
    const { data } = await q;
    rowsUnsorted = (data ?? []) as unknown as Row[];
  }

  // Float anything needing attention to the top, then keep the soonest-first
  // ordering within each group. Done here rather than in SQL because "needs
  // attention" isn't a single column — sorting on it in Postgres would need a
  // CASE expression Supabase's query builder can't express, and the list is
  // capped at 500 rows so the cost is nil.
  const needsAttention = (r: Row) =>
    r.has_open_problem || r.status === "needs_followup";
  const rows = [...rowsUnsorted].sort((a, b) => {
    const aa = needsAttention(a) ? 0 : 1;
    const bb = needsAttention(b) ? 0 : 1;
    if (aa !== bb) return aa - bb;
    // nulls last within a group
    if (!a.scheduled_at) return b.scheduled_at ? 1 : 0;
    if (!b.scheduled_at) return -1;
    return a.scheduled_at.localeCompare(b.scheduled_at);
  });

  // Follow-up queue counters — the reason needs_followup exists as its own
  // status rather than being folded into "completed".
  const needsFollowup = rows.filter((r) => r.status === "needs_followup").length;
  const withProblems = rows.filter((r) => r.has_open_problem).length;
  const attentionCount = rows.filter(needsAttention).length;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title="Installs"
        subtitle={isOfficeSide ? "Fiber installs & service calls" : "Your assigned installs"}
      />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        {isOfficeSide && attentionCount > 0 && !attentionOnly && (
          <Link
            href="/installs?attention=1"
            className="block bg-amber-50 border border-amber-200 rounded-lg p-3 active:bg-amber-100"
          >
            <p className="text-sm font-semibold text-amber-900">
              {attentionCount} install{attentionCount === 1 ? "" : "s"} need attention
            </p>
            <p className="text-xs text-amber-700">
              Unfinished visits and open problems, in one list
            </p>
          </Link>
        )}

        {isOfficeSide && (needsFollowup > 0 || withProblems > 0) && (
          <div className="flex gap-2">
            {needsFollowup > 0 && (
              <Link
                href="/installs?status=needs_followup"
                className="flex-1 bg-orange-50 border border-orange-200 rounded-lg p-3 active:bg-orange-100"
              >
                <p className="text-lg font-bold text-orange-800">{needsFollowup}</p>
                <p className="text-xs text-orange-700">Need follow-up</p>
              </Link>
            )}
            {withProblems > 0 && (
              <Link
                href="/installs?problems=1"
                className="flex-1 bg-red-50 border border-red-200 rounded-lg p-3 active:bg-red-100"
              >
                <p className="text-lg font-bold text-red-800">{withProblems}</p>
                <p className="text-xs text-red-700">Open problems</p>
              </Link>
            )}
          </div>
        )}

        {isOfficeSide && (
          <InstallFilters
            currentStatus={statusFilter}
            currentPriority={priorityFilter}
            problemsOnly={problemsOnly}
            attentionOnly={attentionOnly}
          />
        )}

        {canCreate && (
          <Link
            href="/installs/new"
            className="bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" /> New Install
          </Link>
        )}

        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center">
            <Radio className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">
              {statusFilter || priorityFilter || problemsOnly || attentionOnly
                ? "Nothing matches that filter"
                : "No installs yet"}
            </p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
              {isOfficeSide
                ? "Schedule a fiber install or service call and assign it to a crew."
                : "Installs assigned to you will show up here."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/installs/${r.id}`}
                className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate flex items-center gap-1.5">
                      {r.has_open_problem && (
                        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                      )}
                      {r.title}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {r.install_types?.name ?? "Install"}
                      {r.customers?.name ? ` · ${r.customers.name}` : ""}
                      {r.address ? ` · ${r.address}` : ""}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {whenLabel(r.scheduled_at)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusCls(r.status)}`}
                    >
                      {statusLabel(r.status)}
                    </span>
                    {r.priority && r.priority !== "normal" && (
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${priorityCls(r.priority)}`}
                      >
                        {priorityLabel(r.priority)}
                      </span>
                    )}
                    {isOfficeSide && (
                      <span className="text-xs font-medium text-gray-700">
                        {money(r.price)}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
