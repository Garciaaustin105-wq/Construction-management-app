import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { generateDueDates } from "@/lib/lawnRecurrence";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";

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
// Vercel default function timeout (10s Hobby) is too short for a platform-wide
// visit-generation sweep. Bump to the Hobby plan ceiling (60s). The N+1 loop
// below is batched so this is headroom, not a substitute — but it stops a large
// org base from silently timing out mid-sweep. Raise to 300 if moved to Pro.
export const maxDuration = 60;

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
  default_crew_id: string | null;
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
      "id, job_id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, default_crew_id"
    )
    .eq("active", true)
    .order("id", { ascending: true });
  const schedules = (rows as unknown as Sched[] | null) ?? [];

  const today = todayISO();
  const horizon = addDaysISO(today, HORIZON_DAYS);

  // One aggregate replaces the per-schedule "last visit" query (the old loop did
  // one lawn_visits query per schedule). We only need the last due_date per
  // schedule, and only when it's >= today: a last visit before today doesn't move
  // the `from` anchor (it stays `today`), so filter due_date >= today to skip the
  // bulk of historical visits and reduce to the max per schedule in JS. Chunked
  // .in() — PostgREST degrades on very large IN lists. Covered by the
  // uniq_lawn_visits_schedule_due (recurring_schedule_id, due_date) index.
  const scheduleIds = schedules.map((s) => s.id);
  const lastDueBySchedule = new Map<string, string>();
  const IN_CHUNK = 1000;
  for (let i = 0; i < scheduleIds.length; i += IN_CHUNK) {
    const chunk = scheduleIds.slice(i, i + IN_CHUNK);
    const { data: futureVisits } = await admin
      .from("lawn_visits")
      .select("recurring_schedule_id, due_date")
      .in("recurring_schedule_id", chunk)
      .gte("due_date", today);
    for (const v of (futureVisits ?? []) as {
      recurring_schedule_id: string;
      due_date: string;
    }[]) {
      const cur = lastDueBySchedule.get(v.recurring_schedule_id);
      if (!cur || v.due_date > cur) {
        lastDueBySchedule.set(v.recurring_schedule_id, v.due_date);
      }
    }
  }

  // Compute every schedule's due dates in one pure-JS pass — no DB inside the
  // loop. Schedules that error (bad cadence config) are recorded per-schedule;
  // the rest accumulate inserts for a batched upsert below.
  let processed = 0;
  let generated = 0;
  const errors: { schedule_id: string; error: string }[] = [];
  const allInserts: {
    recurring_schedule_id: string;
    job_id: string;
    due_date: string;
    status: "pending";
    crew_id: string | null;
  }[] = [];

  for (const s of schedules) {
    processed += 1;
    try {
      const lastDue = lastDueBySchedule.get(s.id) ?? null;

      // Start the day after the last existing visit to avoid a duplicate, but
      // never backfill before today.
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

      for (const due_date of dates) {
        allInserts.push({
          recurring_schedule_id: s.id,
          job_id: s.job_id,
          due_date,
          status: "pending",
          crew_id: s.default_crew_id,
        });
      }
    } catch (e) {
      errors.push({
        schedule_id: s.id,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  // Batch the inserts across schedules. upsert with onConflict + ignoreDuplicates
  // makes the whole sweep idempotent — the resume mechanism: a re-run (after a
  // timeout, or a double-fire if the cron gate ever broke) silently skips dates
  // that already exist instead of 23505-ing, so nothing is silently dropped and
  // nothing is duplicated. Chunked to keep payloads bounded and isolate any
  // failure to a slice. .select() returns only the rows actually inserted
  // (conflicts are ignored, not returned) → an accurate generated count.
  const UPSERT_CHUNK = 500;
  for (let i = 0; i < allInserts.length; i += UPSERT_CHUNK) {
    const slice = allInserts.slice(i, i + UPSERT_CHUNK);
    const { data: inserted, error } = await admin
      .from("lawn_visits")
      .upsert(slice, {
        onConflict: "recurring_schedule_id,due_date",
        ignoreDuplicates: true,
      })
      .select("due_date");
    if (error) {
      // Rare — upsert handles conflicts. Surface against the schedules in this
      // slice rather than silently lose the count.
      const sliceSchedIds = [
        ...new Set(slice.map((r) => r.recurring_schedule_id)),
      ];
      for (const sid of sliceSchedIds) {
        errors.push({ schedule_id: sid, error: error.message });
      }
    } else {
      generated += (inserted ?? []).length;
    }
  }

  // FAILURE VISIBILITY. This used to return `ok: true` + HTTP 200 no matter how
  // many schedules failed: Vercel Cron logged a success, nothing threw so Sentry
  // saw nothing, and a run where most schedules errored looked identical to a
  // clean one. Since this cron is what generates visits, a silent half-failure
  // means customers stop getting service and the first signal is a complaint.
  //
  // Now: any per-schedule error is reported to Sentry (the actual alerting
  // channel) and `ok` reflects reality. HTTP stays 200 for a PARTIAL failure —
  // most schedules did generate, and a non-2xx would misreport a mostly-good run
  // — but a run where EVERY schedule failed returns 500 so the scheduler shows
  // red.
  if (errors.length > 0) {
    captureException(
      new Error(
        `lawn/cron/generate: ${errors.length}/${processed} schedules failed`
      ),
      {
        extra: {
          processed,
          generated,
          failed: errors.length,
          // Bounded sample — the full list can be large and adds no triage value.
          sample: errors.slice(0, 10),
        },
      }
    );
  }

  const allFailed = processed > 0 && errors.length === processed;
  return NextResponse.json(
    {
      ok: errors.length === 0,
      schedules: processed,
      generated,
      errors,
    },
    { status: allFailed ? 500 : 200 }
  );
}