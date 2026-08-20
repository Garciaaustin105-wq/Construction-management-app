"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { OFFICE_OR_PM } from "@/lib/roles";
import { Plus, ArrowLeft, ListChecks, Loader2 } from "lucide-react";

export default function LawnJobsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<any[]>([]);
  const [crewMap, setCrewMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
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

      let list = (schedRes.data ?? []) as any[];
      list = [...list].sort((x, y) => {
        if ((x.active ? 1 : 0) !== (y.active ? 1 : 0)) return (x.active ? 1 : 0) ? -1 : 1;
        const an = x.jobs?.name ?? "";
        const bn = y.jobs?.name ?? "";
        return an.localeCompare(bn);
      });

      setRows(list);
      setLoading(false);
    };

    fetchData();
  }, []); // eslint-disable-next-line react-hooks/exhaustive-deps

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
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5">
          <ListChecks className="w-5 h-5 text-green-600" /> Lawn Jobs
        </h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-3">
        <Link href="/lawn/new" className="block bg-green-600 text-white text-center py-3 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2">
          <Plus className="w-5 h-5" /> New lawn job
        </Link>
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 shadow-sm text-center text-sm text-gray-500">
            No lawn jobs yet. Tap New lawn job to add one.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((s) => {
              const jobName = s.jobs?.name ?? "Untitled";
              const custName = s.jobs?.customers?.name ?? null;
              const crewIds: string[] = Array.isArray(s.jobs?.assigned_crew) ? s.jobs.assigned_crew : [];
              const crewNames = crewIds.map((id: string) => crewMap[id]).filter(Boolean).join(", ");
              return (
                <Link key={s.id} href={`/lawn/schedules/${s.id}`} className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50">
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">{jobName}</p>
                      <p className="text-xs text-gray-500 truncate">{custName ? custName + " - " : ""}{s.service_type ?? "Service"}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate">Crew: {crewNames || "Unassigned"}</p>
                    </div>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}