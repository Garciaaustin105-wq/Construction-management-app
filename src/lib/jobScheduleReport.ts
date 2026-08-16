import type { SupabaseClient } from "@supabase/supabase-js";
import { computeCriticalPath, dayIndex } from "@/lib/criticalPath";

export type JobScheduleReportRow = {
  position: number;
  title: string;
  kind: string;
  cost_code: string | null;
  start_date: string;
  end_date: string | null;
  days: number;
  percent_complete: number;
  predecessors: string;
  assignee_name: string | null;
  critical: "Y" | "N";
};

export async function fetchJobScheduleReport(
  supabase: SupabaseClient,
  jobId: string
): Promise<JobScheduleReportRow[]> {
  const { data, error } = await supabase
    .from("job_tasks")
    .select(
      "id, position, title, kind, start_date, end_date, percent_complete, predecessor_ids, assigned_to, cost_code:cost_codes(code, name), assignee:profiles!assigned_to(full_name)"
    )
    .eq("job_id", jobId)
    .order("position", { ascending: true });

  if (error || !data) return [];

  const rows = (data ?? []) as unknown as {
    id: string;
    position: number;
    title: string;
    kind: string;
    start_date: string;
    end_date: string | null;
    percent_complete: number;
    predecessor_ids: string[] | null;
    cost_code: { code: string; name: string } | null;
    assignee: { full_name: string | null } | null;
  }[];

  const titleMap = new Map(rows.map((r) => [r.id, r.title]));
  const cpm = computeCriticalPath(
    rows.map((r) => ({
      id: r.id,
      start_date: r.start_date,
      end_date: r.end_date,
      predecessor_ids: r.predecessor_ids,
    }))
  );

  return rows.map((r) => ({
    position: r.position,
    title: r.title,
    kind: r.kind,
    cost_code: r.cost_code ? `${r.cost_code.code} · ${r.cost_code.name}` : null,
    start_date: r.start_date,
    end_date: r.end_date,
    days: r.end_date ? dayIndex(r.end_date) - dayIndex(r.start_date) + 1 : 0,
    percent_complete: r.percent_complete,
    predecessors: (r.predecessor_ids ?? [])
      .map((id) => titleMap.get(id))
      .filter(Boolean)
      .join(", "),
    assignee_name: r.assignee?.full_name ?? null,
    critical: cpm.entries.get(r.id)?.isCritical ? "Y" : "N",
  }));
}