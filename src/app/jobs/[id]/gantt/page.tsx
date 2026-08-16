"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import GanttChart, { type GanttTask } from "@/components/GanttChart";
import { OFFICE_OR_PM } from "@/lib/roles";
import { computeCriticalPath } from "@/lib/criticalPath";

type CostCode = { id: string; code: string; name: string };
type Assignee = { id: string; full_name: string | null; email: string };
type Job = { id: string; name: string; scheduled_start: string | null; scheduled_end: string | null };

const SELECT =
  "id, title, kind, cost_code_id, start_date, end_date, position, percent_complete, predecessor_ids, dependency_type, assigned_to";

function GanttPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState("");
  const [tasks, setTasks] = useState<GanttTask[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);

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
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      setCanEdit(OFFICE_OR_PM.has(profile?.role ?? "crew"));

      const [jobRes, taskRes, ccRes, memRes] = await Promise.all([
        supabase.from("jobs").select("id, name, scheduled_start, scheduled_end").eq("id", id).single(),
        supabase.from("job_tasks").select(SELECT).eq("job_id", id).order("position", { ascending: true }),
        supabase.from("cost_codes").select("id, code, name").order("code"),
        supabase.from("profiles").select("id, full_name, email").neq("role", "customer").order("full_name"),
      ]);
      if (!jobRes.data) {
        toast.error("Job not found");
        router.push("/dashboard");
        return;
      }
      setJob(jobRes.data as unknown as Job);
      setTasks((taskRes.data ?? []) as unknown as GanttTask[]);
      setCostCodes((ccRes.data ?? []) as unknown as CostCode[]);
      setAssignees((memRes.data ?? []) as unknown as Assignee[]);
      setLoading(false);
    })();
  }, [params, router, toast]);

  async function updateTask(id: string, patch: Partial<GanttTask>) {
    // Keep milestones date-consistent (milestone = point, end_date null).
    const current = tasks.find((t) => t.id === id);
    if (!current) return;
    const merged = { ...current, ...patch };
    if (merged.kind === "milestone") merged.end_date = null;
    else if (merged.end_date == null) merged.end_date = merged.start_date;

    setTasks((prev) => prev.map((t) => (t.id === id ? merged : t)));
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("job_tasks")
      .update({
        title: merged.title,
        kind: merged.kind,
        cost_code_id: merged.cost_code_id || null,
        start_date: merged.start_date,
        end_date: merged.end_date,
        percent_complete: merged.percent_complete,
        assigned_to: merged.assigned_to || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) toast.error(`Save failed: ${error.message}`);
  }

  async function addTask() {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const today = new Date().toISOString().slice(0, 10);
    const pos = tasks.length;
    const { data, error } = await supabase
      .from("job_tasks")
      .insert({
        job_id: jobId,
        title: "New task",
        kind: "task",
        start_date: today,
        end_date: today,
        position: pos,
        percent_complete: 0,
        predecessor_ids: [],
        dependency_type: "FS",
        created_by: user?.id ?? null,
      })
      .select(SELECT)
      .single();
    if (error || !data) {
      toast.error(`Add failed: ${error?.message ?? "error"}`);
      return;
    }
    setTasks((prev) => [...prev, data as unknown as GanttTask]);
    toast.success("Task added");
  }

  async function deleteTask(id: string) {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase.from("job_tasks").delete().eq("id", id);
    if (error) {
      toast.error(`Delete failed: ${error.message}`);
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== id));
    toast.success("Task deleted");
  }

  // predecessorId is the new predecessor of successorId (FS). Validate acyclic.
  async function link(predecessorId: string, successorId: string) {
    const succ = tasks.find((t) => t.id === successorId);
    if (!succ || predecessorId === successorId) return;
    if ((succ.predecessor_ids ?? []).includes(predecessorId)) return; // already linked

    const trial = tasks.map((t) =>
      t.id === successorId
        ? { ...t, predecessor_ids: [...(t.predecessor_ids ?? []), predecessorId] }
        : t
    );
    const cpm = computeCriticalPath(
      trial.map((t) => ({
        id: t.id,
        start_date: t.start_date,
        end_date: t.end_date,
        predecessor_ids: t.predecessor_ids,
      }))
    );
    if (!cpm.ok) {
      toast.error("That link would create a cycle — not added.");
      return;
    }
    setTasks(trial);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("job_tasks")
      .update({ predecessor_ids: trial.find((t) => t.id === successorId)!.predecessor_ids })
      .eq("id", successorId);
    if (error) toast.error(`Link failed: ${error.message}`);
  }

  async function unlink(successorId: string, predecessorId: string) {
    const trial = tasks.map((t) =>
      t.id === successorId
        ? { ...t, predecessor_ids: (t.predecessor_ids ?? []).filter((p) => p !== predecessorId) }
        : t
    );
    setTasks(trial);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("job_tasks")
      .update({ predecessor_ids: trial.find((t) => t.id === successorId)!.predecessor_ids })
      .eq("id", successorId);
    if (error) toast.error(`Unlink failed: ${error.message}`);
  }

  const cycleWarning = useMemo(() => {
    const cpm = computeCriticalPath(
      tasks.map((t) => ({
        id: t.id,
        start_date: t.start_date,
        end_date: t.end_date,
        predecessor_ids: t.predecessor_ids,
      }))
    );
    return !cpm.ok;
  }, [tasks]);

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  if (!job) return null;

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
          <h1 className="text-lg font-bold text-gray-900">Schedule</h1>
          <p className="text-xs text-gray-500 truncate max-w-[40vw]">{job.name}</p>
        </div>
        <a
          href={`/api/reports/job-schedule?job=${jobId}`}
          className="text-sm text-blue-600 px-2 py-1 flex items-center gap-1"
        >
          <span className="hidden sm:inline">Export</span>
        </a>
      </header>

      <main className="max-w-md lg:max-w-7xl mx-auto p-2 lg:p-4">
        {cycleWarning && (
          <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            A dependency cycle exists — some links were not drawn. Remove a link to fix it.
          </div>
        )}
        {tasks.length === 0 && !canEdit && (
          <p className="text-sm text-gray-500 p-4">No schedule tasks yet.</p>
        )}
        <GanttChart
          tasks={tasks}
          canEdit={canEdit}
          costCodes={costCodes}
          assignees={assignees}
          jobScheduledStart={job.scheduled_start}
          jobScheduledEnd={job.scheduled_end}
          onUpdate={updateTask}
          onLink={link}
          onUnlink={unlink}
          onDelete={deleteTask}
          onCreate={addTask}
        />
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
      <GanttPage params={params} />
    </Suspense>
  );
}