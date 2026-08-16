import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { GanttChartSquare, ClipboardCheck } from "lucide-react";

export default async function JobGanttInspectionsSummary({ jobId }: { jobId: string }) {
  const supabase = await createClient();

  const [taskRes, inspRes] = await Promise.all([
    supabase.from("job_tasks").select("id, percent_complete").eq("job_id", jobId),
    supabase.from("job_inspections").select("status").eq("job_id", jobId),
  ]);

  const tasks = (taskRes.data ?? []) as unknown as { percent_complete: number }[];
  const insp = (inspRes.data ?? []) as unknown as { status: string }[];

  const tasksCount = tasks.length;
  const avgPct = tasksCount ? Math.round(tasks.reduce((s, t) => s + (t.percent_complete || 0), 0) / tasksCount) : 0;

  const total = insp.length;
  const passed = insp.filter(i => i.status === "passed").length;
  const failed = insp.filter(i => i.status === "failed").length;
  const scheduled = insp.filter(i => i.status === "scheduled").length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Link href={`/jobs/${jobId}/gantt`} className="bg-white rounded-lg p-4 shadow-sm active:bg-gray-50 block">
        <div className="flex items-center gap-3">
          <GanttChartSquare className="w-5 h-5 text-blue-600 flex-shrink-0" />
          <div>
            <div className="text-sm font-semibold text-gray-900">Schedule (Gantt)</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {tasksCount > 0 ? `${tasksCount} tasks · ${avgPct}% complete` : "No tasks yet"}
            </div>
          </div>
        </div>
      </Link>
      <Link href={`/jobs/${jobId}/inspections`} className="bg-white rounded-lg p-4 shadow-sm active:bg-gray-50 block">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="w-5 h-5 text-blue-600 flex-shrink-0" />
          <div>
            <div className="text-sm font-semibold text-gray-900">Inspections</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {total > 0 ? `${passed}/${total} passed · ${failed} failed · ${scheduled} scheduled` : "No inspections yet"}
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
}