import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";

// POST /api/lawn/schedules/bulk-pause — pause ALL of one customer's recurring
// schedules for an off-season window. Beats Jobber's clunky per-job "hold":
// one tap pauses the whole account, and the winter visits flip to `paused`
// (not deleted) so the record of skipped service is preserved.
//
// Body: { customer_id, pause_from, pause_to } (ISO YYYY-MM-DD).
//   - Sets that customer's recurring_schedules active=false (the nightly
//     generate cron filters active=true, so no new visits materialize while
//     paused).
//   - Flips lawn_visits status pending→paused, route_order=null for visits on
//     those schedules with due_date BETWEEN pause_from AND pause_to. Visits
//     outside the window (already done, or future post-season) are untouched.
//
// Gate: OFFICE_OR_PM (office / admin / project_manager / super_admin). RLS
// session client scopes every read/write to the caller's org — a second
// tenant's customer_id returns no jobs, so the update is a no-op for them
// (no cross-tenant action). No customer email: this is a planning action,
// not a per-visit event.
export const dynamic = "force-dynamic";

type JobRow = { id: string };

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!OFFICE_OR_PM.has(role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { customer_id?: string; pause_from?: string; pause_to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { customer_id, pause_from, pause_to } = body;
  if (!customer_id || !pause_from || !pause_to)
    return NextResponse.json(
      { error: "customer_id, pause_from, pause_to are required" },
      { status: 400 }
    );
  if (pause_from > pause_to)
    return NextResponse.json(
      { error: "pause_from must be on or before pause_to" },
      { status: 400 }
    );

  // Resolve the customer's jobs (RLS scopes to caller org). No rows for a
  // customer that isn't in this org → the whole operation no-ops safely.
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

  // Their recurring schedules — only ACTIVE ones get paused (an already-paused
  // schedule is a no-op, but we still count it below as already paused).
  const { data: schedRows } = await supabase
    .from("recurring_schedules")
    .select("id, active")
    .in("job_id", jobIds);
  const schedules = (schedRows as unknown as { id: string; active: boolean }[] | null) ?? [];
  const activeSchedIds = schedules.filter((s) => s.active).map((s) => s.id);
  if (activeSchedIds.length === 0)
    return NextResponse.json({
      paused_schedules: 0,
      paused_visits: 0,
      note: "All of this customer's schedules are already paused",
    });

  // Flip the schedules inactive + persist the off-season window so the UI can
  // show "Paused through <pause_to>" and the nightly generate cron can
  // auto-resume on pause_to. cron stops generating for inactive schedules.
  const { error: schedErr } = await supabase
    .from("recurring_schedules")
    .update({ active: false, paused_from: pause_from, paused_until: pause_to })
    .in("id", activeSchedIds);
  if (schedErr)
    return NextResponse.json(
      { error: `Failed to pause schedules: ${schedErr.message}` },
      { status: 500 }
    );

  // Flip the in-window pending visits to paused (not deleted — preserves the
  // record of skipped winter service). Null route_order so they drop out of
  // My Route sequencing while paused.
  const { data: pausedVisits, error: visitErr } = await supabase
    .from("lawn_visits")
    .update({ status: "paused", route_order: null })
    .in("recurring_schedule_id", activeSchedIds)
    .eq("status", "pending")
    .gte("due_date", pause_from)
    .lte("due_date", pause_to)
    .select("id");
  if (visitErr)
    return NextResponse.json(
      { error: `Schedules paused, but visit update failed: ${visitErr.message}` },
      { status: 500 }
    );

  const pausedVisitsCount =
    ((pausedVisits as unknown as { id: string }[] | null) ?? []).length;

  return NextResponse.json({
    paused_schedules: activeSchedIds.length,
    paused_visits: pausedVisitsCount,
  });
}