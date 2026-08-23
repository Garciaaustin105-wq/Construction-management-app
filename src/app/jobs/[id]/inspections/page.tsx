"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ClipboardCheck, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";

// Inspection status -> badge tone. The legacy shared palette had no entry for
// required/passed/failed/na, so all four fell through to gray; they get real
// tones here.
const INSPECTION_STATUS_TONE: Record<string, BadgeTone> = {
  required: "warning",
  scheduled: "neutral",
  passed: "success",
  failed: "danger",
  na: "muted",
};
import { OFFICE_OR_PM } from "@/lib/roles";
import { projectTypeLabel, seedJobInspections } from "@/lib/inspectionTemplates";

type Job = {
  id: string;
  name: string;
  address: string | null;
  project_type: string | null;
  type: string;
};
type CostCode = { id: string; code: string; name: string };
type Inspection = {
  id: string;
  title: string;
  position: number;
  status: string;
  scheduled_date: string | null;
  inspector: string | null;
  notes: string | null;
  cost_code_id: string | null;
  created_at: string;
};

const SELECT = "id, title, position, status, scheduled_date, inspector, notes, cost_code_id, created_at";

function InspectionsForm({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState("");
  const [rows, setRows] = useState<Inspection[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [userId, setUserId] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { id } = await params;
      setJobId(id);
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      setUserId(user.id);
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      setCanEdit(OFFICE_OR_PM.has(profile?.role ?? "crew"));

      const [jobRes, rowsRes, ccRes] = await Promise.all([
        supabase.from("jobs").select("id, name, address, project_type, type").eq("id", id).single(),
        supabase.from("job_inspections").select(SELECT).eq("job_id", id).order("position", { ascending: true }),
        supabase.from("cost_codes").select("id, code, name").order("code"),
      ]);
      if (!jobRes.data) {
        toast.error("Job not found");
        router.push("/dashboard");
        return;
      }
      setJob(jobRes.data as unknown as Job);
      setRows((rowsRes.data ?? []) as unknown as Inspection[]);
      setCostCodes((ccRes.data ?? []) as unknown as CostCode[]);
      setLoading(false);
    })();
  }, [params, router, toast]);

  async function reload() {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data } = await supabase
      .from("job_inspections")
      .select(SELECT)
      .eq("job_id", jobId)
      .order("position", { ascending: true });
    setRows((data ?? []) as unknown as Inspection[]);
  }

  async function generate() {
    if (!job) return;
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const count = await seedJobInspections(supabase, jobId, job.project_type, userId);
    setBusy(false);
    if (count > 0) toast.success(`Generated ${count} inspections`);
    else toast.error("Could not generate checklist");
    await reload();
  }

  async function saveRow(row: Inspection) {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("job_inspections")
      .update({
        title: row.title,
        status: row.status,
        scheduled_date: row.scheduled_date || null,
        inspector: row.inspector || null,
        notes: row.notes || null,
        cost_code_id: row.cost_code_id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) toast.error("Failed to save inspection");
    else toast.success("Saved");
  }

  async function deleteRow(row: Inspection) {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase.from("job_inspections").delete().eq("id", row.id);
    if (error) {
      toast.error("Failed to delete inspection");
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    toast.success("Inspection deleted");
  }

  async function addCustom() {
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data, error } = await supabase
      .from("job_inspections")
      .insert({
        job_id: jobId,
        title: "New inspection",
        position: rows.length,
        status: "required",
        created_by: userId,
      })
      .select()
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error("Failed to add inspection");
      return;
    }
    setRows((prev) => [...prev, data as unknown as Inspection]);
    toast.success("Inspection added");
  }

  function patch(id: string, p: Partial<Inspection>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  if (!job) return null;

  // seedJobInspections defaults a null project_type to the residential
  // baseline, so the "Generate" button reflects what will actually be seeded.
  const genLabel = job.project_type === "commercial" ? "Commercial" : "Residential";

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(`/jobs/${jobId}`)}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">Back to job</span>
        </button>
        <div className="text-center">
          <h1 className="text-lg font-bold text-gray-900">Inspections</h1>
          <p className="text-xs text-gray-500 truncate max-w-[40vw]">
            {job.name} · {projectTypeLabel(job.project_type)}
          </p>
        </div>
        <a
          href={`/api/reports/job-inspections?job=${jobId}`}
          className="text-sm text-blue-600 px-2 py-1 flex items-center gap-1"
        >
          <ClipboardCheck className="w-4 h-4" />
          <span className="hidden sm:inline">Export</span>
        </a>
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-6 text-center space-y-3">
            <ClipboardCheck className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="text-sm font-medium text-gray-700">No inspection checklist yet</p>
            <p className="text-xs text-gray-500 max-w-xs mx-auto">
              Generate a {genLabel} checklist from the curated baseline, or add
 inspections manually.
            </p>
            {canEdit && (
              <button
                onClick={generate}
                disabled={busy}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Generate {genLabel} checklist
              </button>
            )}
          </div>
        ) : (
          <>
            {rows.map((row) => (
              <div key={row.id} className="bg-white rounded-lg shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={row.title}
                    disabled={!canEdit}
                    onChange={(e) => patch(row.id, { title: e.target.value })}
                    className="block flex-1 px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
                  />
                  <StatusBadge tone={INSPECTION_STATUS_TONE[row.status] ?? "neutral"}>{row.status.replace("_", " ")}</StatusBadge>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs font-medium text-gray-500">Status</span>
                    <select
                      value={row.status}
                      disabled={!canEdit}
                      onChange={(e) => {
                        patch(row.id, { status: e.target.value });
                        saveRow({ ...row, status: e.target.value });
                      }}
                      className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                    >
                      <option value="required">Required</option>
                      <option value="scheduled">Scheduled</option>
                      <option value="passed">Passed</option>
                      <option value="failed">Failed</option>
                      <option value="na">N/A</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-gray-500">Scheduled</span>
                    <input
                      type="date"
                      value={(row.scheduled_date ?? "").slice(0, 10)}
                      disabled={!canEdit}
                      onChange={(e) => patch(row.id, { scheduled_date: e.target.value || null })}
                      className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs font-medium text-gray-500">Inspector</span>
                    <input
                      type="text"
                      value={row.inspector ?? ""}
                      disabled={!canEdit}
                      onChange={(e) => patch(row.id, { inspector: e.target.value })}
                      className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-gray-500">Cost code</span>
                    <select
                      value={row.cost_code_id ?? ""}
                      disabled={!canEdit}
                      onChange={(e) => patch(row.id, { cost_code_id: e.target.value || null })}
                      className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                    >
                      <option value="">None</option>
                      {costCodes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} · {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs font-medium text-gray-500">Notes</span>
                  <textarea
                    value={row.notes ?? ""}
                    disabled={!canEdit}
                    rows={2}
                    onChange={(e) => patch(row.id, { notes: e.target.value })}
                    className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  />
                </label>

                {canEdit && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveRow(row)}
                      className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center gap-2"
                    >
                      <Save className="w-4 h-4" /> Save
                    </button>
                    <button
                      onClick={() => deleteRow(row)}
                      className="bg-white border border-red-300 text-red-600 px-3 py-2 rounded-lg font-semibold text-sm active:bg-red-50 flex items-center justify-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {canEdit && (
              <button
                onClick={addCustom}
                disabled={busy}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Add custom inspection
              </button>
            )}
          </>
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
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      }
    >
      <InspectionsForm params={params} />
    </Suspense>
  );
}