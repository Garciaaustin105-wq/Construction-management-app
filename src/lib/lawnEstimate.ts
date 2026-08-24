// Lawn estimate → separately-scheduled jobs (Track 3). Shared contract for the
// convert server route, the estimate save paths, the E2E script, and the Opus-
// built UI. Written first so everything builds against it. See
// ESTIMATE_CONVERT_HANDOFF.md + [[lowvoltage-opus-heavy-delegation]].
//
// A lawn estimate line item MAY carry recurrence metadata. On approval the
// office runs the convert route, which spawns one recurring_schedules row per
// schedulable line onto the (existing or new) lawn job and seeds visits via the
// existing recurrence engine (@/lib/lawnRecurrence). Construction line items
// leave the schedule_* fields null — the cadence UI is hidden on construction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateDueDates, frequencyLabel, weekdayLabels, ordinal } from "@/lib/lawnRecurrence";

// ── Frequencies ──────────────────────────────────────────────────────────────

export const SCHEDULE_FREQUENCIES = ["weekly", "biweekly", "monthly", "one-time"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  "one-time": "One-time",
};

// interval_weeks per frequency (mirrors lawn/new page INTERVAL_BY_FREQUENCY).
export const INTERVAL_BY_FREQUENCY: Record<Exclude<ScheduleFrequency, "one-time">, number> = {
  weekly: 1,
  biweekly: 2,
  monthly: 4,
};

// ── Types ────────────────────────────────────────────────────────────────────

// The 6 cadence columns on estimate_line_items (+ the conversion stamp). This
// is the shape the editor collects, the save paths persist, and the route reads.
export type EstimateLineSchedule = {
  schedule_frequency: ScheduleFrequency | null;
  schedule_interval_weeks: number; // 1 | 2 | 4
  schedule_days_of_week: number[]; // 0=Sun..6=Sat
  schedule_day_of_month: number | null; // 1..28 (monthly)
  schedule_start_date: string | null; // ISO date — season start, or service date for one-time
  schedule_end_date: string | null; // ISO date — null = open-ended season
  recurring_schedule_id: string | null; // stamped by the convert route
};

// A line-item row as the convert route loads it from the DB (office select).
// The editor's EstimateLine (in EstimateLineItemEditor.tsx) carries the same
// schedule_* field names; the save paths map between them.
export type EstimateLineRow = {
  id: string;
  description: string | null;
  section: string | null;
  unit_price: number;
  quantity: number;
} & EstimateLineSchedule;

// Empty cadence for a fresh line item (used by the editor's add() defaults).
export const EMPTY_SCHEDULE: EstimateLineSchedule = {
  schedule_frequency: null,
  schedule_interval_weeks: 1,
  schedule_days_of_week: [],
  schedule_day_of_month: null,
  schedule_start_date: null,
  schedule_end_date: null,
  recurring_schedule_id: null,
};

// A line is schedulable when it has a frequency + a start date. interval/days
// are validated by the editor; the route trusts rows that pass this gate.
export function isSchedulable(line: Pick<EstimateLineSchedule, "schedule_frequency" | "schedule_start_date">): boolean {
  return !!line.schedule_frequency && !!line.schedule_start_date;
}

// ── Line item → recurring_schedules row ──────────────────────────────────────

// Maps a schedulable line item to a recurring_schedules insert payload.
// organization_id is NOT sent — trg_recurring_schedules_org stamps it from
// job_id via set_org_from_job (same as every job-child table). For one-time,
// the schedule is bounded to start=end=service date so the recurrence engine
// emits exactly one visit (no engine change needed).
export function lineItemToScheduleRow(
  line: EstimateLineRow,
  jobId: string,
  userId: string
): {
  job_id: string;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  service_type: string;
  price_per_visit: number;
  active: boolean;
  created_by: string;
} {
  const freq = line.schedule_frequency as ScheduleFrequency;
  const start = line.schedule_start_date as string;

  if (freq === "one-time") {
    // Bounded schedule → one visit. days_of_week carries the service date's
    // weekday so the weekly engine emits that single date within [start, start].
    const dow = new Date(`${start}T00:00:00.000Z`).getUTCDay();
    return {
      job_id: jobId,
      frequency: "one-time",
      interval_weeks: 1,
      days_of_week: [dow],
      day_of_month: null,
      start_date: start,
      end_date: start, // bounded → single visit
      service_type: line.description?.trim() || line.section?.trim() || "Service",
      price_per_visit: Number(line.unit_price) || 0,
      active: true,
      created_by: userId,
    };
  }

  const intervalWeeks = INTERVAL_BY_FREQUENCY[freq];
  return {
    job_id: jobId,
    frequency: freq,
    interval_weeks: intervalWeeks,
    days_of_week: freq === "monthly" ? [] : line.schedule_days_of_week ?? [],
    day_of_month: freq === "monthly" ? line.schedule_day_of_month ?? null : null,
    start_date: start,
    end_date: line.schedule_end_date || null,
    service_type: line.description?.trim() || line.section?.trim() || "Service",
    price_per_visit: Number(line.unit_price) || 0,
    active: true,
    created_by: userId,
  };
}

// ── Visit seeding (extracted from lawn/new createRecurring) ──────────────────

type InsertedSchedule = {
  id: string;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
};

