import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import { generateDueDates } from "@/lib/lawnRecurrence";

// POST /api/lawn/schedules/bulk-edit — apply a recurrence/price change to
// several customers' schedules at once from /lawn/jobs, then regenerate
// upcoming visits so the new cadence actually takes effect (mirrors the
// single-schedule "Reset upcoming visits" flow on /lawn/schedules/[id], just
// across a selection instead of one row).
//
// Body: { schedule_ids, frequency?, days_of_week?, day_of_month?,
//         price_per_visit?, regenerate_from?, horizon_days? }
// Only fields PRESENT in the body are patched — an omitted price never zeros
// out, an omitted days_of_week never clears mow days. regenerate_from
// defaults to today, horizon_days to 90.
//
// Only ACTIVE schedules are touched (paused ones are returned as
// skipped_inactive, unchanged — editing a paused schedule's cadence while
// leaving it paused would be surprising and the nightly cron won't generate
// for it anyway). Regeneration deletes future PENDING visits for the
// selection then regenerates from the (possibly just-updated) recurrence —
// done/skipped/paused visits are history and are never touched. The upsert
// uses ignoreDuplicates (not merge) against uniq_lawn_visits_schedule_due
// (recurring_schedule_id, due_date): a generated date that happens to
// coincide with a still-existing done/skipped row (outside the deleted
// pending window) is left alone rather than overwritten.
//
// Gate: OFFICE_OR_PM (list-level bulk op — PM is intentionally admitted here,
// unlike the narrower single-schedule detail page). RLS session client scopes
// every read/write to the caller's org.
export const dynamic = "force-dynamic";

type ScheduleRow = {
  id: string;
  active: boolean;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  job_id: string;
};

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

  let body: {
    schedule_ids?: string[];
    frequency?: string;
    days_of_week?: number[];
    day_of_month?: number | null;
    price_per_visit?: number;
    regenerate_from?: string;
    horizon_days?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const scheduleIds = Array.isArray(body.schedule_ids) ? body.schedule_ids : [];
  if (scheduleIds.length === 0)
    return NextResponse.json(
      { error: "schedule_ids is required" },
      { status: 400 }
    );

  // Partial patch — only fields actually present in the request body.
  const patch: Record<string, unknown> = {};
  if (typeof body.frequency === "string") {
    patch.frequency = body.frequency;
    patch.interval_weeks =
      body.frequency === "monthly" ? 4 : body.frequency === "biweekly" ? 2 : 1;
  }
  if (Array.isArray(body.days_of_week)) patch.days_of_week = body.days_of_week;
  if (body.day_of_month !== undefined) patch.day_of_month = body.day_of_month;
  if (typeof body.price_per_visit === "number")
    patch.price_per_visit = body.price_per_visit;

  const today = new Date().toISOString().slice(0, 10);
  const regenerateFrom = body.regenerate_from || today;
  const horizonDays =
    typeof body.horizon_days === "number" ? body.horizon_days : 90;

  // RLS scopes this to the caller's org — a cross-org id in the selection
  // simply doesn't come back, so it's silently excluded (no cross-tenant
  // action possible).
  const { data: schedRows } = await supabase
    .from("recurring_schedules")
    .select(
      "id, active, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, job_id"
    )
    .in("id", scheduleIds);
  const schedules = (schedRows as unknown as ScheduleRow[] | null) ?? [];
  const activeSchedules = schedules.filter((s) => s.active);
  const skippedInactive = schedules.length - activeSchedules.length;
  const activeIds = activeSchedules.map((s) => s.id);

  if (activeIds.length === 0)
    return NextResponse.json({
      schedules_updated: 0,
      skipped_inactive: skippedInactive,
      visits_deleted: 0,
      visits_generated: 0,
    });

  if (Object.keys(patch).length > 0) {
    const { error: updErr } = await supabase
      .from("recurring_schedules")
      .update(patch)
      .in("id", activeIds);
    if (updErr)
      return NextResponse.json(
        { error: `Failed to update schedules: ${updErr.message}` },
        { status: 500 }
      );
  }

  // Clear future pending visits for the selection so the regenerate step
  // below reflects the new cadence — preserves done/skipped/paused history.
  const { data: deletedVisits, error: delErr } = await supabase
    .from("lawn_visits")
    .delete()
    .in("recurring_schedule_id", activeIds)
    .eq("status", "pending")
    .gte("due_date", regenerateFrom)
    .select("id");
  if (delErr)
    return NextResponse.json(
      {
        error: `Schedules updated, but clearing old visits failed: ${delErr.message}`,
      },
      { status: 500 }
    );
  const visitsDeleted =
    ((deletedVisits as unknown as { id: string }[] | null) ?? []).length;

  const horizonEnd = new Date();
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + horizonDays);
  const horizonEndDate = horizonEnd.toISOString().slice(0, 10);

  const inserts: {
    recurring_schedule_id: string;
    job_id: string;
    due_date: string;
    status: "pending";
    route_order: null;
  }[] = [];
  for (const s of activeSchedules) {
    // Merge the patch onto THIS schedule's own fields — a bulk edit that only
    // changed price still needs the schedule's own frequency/days/dates to
    // generate the right dates.
    const merged = {
      frequency: (patch.frequency as string | undefined) ?? s.frequency,
      interval_weeks:
        (patch.interval_weeks as number | undefined) ?? s.interval_weeks,
      days_of_week:
        (patch.days_of_week as number[] | undefined) ?? s.days_of_week,
      day_of_month:
        patch.day_of_month !== undefined
          ? (patch.day_of_month as number | null)
          : s.day_of_month,
      start_date: s.start_date,
      end_date: s.end_date,
    };
    let genTo = horizonEndDate;
    if (s.end_date && s.end_date < genTo) genTo = s.end_date;
    const dueDates = generateDueDates(merged, regenerateFrom, genTo);
    for (const due_date of dueDates) {
      inserts.push({
        recurring_schedule_id: s.id,
        job_id: s.job_id,
        due_date,
        status: "pending",
        route_order: null,
      });
    }
  }

  let visitsGenerated = 0;
  if (inserts.length > 0) {
    const { data: inserted, error: insErr } = await supabase
      .from("lawn_visits")
      .upsert(inserts, {
        onConflict: "recurring_schedule_id,due_date",
        ignoreDuplicates: true,
      })
      .select("id");
    if (insErr)
      return NextResponse.json(
        {
          error: `Schedules updated, visits cleared, but regeneration failed: ${insErr.message}`,
        },
        { status: 500 }
      );
    visitsGenerated =
      ((inserted as unknown as { id: string }[] | null) ?? []).length;
  }

  return NextResponse.json({
    schedules_updated: activeIds.length,
    skipped_inactive: skippedInactive,
    visits_deleted: visitsDeleted,
    visits_generated: visitsGenerated,
  });
}
