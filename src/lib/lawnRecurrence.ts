// Pure recurrence helpers for the Lawn Maintenance feature. No Supabase, no
// React — unit-testable and shared by the job-create flow (initial generation)
// and the schedule-detail page (regenerate / extend).
//
// Dates are ISO 'YYYY-MM-DD' strings and all arithmetic is done at UTC midnight
// so a visit date never drifts across a timezone boundary (the iCal feed and
// the DB `date` column both treat these as all-day values).

export type RecurringSchedule = {
  frequency: string; // 'weekly' | 'biweekly' | 'monthly'
  interval_weeks: number; // 1 = weekly, 2 = biweekly, 4 = monthly
  days_of_week: number[]; // 0=Sun .. 6=Sat, for weekly/biweekly
  day_of_month: number | null; // 1..28, for true monthly
  start_date: string; // ISO date
  end_date: string | null; // ISO date, null = open-ended
  price_per_visit: number;
  service_type: string | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse an ISO date string into a UTC-midnight Date.
function parseISO(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// Format a UTC-midnight Date back to an ISO 'YYYY-MM-DD' string.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const FULL_WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Generate every visit due date in [fromDate, min(toDate, end_date)].
//
// Weekly / biweekly: walk day-by-day from the schedule's start_date (the cycle
// anchor — it need NOT be a selected weekday). A date is due when its weekday
// is selected AND its week-index since start_date is a multiple of
// interval_weeks. This gives correct "every N weeks" semantics across multiple
// selected weekdays: Mon+Thu biweekly fires both days in active weeks only.
//
// Monthly (interval_weeks === 4): emit day_of_month for each month in range.
// day_of_month is constrained to 1..28 by the form, so Feb never overflows.
export function generateDueDates(
  schedule: Pick<
    RecurringSchedule,
    | "frequency"
    | "interval_weeks"
    | "days_of_week"
    | "day_of_month"
    | "start_date"
    | "end_date"
  >,
  fromDate: string,
  toDate: string
): string[] {
  const start = parseISO(schedule.start_date);
  const from = parseISO(fromDate);
  const to = parseISO(toDate);
  const end = schedule.end_date ? parseISO(schedule.end_date) : null;

  // The window we generate inside: [max(start, from), min(end, to)].
  const windowStart = start.getTime() > from.getTime() ? start : from;
  let windowEnd = to;
  if (end && end.getTime() < windowEnd.getTime()) windowEnd = end;
  if (windowStart.getTime() > windowEnd.getTime()) return [];

  const out: string[] = [];

  if (schedule.interval_weeks >= 4 && schedule.day_of_month) {
    // ── Monthly: day_of_month of each month in [windowStart, windowEnd].
    const dom = schedule.day_of_month; // 1..28
    let cursor = new Date(
      Date.UTC(
        windowStart.getUTCFullYear(),
        windowStart.getUTCMonth(),
        dom
      )
    );
    // If the first month's date is before windowStart, step to next month.
    if (cursor.getTime() < windowStart.getTime()) {
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth() + 1,
          dom
        )
      );
    }
    while (cursor.getTime() <= windowEnd.getTime()) {
      out.push(isoDate(cursor));
      cursor = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, dom)
      );
    }
    return out;
  }

  // ── Weekly / biweekly: walk day-by-day, selecting weekdays in active cycles.
  const interval = Math.max(1, schedule.interval_weeks || 1);
  const selected = new Set(schedule.days_of_week ?? []);
  const cursor = new Date(windowStart);
  while (cursor.getTime() <= windowEnd.getTime()) {
    const dow = cursor.getUTCDay();
    if (selected.has(dow)) {
      const diffDays = Math.round(
        (cursor.getTime() - start.getTime()) / MS_PER_DAY
      );
      const weekIndex = Math.floor(diffDays / 7);
      if (weekIndex >= 0 && weekIndex % interval === 0) {
        out.push(isoDate(cursor));
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// Human label for a set of weekday numbers, e.g. [1, 4] -> "Mon, Thu".
export function weekdayLabels(days: number[] | null | undefined): string {
  if (!days || days.length === 0) return "—";
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_LABELS[d] ?? String(d))
    .join(", ");
}

// Canonical frequency label.
export function frequencyLabel(frequency: string): string {
  switch (frequency) {
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Biweekly";
    case "monthly":
      return "Monthly";
    default:
      return frequency;
  }
}

// One-line summary for a schedule card, e.g.:
//   "Biweekly · Mon, Thu · $45/visit"
//   "Monthly · 15th · $80/visit"
export function summarizeSchedule(
  schedule: Pick<
    RecurringSchedule,
    | "frequency"
    | "days_of_week"
    | "day_of_month"
    | "price_per_visit"
  >
): string {
  const freq = frequencyLabel(schedule.frequency);
  if (schedule.frequency === "monthly" && schedule.day_of_month) {
    const ord = ordinal(schedule.day_of_month);
    return `${freq} · ${ord} · ${formatPrice(schedule.price_per_visit)}/visit`;
  }
  return `${freq} · ${weekdayLabels(schedule.days_of_week)} · ${formatPrice(
    schedule.price_per_visit
  )}/visit`;
}

// 1..28 -> "1st", "2nd", "3rd", "4th"... "15th"...
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatPrice(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(n) || 0);
}