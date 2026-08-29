"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { OFFICE_OR_PM } from "@/lib/roles";
import dynamic from "next/dynamic";
import { Plus, ArrowLeft, ListChecks, Loader2, Layers, Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

// Interaction-only modal — only mounts once "Bulk edit" is pressed, so its form
// state + markup stay out of the page's first-load bundle.
const BulkScheduleEditModal = dynamic(
  () => import("@/components/BulkScheduleEditModal"),
  { ssr: false }
);

// Shape of the recurring_schedules select below (with the nested jobs/customers
// join). Replaces `any[]`, which lost all type safety on the sort + render.
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
    customers: { name: string | null } | null;
  } | null;
};

export default function LawnJobsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [crewMap, setCrewMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");
  const [sortKey, setSortKey] = useState<"name" | "service" | "crew" | "status">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

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
      supabase.from("recurring_schedules").select("id, job_id, active, service_type, price_per_visit, frequency, interval_weeks, days_of_week, day_of_month, paused_from, paused_until, created_at, jobs(name, address, customer_id, assigned_crew, customers(name))").order("active", { ascending: false }).order("created_at", { ascending: false }),
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

  function toggleSort(key: typeof sortKey) {
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
  const displayRows = useMemo(() => {
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
  }, [rows, crewMap, query, statusFilter, sortKey, sortDir]);

  function SortIcon({ col }: { col: typeof sortKey }) {
    if (col !== sortKey) return <ArrowUpDown className="w-3 h-3 text-gray-300" />;
    return sortDir === "asc" ? (
      <ArrowUp className="w-3 h-3 text-gray-700" />
    ) : (
      <ArrowDown className="w-3 h-3 text-gray-700" />
    );
  }

  function Th({ col, label }: { col: typeof sortKey; label: string }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(col)}
        className="flex items-center gap-1 hover:text-gray-900 transition-colors"
      >
        {label}
        <SortIcon col={col} />
      </button>
    );
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
                {(["all", "active", "paused"] as const).map((f) => (
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
              <p className="text-sm text-gray-500 text-center py-6">No jobs match your filters.</p>
            ) : (
              <>
                {/* Mobile: card list */}
                <div className="space-y-2 lg:hidden">
                  {displayRows.map(({ row: s, jobName, custName, service, crewNames }) => (
                    <div key={s.id} className="flex items-center gap-2 bg-white rounded-lg shadow-sm">
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
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                        </div>
                      </Link>
                    </div>
                  ))}
                </div>

                {/* Desktop: real table */}
                <div className="hidden lg:block rounded-lg border border-gray-200 shadow-sm overflow-hidden bg-white">
                  <div className="grid grid-cols-[28px_1fr_160px_1fr_110px] gap-3 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                    <span />
                    <Th col="name" label="Job / Customer" />
                    <Th col="service" label="Service" />
                    <Th col="crew" label="Crew" />
                    <Th col="status" label="Status" />
                  </div>
                  <div className="divide-y divide-gray-100">
                    {displayRows.map(({ row: s, jobName, custName, service, crewNames }) => (
                      <div key={s.id} className="grid grid-cols-[28px_1fr_160px_1fr_110px] gap-3 px-4 py-2.5 items-center hover:bg-gray-50 transition-colors">
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
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                        </Link>
                      </div>
                    ))}
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