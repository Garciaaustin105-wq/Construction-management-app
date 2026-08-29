"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { OFFICE_OR_PM } from "@/lib/roles";
import dynamic from "next/dynamic";
import { Plus, ArrowLeft, ListChecks, Loader2, Layers } from "lucide-react";

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

  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))
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
            <label className="flex items-center gap-2 text-xs font-medium text-gray-500 px-1">
              <input
                type="checkbox"
                checked={selected.size === rows.length}
                onChange={toggleAll}
              />
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </label>

            {/* Mobile: card list */}
            <div className="space-y-2 lg:hidden">
              {rows.map((s) => {
                const jobName = s.jobs?.name ?? "Untitled";
                const custName = s.jobs?.customers?.name ?? null;
                const crewIds: string[] = Array.isArray(s.jobs?.assigned_crew) ? s.jobs.assigned_crew : [];
                const crewNames = crewIds.map((id: string) => crewMap[id]).filter(Boolean).join(", ");
                return (
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
                          <p className="text-xs text-gray-500 truncate">{custName ? custName + " - " : ""}{s.service_type ?? "Service"}</p>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">Crew: {crewNames || "Unassigned"}</p>
                        </div>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                      </div>
                    </Link>
                  </div>
                );
              })}
            </div>

            {/* Desktop: real table */}
            <div className="hidden lg:block rounded-lg border border-gray-200 shadow-sm overflow-hidden bg-white">
              <div className="grid grid-cols-[28px_1fr_160px_1fr_110px] gap-3 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                <span />
                <span>Job / Customer</span>
                <span>Service</span>
                <span>Crew</span>
                <span>Status</span>
              </div>
              <div className="divide-y divide-gray-100">
                {rows.map((s) => {
                  const jobName = s.jobs?.name ?? "Untitled";
                  const custName = s.jobs?.customers?.name ?? null;
                  const crewIds: string[] = Array.isArray(s.jobs?.assigned_crew) ? s.jobs.assigned_crew : [];
                  const crewNames = crewIds.map((id: string) => crewMap[id]).filter(Boolean).join(", ");
                  return (
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
                        {s.service_type ?? "Service"}
                      </Link>
                      <Link href={`/lawn/schedules/${s.id}`} className="text-sm text-gray-500 truncate">
                        {crewNames || "Unassigned"}
                      </Link>
                      <Link href={`/lawn/schedules/${s.id}`}>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                      </Link>
                    </div>
                  );
                })}
              </div>
            </div>
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