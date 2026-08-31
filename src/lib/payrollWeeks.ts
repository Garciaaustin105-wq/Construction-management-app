export type PayWeek = {
  /** ISO date (YYYY-MM-DD) of the Monday that starts this week. */
  start: string;
  /** ISO date (YYYY-MM-DD) of the Sunday that ends this week, inclusive. */
  end: string;
  /** Short display label, e.g. "Mar 3-9". */
  label: string;
};

/** Format a Date back to YYYY-MM-DD using its LOCAL fields.
 *
 *  Deliberately not the toISO/split idiom. Every Date here is built as
 *  `new Date(iso + "T00:00:00")`, i.e. LOCAL midnight; converting to a UTC
 *  string means that anywhere east of UTC, local midnight is the PREVIOUS day
 *  in UTC, and every week silently shifts back a day. It is harmless at UTC-4,
 *  which is exactly what makes it the kind of bug that ships. */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Monday of the week containing the given YYYY-MM-DD. Weeks start Monday. */
export function weekStart(iso: string): string {
  const date = new Date(iso + "T00:00:00");
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  date.setDate(diff);
  return toISODate(date);
}

/** Every week (Monday-Sunday) overlapping the inclusive range from..to.
 *  The first week may start before `from` and the last may end after `to`. */
export function weeksInRange(from: string, to: string): PayWeek[] {
  const start = new Date(weekStart(from) + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  const weeks: PayWeek[] = [];
  while (start <= end) {
    const weekEnd = new Date(start);
    weekEnd.setDate(start.getDate() + 6);
    const week: PayWeek = {
      start: toISODate(start),
      end: toISODate(weekEnd),
      label: `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}-${weekEnd.toLocaleDateString('en-US', { day: 'numeric' })}`
    };
    weeks.push(week);
    start.setDate(start.getDate() + 7);
  }
  return weeks;
}

/** Which week bucket a date belongs to: index into the given weeks array, or -1
 *  when the date falls outside all of them. */
export function weekIndexFor(iso: string, weeks: PayWeek[]): number {
  const date = new Date(iso + "T00:00:00");
  for (let i = 0; i < weeks.length; i++) {
    const weekStart = new Date(weeks[i].start + "T00:00:00");
    const weekEnd = new Date(weeks[i].end + "T00:00:00");
    if (date >= weekStart && date <= weekEnd) {
      return i;
    }
  }
  return -1;
}

/** Sum a map of YYYY-MM-DD -> hours into per-week totals aligned to `weeks`.
 *  Returns an array the same length as `weeks`. Dates in no week are ignored. */
export function bucketByWeek(byDay: Record<string, number>, weeks: PayWeek[]): number[] {
  return weeks.map(week => {
    const weekStart = new Date(week.start + "T00:00:00");
    const weekEnd = new Date(week.end + "T00:00:00");
    let total = 0;
    for (const day in byDay) {
      const date = new Date(day + "T00:00:00");
      if (date >= weekStart && date <= weekEnd) {
        total += byDay[day];
      }
    }
    return total;
  });
}

/** Round hours for display: at most one decimal. 7.25 -> "7.3", 8 -> "8". */
export function fmtHours(h: number): string {
  return h % 1 === 0 ? h.toString() : h.toFixed(1);
}
