import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { generateDueDates } from "@/lib/lawnRecurrence";
import { isLawn } from "@/lib/variant";

// Nightly lawn-visit auto-generation. For every ACTIVE recurring schedule,
// extend lawn_visits from the day after the last existing visit (or today) through
// min(end_date, today+90d), inserting pending visits. Existing dates are skipped
// by the unique(recurring_schedule_id, due_date) index (23505 ignored). This
// keeps the calendar + crew My Route populated without a manual "Generate /
// extend" tap, so a route never silently runs out of visit instances.
//
// Secured by CRON_SECRET: Vercel Cron automatically sends `Authorization: Bearer
// <CRON_SECRET>` when the env var is set. If it isn't set, the route refuses
// (401) — the cron will no-op until the secret is configured. Runs with the
// service role (bypasses RLS); triggers still fire, so organization_id is
// stamped from job_id by set_org_from_job exactly as in the app's create path.

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

export async function POST(request: Request) {
  // ── Auth: CRON_SECRET bearer token ────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 401 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One shared database, two Vercel deploys: both schedule these crons (same
  // vercel.json). The construction deploy is the established cron owner (Vercel
  // Cron has been running these against the real data); the lawn deploy's
  // scheduled invocation no-ops here to avoid double generation. (Generation is
  // also idempotent via the unique(recurring_schedule_id, due_date) index, but
  // skipping the lawn invocation keeps it clean.) If ownership ever moves to the
  // lawn deploy, flip this gate.
  if (isLawn()) {
    return NextResponse.json({ ok: true, skipped: "construction owns cron" });
  }

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured (service role missing)" },
      { status: 500 }
    );
  }
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // ── Auto-resume: reactivate every schedule whose off-season window has
  // elapsed. bulk-pause persisted paused_until = pause_to; when today reaches
  // it, flip active=true and clear the window. The active=true select below
  // then includes these schedules and the normal generation loop extends their
  // visits from today — no separate generation path (idempotent via the unique
  // index). Paused winter visits stay paused (record preserved), matching
  // manual bulk-resume. Runs on the construction-owned cron (this route no-ops
  // on the lawn deploy), same as today's generation.
  await admin
    .from("recurring_schedules")
    .update({ active: true, paused_from: null, paused_until: null })
    .eq("active", false)
    .not("paused_until", "is", null)
    .lte("paused_until", todayISO());

  const { data: rows } = await admin
    .from("recurring_schedules")
    .select(
      "id, job_id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date"
    )
    .eq("active", true);
  const schedules = (rows as unknown as Sched[] | null) ?? [];

  const today = todayISO();
  const horizon = addDaysISO(today, HORIZON_DAYS);

  let processed = 0;
  let generated = 0;
  const errors: { schedule_id: string; error: string }[] = [];

  for (const s of schedules) {
    processed += 1;
    try {
      // Last existing visit for this schedule (if any) — start the day after it
      // to avoid a 23505 duplicate, but never backfill before today.
      const { data: last } = await admin
        .from("lawn_visits")
        .select("due_date")
        .eq("recurring_schedule_id", s.id)
        .order("due_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastDue = (last as unknown as { due_date: string } | null)?.due_date ?? null;

      let from = today;
      if (lastDue && lastDue >= today) from = addDaysISO(lastDue, 1);

      let to = horizon;
      if (s.end_date && s.end_date < to) to = s.end_date;
      if (from > to) continue; // season ended or fully seeded through horizon

      const dates = generateDueDates(
        {
          frequency: s.frequency,
          interval_weeks: s.interval_weeks,
          days_of_week: s.days_of_week,
          day_of_month: s.day_of_month,
          start_date: s.start_date,
          end_date: s.end_date,
        },
        from,
        to
      );
      if (dates.length === 0) continue;

      const inserts = dates.map((due_date) => ({
        recurring_schedule_id: s.id,
        job_id: s.job_id,
        due_date,
        status: "pending" as const,
      }));
      const { error } = await admin.from("lawn_visits").insert(inserts);
      if (error && error.code !== "23505") {
        // 23505 = a date already exists (race / manual add) — expected, skip.
        errors.push({ schedule_id: s.id, error: error.message });
      } else {
        generated += dates.length;
      }
    } catch (e) {
      errors.push({
        schedule_id: s.id,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    schedules: processed,
    generated,
    errors,
  });
}