// Generate + insert pending lawn_visits for one schedule over the 90-day
// horizon (mirrors src/app/lawn/new/page.tsx:171-200). 23505 (dup date) is
// swallowed — the unique index uniq_lawn_visits_schedule_due guards it.
// Returns the number of visits seeded.
export async function seedVisitsForSchedule(
  schedule: InsertedSchedule,
  jobId: string,
  supabase: SupabaseClient
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const genFrom = schedule.start_date > today ? schedule.start_date : today;
  const todayPlus90 = new Date();
  todayPlus90.setUTCDate(todayPlus90.getUTCDate() + 90);
  let genTo = todayPlus90.toISOString().slice(0, 10);
  if (schedule.end_date && schedule.end_date < genTo) genTo = schedule.end_date;

  const dueDates = generateDueDates(
    {
      frequency: schedule.frequency,
      interval_weeks: schedule.interval_weeks,
      days_of_week: schedule.days_of_week,
      day_of_month: schedule.day_of_month,
      start_date: schedule.start_date,
      end_date: schedule.end_date,
    },
    genFrom,
    genTo
  );
  if (dueDates.length === 0) return 0;

  const visits = dueDates.map((due_date) => ({
    recurring_schedule_id: schedule.id,
    job_id: jobId,
    due_date,
    status: "pending" as const,
  }));
  const { error } = await supabase.from("lawn_visits").insert(visits);
  if (error && error.code !== "23505") {
    throw new Error(`Visits failed: ${error.message}`);
  }
  return dueDates.length;
}

// ── Core conversion (client-agnostic — route passes RLS session, E2E service) ─

export type ConvertedSchedule = {
  lineItemId: string;
  scheduleId: string;
  serviceType: string;
  visitCount: number;
};

export type ConvertResult = {
  schedules: ConvertedSchedule[];
};

// Spawn one recurring_schedules row per schedulable line item onto `jobId`,
// stamp each line's recurring_schedule_id, seed visits, and flip the estimate
// to status='converted' + converted_at. Idempotent: lines that already carry a
// recurring_schedule_id are skipped, so a retry after a partial failure only
// fills in what's missing (the status flip is the last step).
export async function convertEstimateToSchedules(
  params: { estimateId: string; jobId: string; lineItems: EstimateLineRow[]; userId: string },
  supabase: SupabaseClient
): Promise<ConvertResult> {
  const { estimateId, jobId, lineItems, userId } = params;
  const schedules: ConvertedSchedule[] = [];

  for (const line of lineItems) {
    // Skip non-schedulable lines + lines already converted (retry safety).
    if (!isSchedulable(line) || line.recurring_schedule_id) continue;

    const row = lineItemToScheduleRow(line, jobId, userId);
    const { data: sched, error: schedErr } = await supabase
      .from("recurring_schedules")
      .insert(row)
      .select("id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date")
      .single();
    if (schedErr || !sched) {
      throw new Error(`Schedule failed for "${line.description ?? line.section ?? "line"}": ${schedErr?.message ?? "error"}`);
    }

    // Stamp the line item with the spawned schedule (office RLS write).
    const { error: stampErr } = await supabase
      .from("estimate_line_items")
      .update({ recurring_schedule_id: sched.id })
      .eq("id", line.id);
    if (stampErr) {
      throw new Error(`Failed to link line item to schedule: ${stampErr.message}`);
    }

    const visitCount = await seedVisitsForSchedule(sched as InsertedSchedule, jobId, supabase);
    schedules.push({
      lineItemId: line.id,
      scheduleId: sched.id,
      serviceType: row.service_type,
      visitCount,
    });
  }

  // Flip the estimate to converted (last step — only after schedules survive).
  const { error: flipErr } = await supabase
    .from("estimates")
    .update({ status: "converted", converted_at: new Date().toISOString() })
    .eq("id", estimateId);
  if (flipErr) {
    throw new Error(`Failed to mark estimate converted: ${flipErr.message}`);
  }

  return { schedules };
}

// ── Summary chip (for the editor + customer document) ────────────────────────

// One-line cadence summary for a line item, e.g.:
//   "Weekly · Mon, Thu · Mar 1 – Oct 31"
//   "One-time · Jun 15"
//   "Monthly · 15th · Mar 1 – Oct 31"
// Returns "" when the line isn't scheduled.
export function summarizeLineSchedule(line: Pick<EstimateLineSchedule, "schedule_frequency" | "schedule_interval_weeks" | "schedule_days_of_week" | "schedule_day_of_month" | "schedule_start_date" | "schedule_end_date">): string {
  const freq = line.schedule_frequency;
  if (!freq || !line.schedule_start_date) return "";

  const start = fmtDate(line.schedule_start_date);
  const end = line.schedule_end_date ? fmtDate(line.schedule_end_date) : null;
  const season = end ? `${start} – ${end}` : `from ${start}`;

  if (freq === "one-time") {
    return `One-time · ${start}`;
  }
  if (freq === "monthly" && line.schedule_day_of_month) {
    return `Monthly · ${ordinal(line.schedule_day_of_month)} · ${season}`;
  }
  return `${frequencyLabel(freq)} · ${weekdayLabels(line.schedule_days_of_week)} · ${season}`;
}

function fmtDate(iso: string): string {
  // "2026-03-01" → "Mar 1" (UTC, matches the recurrence engine's all-day dates).
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}