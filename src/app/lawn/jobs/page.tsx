"use client";
import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/components/Toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { OFFICE_OR_PM } from "@/lib/roles";
import dynamic from "next/dynamic";
import { formatBlockedBy } from "@/components/DeleteJobButton";
import { Plus, ArrowLeft, ListChecks, Loader2, Layers, Search, ArrowUpDown, ArrowUp, ArrowDown, Archive, ArchiveRestore, Trash2 } from "lucide-react";

// Interaction-only modal — only mounts once "Bulk edit" is pressed, so its form
// state + markup stay out of the page's first-load bundle.
const BulkScheduleEditModal = dynamic(
  () => import("@/components/BulkScheduleEditModal"),
  { ssr: false }
);

// Shape of the recurring_schedules select below (with the nested jobs/customers
// join). Replaces `any[]`, which lost all type safety on the sort + render.
type SortKey = "name" | "service" | "crew" | "status";
type SortDir = "asc" | "desc";
type ScheduleRow = {
  id: string;
  job_id: string | null;
  active: boolean | null;
  service_type: string | null;
  price_per_visit: number | string | null;
  frequency: string | null;
  interval_weeks: number | null;
  days_of_week: number[] | null;
  day_of_month: number | null;
  paused_from: string | null;
  paused_until: string | null;
  created_at: string | null;
  jobs: {
    name: string | null;
    address: string | null;
    customer_id: string | null;
    assigned_crew: string[] | null;
    // jobs.archived_at — archiving is visibility, not a schedule status.
    archived_at: string | null;
    customers: { name: string | null } | null;
  } | null;
};

// Sort header pieces at module scope — the react-hooks/static-components rule
// rejects components created during render.
function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ArrowUpDown className="w-3 h-3 text-gray-300" />;
  return sortDir === "asc" ? (
    <ArrowUp className="w-3 h-3 text-gray-700" />
  ) : (
    <ArrowDown className="w-3 h-3 text-gray-700" />
  );
}

function Th({ col, label, sortKey, sortDir, onSort }: { col: SortKey; label: string; sortKey: SortKey; sortDir: SortDir; onSort: (key: SortKey) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className="flex items-center gap-1 hover:text-gray-900 transition-colors"
    >
      {label}
      <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
    </button>
  );
}

