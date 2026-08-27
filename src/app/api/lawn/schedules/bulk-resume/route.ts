import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import { generateDueDates } from "@/lib/lawnRecurrence";

// POST /api/lawn/schedules/bulk-resume — reopen a customer's seasonal pause.
// Reverses bulk-pause: flips the customer's INACTIVE recurring schedules back
// to active, resumes this customer's paused visits with due_date >= resume_from
// back to pending (audit §5.1: they used to be left as-is and stayed on the
// calendar forever as un-actionable clutter), and regenerates any still-missing
// pending visits from `resume_from` through min(end_date, today+90d). Beats
// Jobber's spring reopen where owners "manually close/reopen hundreds of jobs
// each spring" — one tap regenerates the whole account.
//
// Body: { customer_id, resume_from } (ISO YYYY-MM-DD).
//
// Paused visits with due_date < resume_from (the off-season already passed)
// are LEFT paused — that is the historical record of skipped winter service.
// Only visits from resume_from forward reopen, matching "resume from <date>"
// semantics. Resumed rows occupy their (recurring_schedule_id, due_date) slot,
// so the generateDueDates insert below 23505-collides with them (expected,
// ignored) and no duplicates are created.
//
// Gate: OFFICE_OR_PM. RLS session client scopes to the caller's org.
export const dynamic = "force-dynamic";

const HORIZON_DAYS = 90;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type JobRow = { id: string };
type Sched = {
  id: string;
  job_id: string;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = me.role;
  if (!OFFICE_OR_PM.has(role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { customer_id?: string; resume_from?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { customer_id, resume_from } = body;
  if (!customer_id || !resume_from)
    return NextResponse.json(
      { error: "customer_id and resume_from are required" },
      { status: 400 }
    );

  const { data: jobRowsData } = await supabase
    .from("jobs")
    .select("id")
    .eq("customer_id", customer_id);
  const jobIds = ((jobRowsData as unknown as JobRow[] | null) ?? []).map(
    (j) => j.id
  );
  if (jobIds.length === 0)
    return NextResponse.json(
      { error: "No jobs found for that customer (in your org)" },
      { status: 404 }
    );

  // Only INACTIVE schedules reopen — an active one is already running.
  const { data: schedRows } = await supabase
    .from("recurring_schedules")
    .select(
      "id, job_id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date"
    )
    .in("job_id", jobIds)
    .eq("active", false);
  const schedules = (schedRows as unknown as Sched[] | null) ?? [];
  if (schedules.length === 0)
    return NextResponse.json({
      reopened_schedules: 0,
      generated_visits: 0,
      note: "No paused schedules to reopen for this customer",
    });

  // Reactivate + clear the off-season window (manual resume overrides any
  // pending auto-resume). The nightly cron (active=true filter) will extend
  // from here going forward too.
  const { error: schedErr } = await supabase
    .from("recurring_schedules")
    .update({ active: true, paused_from: null, paused_until: null })
    .in(
      "id",
      schedules.map((s) => s.id)
    );
  if (schedErr)
    return NextResponse.json(
      { error: `Failed to reopen schedules: ${schedErr.message}` },
      { status: 500 }
    );

  // Resume this customer's paused visits from resume_from forward (audit §5.1).
  // Past paused visits (due_date < resume_from) stay paused as the historical
  // record of skipped winter service. Resumed rows reclaim their (schedule,
  // due_date) slot so the regenerate step below 23505-collides with them instead
  // of duplicating. route_order is left null (bulk-pause already nulled it) so
  // the dispatcher re-plans them alongside any freshly generated visits.
  const { data: resumedRows, error: resumeErr } = await supabase
    .from("lawn_visits")
    .update({ status: "pending" })
    .in("job_id", jobIds)
    .eq("status", "paused")
    .gte("due_date", resume_from)
    .select("id");
  if (resumeErr)
    return NextResponse.json(
      { error: `Failed to resume paused visits: ${resumeErr.message}` },
      { status: 500 }
    );
  const resumedVisits =
    ((resumedRows as unknown as { id: string }[] | null) ?? []).length;

  const horizon = addDaysISO(todayISO(), HORIZON_DAYS);
  let generated = 0;

  for (const s of schedules) {
    let to = horizon;
    if (s.end_date && s.end_date < to) to = s.end_date;
    if (resume_from > to) continue; // season already ended

    const dates = generateDueDates(
      {
        frequency: s.frequency,
        interval_weeks: s.interval_weeks,
        days_of_week: s.days_of_week,
        day_of_month: s.day_of_month,
        start_date: s.start_date,
        end_date: s.end_date,
      },
      resume_from,
      to
    );
    if (dates.length === 0) continue;

    const inserts = dates.map((due_date) => ({
      recurring_schedule_id: s.id,
      job_id: s.job_id,
      due_date,
      status: "pending" as const,
    }));
    const { error } = await supabase.from("lawn_visits").insert(inserts);
    if (error && error.code !== "23505") {
      // 23505 = a date already exists (race / manual add / pre-generated) —
      // expected and ignored. Anything else: log and continue; don't crash
      // the batch (other schedules still need reopening).
      console.error(
        "bulk-resume insert failed",
        s.id,
        error.code,
        error.message
      );
    } else {
      generated += dates.length;
    }
  }

  return NextResponse.json({
    reopened_schedules: schedules.length,
    resumed_visits: resumedVisits,
    generated_visits: generated,
  });
}