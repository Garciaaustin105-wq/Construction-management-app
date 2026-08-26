import type { SupabaseClient } from "@supabase/supabase-js";

// Helper function to get the end of the day in ISO format
function endOfDayISO(to: string): string {
  const d = new Date(`${to}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// 1) Daily Log Report
export type DailyLogReportFilters = {
  jobId?: string | null;
  from?: string | null;
  to?: string | null;
};

export type DailyLogReportRow = {
  id: string;
  log_date: string;
  weather: string | null;
  work_performed: string | null;
  equipment: string | null;
  materials: string | null;
  delays: string | null;
  safety_notes: string | null;
  crew_count: number | null;
  status: string;
  created_at: string;
  created_by: string | null;
  author_name: string | null;
  job_name: string | null;
};

export async function fetchDailyLogsReport(
  supabase: SupabaseClient,
  filters: DailyLogReportFilters
): Promise<DailyLogReportRow[]> {
  let q = supabase
    .from("daily_logs")
    .select(
      "id, log_date, weather, work_performed, equipment, materials, delays, safety_notes, crew_count, status, created_at, created_by, job:jobs(name), creator:profiles!created_by(full_name)"
    );

  if (filters.jobId) q = q.eq("job_id", filters.jobId);
  if (filters.from) q = q.gte("log_date", filters.from);
  if (filters.to) q = q.lt("log_date", endOfDayISO(filters.to));

  q = q.order("log_date", { ascending: true });

  const { data, error } = await q;
  if (error) return [];

  return (data ?? []).map((r) => {
    const row = r as unknown as {
      id: string; log_date: string; weather: string | null; work_performed: string | null;
      equipment: string | null; materials: string | null; delays: string | null; safety_notes: string | null;
      crew_count: number | null; status: string; created_at: string; created_by: string | null;
      creator: { full_name: string | null } | null; job: { name: string | null } | null;
    };
    return {
      id: row.id,
      log_date: row.log_date,
      weather: row.weather ?? null,
      work_performed: row.work_performed ?? null,
      equipment: row.equipment ?? null,
      materials: row.materials ?? null,
      delays: row.delays ?? null,
      safety_notes: row.safety_notes ?? null,
      crew_count: row.crew_count ?? null,
      status: row.status,
      created_at: row.created_at,
      created_by: row.created_by ?? null,
      author_name: row.creator?.full_name ?? null,
      job_name: row.job?.name ?? null,
    };
  });
}

// 2) Punch Report
export type PunchReportFilters = {
  jobId?: string | null;
  status?: string | null;
  priority?: string | null;
};

export type PunchReportRow = {
  id: string;
  title: string;
  location: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  created_at: string;
  assignee_name: string | null;
  job_name: string | null;
};

export async function fetchPunchReport(
  supabase: SupabaseClient,
  filters: PunchReportFilters
): Promise<PunchReportRow[]> {
  let q = supabase
    .from("punch_items")
    .select(
      "id, title, location, status, priority, due_date, created_at, assigned_to, job:jobs(name), assignee:profiles!assigned_to(full_name)"
    );

  if (filters.jobId) q = q.eq("job_id", filters.jobId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.priority) q = q.eq("priority", filters.priority);

  q = q.order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) return [];

  return (data ?? []).map((r) => {
    const row = r as unknown as {
      id: string; title: string; location: string | null; status: string; priority: string;
      due_date: string | null; created_at: string;
      assignee: { full_name: string | null } | null; job: { name: string | null } | null;
    };
    return {
      id: row.id,
      title: row.title,
      location: row.location ?? null,
      status: row.status,
      priority: row.priority,
      due_date: row.due_date ?? null,
      created_at: row.created_at,
      assignee_name: row.assignee?.full_name ?? null,
      job_name: row.job?.name ?? null,
    };
  });
}

// 3) Change Order Report
export type ChangeOrderReportFilters = {
  jobId?: string | null;
  status?: string | null;
};

export type ChangeOrderReportRow = {
  id: string;
  co_number: string | null;
  title: string;
  amount: number;
  is_credit: boolean;
  status: string;
  created_at: string;
  job_name: string | null;
  // Issue 5 attribution. approver_name is resolved from approved_by via a
  // separate batched profiles read (not an embed — change_orders has two FKs
  // to profiles: created_by and approved_by, so the embed is ambiguous).
  approved_by: string | null;
  approved_at: string | null;
  approval_method: string | null;
  approver_name: string | null;
};

export async function fetchChangeOrdersReport(
  supabase: SupabaseClient,
  filters: ChangeOrderReportFilters
): Promise<ChangeOrderReportRow[]> {
  let q = supabase
    .from("change_orders")
    .select(
      "id, co_number, title, amount, is_credit, status, created_at, approved_by, approved_at, approval_method, job:jobs(name)"
    );

  if (filters.jobId) q = q.eq("job_id", filters.jobId);
  if (filters.status) q = q.eq("status", filters.status);

  q = q.order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) return [];

  const rows = (data ?? []).map((r) => {
    const row = r as unknown as {
      id: string; co_number: string | null; title: string; amount: number | string;
      is_credit: boolean; status: string; created_at: string;
      approved_by: string | null; approved_at: string | null; approval_method: string | null;
      job: { name: string | null } | null;
    };
    return {
      id: row.id,
      co_number: row.co_number ?? null,
      title: row.title,
      amount: Number(row.amount) || 0,
      is_credit: row.is_credit,
      status: row.status,
      created_at: row.created_at,
      job_name: row.job?.name ?? null,
      approved_by: row.approved_by ?? null,
      approved_at: row.approved_at ?? null,
      approval_method: row.approval_method ?? null,
      approver_name: null as string | null,
    };
  });

  // Batch-resolve approver display names: one profiles read for every distinct
  // approved_by in the page (no N+1, no ambiguous embed).
  const approverIds = Array.from(
    new Set(rows.map((r) => r.approved_by).filter((v): v is string => !!v))
  );
  const nameById = new Map<string, string>();
  if (approverIds.length > 0) {
    const { data: approvers } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", approverIds);
    for (const a of (approvers ?? []) as { id: string; full_name: string | null }[]) {
      if (a.full_name) nameById.set(a.id, a.full_name);
    }
  }
  for (const r of rows) {
    if (r.approved_by) r.approver_name = nameById.get(r.approved_by) ?? null;
  }

  return rows;
}

// 4) Submittal Report
export type SubmittalReportFilters = {
  jobId?: string | null;
  status?: string | null;
};

export type SubmittalReportRow = {
  id: string;
  submittal_number: string | null;
  title: string;
  csi_section: string | null;
  status: string;
  disposition: string | null;
  ball_in_court: string;
  created_at: string;
  job_name: string | null;
};

export async function fetchSubmittalsReport(
  supabase: SupabaseClient,
  filters: SubmittalReportFilters
): Promise<SubmittalReportRow[]> {
  let q = supabase
    .from("submittals")
    .select("id, submittal_number, title, csi_section, status, disposition, ball_in_court, created_at, job:jobs(name)");

  if (filters.jobId) q = q.eq("job_id", filters.jobId);
  if (filters.status) q = q.eq("status", filters.status);

  q = q.order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) return [];

  return (data ?? []).map((r) => {
    const row = r as unknown as {
      id: string; submittal_number: string | null; title: string; csi_section: string | null;
      status: string; disposition: string | null; ball_in_court: string; created_at: string;
      job: { name: string | null } | null;
    };
    return {
      id: row.id,
      submittal_number: row.submittal_number ?? null,
      title: row.title,
      csi_section: row.csi_section ?? null,
      status: row.status,
      disposition: row.disposition ?? null,
      ball_in_court: row.ball_in_court,
      created_at: row.created_at,
      job_name: row.job?.name ?? null,
    };
  });
}