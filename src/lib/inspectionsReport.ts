import type { SupabaseClient } from "@supabase/supabase-js";

export type JobInspectionReportRow = {
  position: number;
  title: string;
  status: string;
  scheduled_date: string | null;
  inspector: string | null;
  cost_code: string | null;
  notes: string | null;
};

export async function fetchJobInspectionsReport(
  supabase: SupabaseClient,
  jobId: string
): Promise<JobInspectionReportRow[]> {
  const { data, error } = await supabase
    .from("job_inspections")
    .select(
      "id, position, title, status, scheduled_date, inspector, notes, cost_code_id, cost_code:cost_codes(code, name)"
    )
    .eq("job_id", jobId)
    .order("position", { ascending: true });

  if (error || !data) return [];

  return (data ?? []).map((r) => {
    const row = r as unknown as {
      position: number;
      title: string;
      status: string;
      scheduled_date: string | null;
      inspector: string | null;
      notes: string | null;
      cost_code_id: string | null;
      cost_code: { code: string; name: string } | null;
    };
    return {
      position: row.position,
      title: row.title,
      status: row.status,
      scheduled_date: row.scheduled_date,
      inspector: row.inspector ?? null,
      cost_code: row.cost_code ? `${row.cost_code.code} · ${row.cost_code.name}` : null,
      notes: row.notes ?? null,
    };
  });
}