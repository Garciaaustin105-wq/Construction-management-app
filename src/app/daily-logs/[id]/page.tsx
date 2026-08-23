"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import HighlightsHeader from "@/components/ui/HighlightsHeader";
import Button from "@/components/ui/Button";
// Labels, tones and the valid-transition table all come from the lifecycle
// module — the single source shared with the list page.
import {
  DAILY_LOG_STATUS_LABEL,
  DAILY_LOG_STATUS_TONE,
  validTransitions,
  type DailyLogStatus,
} from "@/lib/lifecycles/daily-log";
import { FIELD_MGMT } from "@/lib/roles";

type Log = {
  id: string;
  job_id: string;
  log_date: string;
  weather: string | null;
  work_performed: string | null;
  equipment: string | null;
  materials: string | null;
  delays: string | null;
  safety_notes: string | null;
  crew_count: number | null;
  status: string;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
};

function DailyLogForm({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedJob = searchParams.get("job") ?? "";
  const toast = useToast();
  const [id, setId] = useState("");
  const [log, setLog] = useState<Log | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    (async () => {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/login"); return; }
      const { data: profile } = await supabase.from("profiles").select("role, organization_id").eq("id", user.id).single();
      if (!profile) { router.push("/dashboard"); return; }
      if (profile.role === "customer") { router.push("/dashboard"); return; }
      setAuthorized(true);
      setCanEdit(FIELD_MGMT.has(profile.role));
      const { id: paramId } = await params; setId(paramId);
      const { data: logRow } = await supabase.from("daily_logs").select("id, job_id, log_date, weather, work_performed, equipment, materials, delays, safety_notes, crew_count, status, reviewed_at, created_by, created_at").eq("id", paramId).single();
      if (!logRow) { toast.error("Log not found"); router.push("/daily-logs"); return; }
      setLog(logRow);
    })();
  }, [router, searchParams, params, toast]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!log) return;
    setLoading(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Not signed in"); setLoading(false); return; }
    const { data, error } = await supabase.from("daily_logs").update({
      weather: log.weather,
      work_performed: log.work_performed,
      equipment: log.equipment,
      materials: log.materials,
      delays: log.delays,
      safety_notes: log.safety_notes,
      crew_count: log.crew_count,
      updated_at: new Date().toISOString(),
    }).eq("id", id).select().single();
    if (error || !data) { toast.error(`Failed: ${error?.message ?? "error"}`); setLoading(false); return; }
    toast.success("Updated");
    router.refresh();
  }

  async function handleMarkReviewed() {
    if (!log || log.status !== "submitted") return;
    setLoading(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Not signed in"); setLoading(false); return; }
    const { data, error } = await supabase.from("daily_logs").update({
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
    }).eq("id", id).select().single();
    if (error || !data) { toast.error(`Failed: ${error?.message ?? "error"}`); setLoading(false); return; }
    toast.success("Marked reviewed");
    router.refresh();
  }

  if (!authorized) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>;
  // The DB column is `text`; the lifecycle module owns the domain.
  const status = (log?.status ?? "submitted") as DailyLogStatus;
  // Which action renders = status-valid x role-allowed. canEdit is untouched.
  const canReview = canEdit && validTransitions(status).includes("reviewed");
  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button onClick={() => router.push(preselectedJob ? `/jobs/${preselectedJob}` : "/daily-logs")} className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]">
          <ArrowLeft className="w-4 h-4 flex-shrink-0" /><span className="truncate">{preselectedJob ? "Back to job" : "Daily Logs"}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">Daily Log</h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        {log && (
          <div className="space-y-4">
            <HighlightsHeader
              title="Daily Log"
              subtitle={log.log_date}
              status={{
                label: DAILY_LOG_STATUS_LABEL[status] ?? log.status,
                tone: DAILY_LOG_STATUS_TONE[status] ?? "neutral",
              }}
              accent={DAILY_LOG_STATUS_TONE[status] ?? "brand"}
              fields={[
                { label: "Log date", value: log.log_date },
                { label: "Crew", value: log.crew_count ?? "—" },
                {
                  label: "Reviewed",
                  value: log.reviewed_at
                    ? new Date(log.reviewed_at).toLocaleDateString()
                    : "—",
                },
              ]}
              actions={
                // Status-valid (lifecycle) x role-allowed (canEdit = FIELD_MGMT,
                // unchanged). Previously the Mark-reviewed button was hand-gated
                // on `log.status === "submitted"` and lived INSIDE the edit form,
                // where its missing type="button" made it submit the form too.
                canReview ? (
                  <Button type="button" onClick={handleMarkReviewed} disabled={loading} size="sm">
                    {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loading ? "Marking reviewed..." : "Mark reviewed"}
                  </Button>
                ) : undefined
              }
            />
            {canEdit && (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="weather" className="block text-sm font-medium text-gray-700">Weather</label>
                  <input type="text" id="weather" value={log.weather ?? ""} onChange={e => setLog({ ...log, weather: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                </div>
                <div>
                  <label htmlFor="work_performed" className="block text-sm font-medium text-gray-700">Work Performed</label>
                  <textarea id="work_performed" value={log.work_performed ?? ""} onChange={e => setLog({ ...log, work_performed: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" rows={3} />
                </div>
                <div>
                  <label htmlFor="equipment" className="block text-sm font-medium text-gray-700">Equipment</label>
                  <input type="text" id="equipment" value={log.equipment ?? ""} onChange={e => setLog({ ...log, equipment: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                </div>
                <div>
                  <label htmlFor="materials" className="block text-sm font-medium text-gray-700">Materials</label>
                  <input type="text" id="materials" value={log.materials ?? ""} onChange={e => setLog({ ...log, materials: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                </div>
                <div>
                  <label htmlFor="delays" className="block text-sm font-medium text-gray-700">Delays</label>
                  <input type="text" id="delays" value={log.delays ?? ""} onChange={e => setLog({ ...log, delays: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                </div>
                <div>
                  <label htmlFor="safety_notes" className="block text-sm font-medium text-gray-700">Safety Notes</label>
                  <textarea id="safety_notes" value={log.safety_notes ?? ""} onChange={e => setLog({ ...log, safety_notes: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" rows={3} />
                </div>
                <div>
                  <label htmlFor="crew_count" className="block text-sm font-medium text-gray-700">Crew Count</label>
                  <input type="number" id="crew_count" value={log.crew_count ?? ""} onChange={e => setLog({ ...log, crew_count: parseInt(e.target.value) || 0 })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                </div>
                <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
                  {loading && <Loader2 className="w-5 h-5 animate-spin" />}{loading ? "Saving..." : "Save"}
                </button>
              </form>
            )}
            {!canEdit && (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold text-gray-500">Weather</p>
                  <p className="text-base text-gray-900">{log.weather}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">Work Performed</p>
                  <p className="text-base text-gray-900">{log.work_performed}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">Equipment</p>
                  <p className="text-base text-gray-900">{log.equipment}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">Materials</p>
                  <p className="text-base text-gray-900">{log.materials}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">Delays</p>
                  <p className="text-base text-gray-900">{log.delays}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">Safety Notes</p>
                  <p className="text-base text-gray-900">{log.safety_notes}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">Crew Count</p>
                  <p className="text-base text-gray-900">{log.crew_count}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-gray-500">Loading...</p>
        </div>
      }
    >
      <DailyLogForm params={params} />
    </Suspense>
  );
}