export default function LawnJobsPage() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [crewMap, setCrewMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "archived">("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      router.push("/login");
      return;
    }
    const { data: profile } = await supabase.from("profiles").select("role, organization_id").eq("id", user.id).single();
    const role = profile?.role ?? "crew";
    if (!OFFICE_OR_PM.has(role as never) || !profile?.organization_id) {
      router.push("/dashboard");
      return;
    }
    setAuthorized(true);

    const [schedRes, crewRes] = await Promise.all([
      supabase.from("recurring_schedules").select("id, job_id, active, service_type, price_per_visit, frequency, interval_weeks, days_of_week, day_of_month, paused_from, paused_until, created_at, jobs(name, address, customer_id, assigned_crew, archived_at, customers(name))").order("active", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("crew_members").select("id, name").order("name")
    ]);

    const map: Record<string, string> = {};
    for (const c of (crewRes.data ?? [])) map[c.id] = c.name;
    setCrewMap(map);

    let list = (schedRes.data ?? []) as unknown as ScheduleRow[];
    list = [...list].sort((x, y) => {
      if ((x.active ? 1 : 0) !== (y.active ? 1 : 0)) return (x.active ? 1 : 0) ? -1 : 1;
      const an = x.jobs?.name ?? "";
      const bn = y.jobs?.name ?? "";
      return an.localeCompare(bn);
    });

    setRows(list);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    // fetchData is also called directly from the bulk-edit modal's onDone (to
    // refresh after a save), so it's a stable useCallback rather than an
    // inline IIFE — this initial-load call is the standard data-fetch-on-
    // mount pattern, not a cascading-render risk.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Selects/clears the currently visible (filtered) rows, not the whole
  // dataset — bulk-editing a search/filter result shouldn't silently sweep in
  // rows the office can't see on screen.
  function toggleAll() {
    setSelected((prev) =>
      prev.size === displayRows.length
        ? new Set()
        : new Set(displayRows.map((d) => d.row.id))
    );
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // Enrich once (name/customer/service/crew display strings), then
  // search-filter, status-filter, and sort — shared by both the mobile card
  // list and the desktop table so they never disagree about what's visible.
  // Not wrapped in useMemo: the React Compiler cannot preserve this
  // memoization (pre-existing lint error) and memoizes pure computations
  // like this one itself.
  const displayRows = (() => {
    const enriched = rows.map((s) => {
      const crewIds: string[] = Array.isArray(s.jobs?.assigned_crew) ? s.jobs.assigned_crew : [];
      return {
        row: s,
        jobName: s.jobs?.name ?? "Untitled",
        custName: s.jobs?.customers?.name ?? null,
        service: s.service_type ?? "Service",
        crewNames: crewIds.map((id) => crewMap[id]).filter(Boolean).join(", "),
      };
    });
    const q = query.trim().toLowerCase();
    const filtered = enriched.filter((e) => {
      // Archived rides on jobs.archived_at, above schedule active/paused:
      // every non-archived tab excludes it, the Archived tab shows only it.
      const archived = e.row.jobs?.archived_at != null;
      if (statusFilter === "archived" && !archived) return false;
      if (statusFilter !== "archived" && archived) return false;
      if (statusFilter === "active" && !e.row.active) return false;
      if (statusFilter === "paused" && e.row.active) return false;
      if (!q) return true;
      return (
        e.jobName.toLowerCase().includes(q) ||
        (e.custName ?? "").toLowerCase().includes(q) ||
        e.service.toLowerCase().includes(q) ||
        e.crewNames.toLowerCase().includes(q)
      );
    });
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.jobName.localeCompare(b.jobName);
          break;
        case "service":
          cmp = a.service.localeCompare(b.service);
          break;
        case "crew":
          cmp = (a.crewNames || "Unassigned").localeCompare(b.crewNames || "Unassigned");
          break;
        case "status":
          cmp = (a.row.active ? 1 : 0) - (b.row.active ? 1 : 0);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  })();

  async function setArchived(jobId: string, archived: boolean) {
    setRowBusy(jobId);
    const supabase = createClient();
    const { error } = await supabase
      .from("jobs")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", jobId);
    setRowBusy(null);
    if (error) {
      toast.error(`Failed to ${archived ? "archive" : "un-archive"}: ${error.message}`);
      return;
    }
    toast.success(archived ? "Archived" : "Un-archived");
    fetchData();
  }

  // Delete goes through the delete_job_if_empty RPC — the only permitted
  // path (a bare jobs.delete() cascades billing + pesticide history). Storage
  // files are gathered first (reading is harmless) and removed only AFTER the
  // RPC reports deleted: true — the inverse of the old construction flow that
  // destroyed files before knowing whether the delete would succeed.
  async function deleteJob(jobId: string) {
    setRowBusy(jobId);
    const supabase = createClient();
    try {
      const [photosRes, blueprintsRes] = await Promise.all([
        supabase.from("photos").select("storage_path").eq("job_id", jobId),
        supabase.from("blueprints").select("storage_path").eq("job_id", jobId),
      ]);
      const photoPaths = (photosRes.data ?? []).map((p) => p.storage_path);
      const blueprintPaths = (blueprintsRes.data ?? []).map((b) => b.storage_path);

      const { data, error } = await supabase.rpc("delete_job_if_empty", {
        p_job_id: jobId,
      });
      if (error) {
        toast.error(`Failed to delete: ${error.message}`);
        return;
      }
      const result = data as {
        deleted: boolean;
        blocked_by?: Record<string, number>;
      } | null;
      if (!result?.deleted) {
        // A refusal with reasons, not an error — say what's in the way.
        toast.warning(
          result?.blocked_by &&
            Object.values(result.blocked_by).some((n) => n > 0)
            ? `Can't delete — it has ${formatBlockedBy(result.blocked_by)}. Archive it instead.`
            : "Can't delete this job. Archive it instead."
        );
        return;
      }
      if (photoPaths.length > 0) {
        await supabase.storage.from("job-photos").remove(photoPaths);
      }
      if (blueprintPaths.length > 0) {
        await supabase.storage.from("blueprints").remove(blueprintPaths);
      }
      toast.success("Job deleted");
    } finally {
      setRowBusy(null);
      setConfirmDeleteId(null);
      fetchData();
    }
  }

  if (!authorized) return null;
  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <Loader2 className="w-6 h-6 text-green-600 animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button type="button" onClick={() => router.push("/lawn")} className="text-sm text-green-700 px-2 py-1 -ml-2 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Lawn
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate flex items-center gap-1.5">
          <ListChecks className="w-5 h-5 text-green-600" /> Lawn Jobs
        </h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-6xl mx-auto p-4 pb-24 space-y-3">
        <Link href="/lawn/new" className="block lg:inline-flex lg:w-auto bg-green-600 text-white text-center py-3 lg:px-5 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2">
          <Plus className="w-5 h-5" /> New lawn job
        </Link>
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 shadow-sm text-center text-sm text-gray-500">
            No lawn jobs yet. Tap New lawn job to add one.
          </div>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <div className="relative flex-1 sm:max-w-xs">
                <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search job, customer, crew…"
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500/40"
                />
              </div>
              <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 self-start">
                {(["all", "active", "paused", "archived"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setStatusFilter(f)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                      statusFilter === f ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs font-medium text-gray-500 px-1">
              <input
                type="checkbox"
                checked={displayRows.length > 0 && selected.size === displayRows.length}
                onChange={toggleAll}
              />
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </label>

            {displayRows.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">
                {statusFilter === "archived" ? "No archived jobs." : "No jobs match your filters."}
              </p>
            ) : (
              <>
                {/* Mobile: card list */}
                <div className="space-y-2 lg:hidden">
                  {displayRows.map(({ row: s, jobName, custName, service, crewNames }) => {
                    const archived = s.jobs?.archived_at != null;
                    const busy = rowBusy === s.id;
                    return (
                      <div key={s.id} className="bg-white rounded-lg shadow-sm">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected.has(s.id)}
                            onChange={() => toggleOne(s.id)}
                            className="ml-3 flex-shrink-0"
                          />
                          <Link href={`/lawn/schedules/${s.id}`} className="flex-1 min-w-0 p-3 pl-2 active:bg-gray-50">
                            <div className="flex justify-between items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold text-gray-900 truncate">{jobName}</p>
                                <p className="text-xs text-gray-500 truncate">{custName ? custName + " - " : ""}{service}</p>
                                <p className="text-xs text-gray-400 mt-0.5 truncate">Crew: {crewNames || "Unassigned"}</p>
                              </div>
                              {archived ? (
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap bg-amber-100 text-amber-800">Archived</span>
                              ) : (
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                              )}
                            </div>
                          </Link>
                        </div>
                        {/* Row actions — archive always, delete only through the
                            RPC (which refuses jobs with history). */}
                        {s.job_id && (
                          <div className="flex items-center gap-1 border-t border-gray-100 px-3 py-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setArchived(s.job_id!, !archived)}
                              className="text-xs font-medium text-gray-600 px-2 py-1 rounded active:bg-gray-100 flex items-center gap-1 disabled:opacity-50"
                            >
                              {archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                              {archived ? "Un-archive" : "Archive"}
                            </button>
                            {confirmDeleteId === s.id ? (
                              <>
                                <span className="text-xs text-red-700 ml-1">Delete this job?</span>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => deleteJob(s.job_id!)}
                                  className="text-xs font-semibold text-white bg-red-600 px-2 py-1 rounded-lg active:bg-red-700 flex items-center gap-1 disabled:opacity-50 ml-auto"
                                >
                                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="text-xs font-medium text-gray-600 px-2 py-1 rounded active:bg-gray-100"
                                >
                                  Keep
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmDeleteId(s.id)}
                                className="text-xs font-medium text-red-600 px-2 py-1 rounded active:bg-red-50 flex items-center gap-1 disabled:opacity-50 ml-auto"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop: real table */}
                <div className="hidden lg:block rounded-lg border border-gray-200 shadow-sm overflow-hidden bg-white">
                  <div className="grid grid-cols-[28px_1fr_160px_1fr_110px_210px] gap-3 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                    <span />
                    <Th col="name" label="Job / Customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th col="service" label="Service" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th col="crew" label="Crew" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <span>Actions</span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {displayRows.map(({ row: s, jobName, custName, service, crewNames }) => {
                      const archived = s.jobs?.archived_at != null;
                      const busy = rowBusy === s.id;
                      return (
                        <div key={s.id} className="grid grid-cols-[28px_1fr_160px_1fr_110px_210px] gap-3 px-4 py-2.5 items-center hover:bg-gray-50 transition-colors">
                          <input
                            type="checkbox"
                            checked={selected.has(s.id)}
                            onChange={() => toggleOne(s.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <Link href={`/lawn/schedules/${s.id}`} className="min-w-0">
                            <p className="font-medium text-gray-900 truncate">{jobName}</p>
                            {custName && <p className="text-xs text-gray-500 truncate">{custName}</p>}
                          </Link>
                          <Link href={`/lawn/schedules/${s.id}`} className="text-sm text-gray-600 truncate">
                            {service}
                          </Link>
                          <Link href={`/lawn/schedules/${s.id}`} className="text-sm text-gray-500 truncate">
                            {crewNames || "Unassigned"}
                          </Link>
                          <Link href={`/lawn/schedules/${s.id}`}>
                            {archived ? (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap bg-amber-100 text-amber-800">Archived</span>
                            ) : (
                              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                            )}
                          </Link>
                          {/* Row actions — archive always, delete only through
                              the RPC (refuses jobs with history). */}
                          {s.job_id ? (
                            <div className="flex items-center gap-1 flex-wrap">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setArchived(s.job_id!, !archived)}
                                className="text-xs font-medium text-gray-600 px-2 py-1 rounded hover:bg-gray-100 flex items-center gap-1 disabled:opacity-50"
                              >
                                {archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                                {archived ? "Un-archive" : "Archive"}
                              </button>
                              {confirmDeleteId === s.id ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => deleteJob(s.job_id!)}
                                    className="text-xs font-semibold text-white bg-red-600 px-2 py-1 rounded-lg hover:bg-red-700 flex items-center gap-1 disabled:opacity-50"
                                  >
                                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                    Confirm delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="text-xs font-medium text-gray-600 px-2 py-1 rounded hover:bg-gray-100"
                                  >
                                    Keep
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setConfirmDeleteId(s.id)}
                                  className="text-xs font-medium text-red-600 px-2 py-1 rounded hover:bg-red-50 flex items-center gap-1 disabled:opacity-50"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  Delete
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </main>

      {selected.size > 0 && (
        <div className="fixed bottom-16 lg:bottom-4 left-0 right-0 z-40 px-4">
          <button
            type="button"
            onClick={() => setShowBulkModal(true)}
            className="mx-auto max-w-md lg:max-w-xs w-full bg-gray-900 text-white py-3 rounded-lg font-semibold shadow-lg active:bg-gray-800 flex items-center justify-center gap-2"
          >
            <Layers className="w-4 h-4" />
            Bulk edit ({selected.size})
          </button>
        </div>
      )}

      {showBulkModal && (
        <BulkScheduleEditModal
          scheduleIds={[...selected]}
          onClose={() => setShowBulkModal(false)}
          onDone={() => {
            setShowBulkModal(false);
            setSelected(new Set());
            fetchData();
          }}
        />
      )}
    </div>
  );
}