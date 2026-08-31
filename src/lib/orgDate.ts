// "Today" as the BUSINESS sees it, not as the server or the phone sees it.
//
// THE BUG THIS EXISTS TO KILL. Every date comparison in the lawn app used
// `new Date().toISOString().slice(0, 10)` — the UTC date. From 20:00 Eastern
// each evening that is already tomorrow, so the app shifted by a day: visits
// actually due today were labelled "Overdue", and tomorrow's became "Today".
// Every night, for four hours, on the crew's own route screen.
//
// Neither obvious fix works alone. On the SERVER, local time IS UTC — that is
// what Vercel runs in — so a local-date helper changes nothing there. On the
// CLIENT, local time is whatever the device says, which is right for a crew in
// the field and wrong for an owner checking the route from another state.
//
// So the zone comes from the organisation and is passed in. Same answer on both
// sides, and it no longer depends on where the code ran or where the person was
// standing.

/** IANA zone used when an organisation has none. */
export const DEFAULT_TIME_ZONE = "America/New_York";

/**
 * The calendar date in `timeZone`, as YYYY-MM-DD.
 *
 * Built from formatToParts rather than a locale format string, because locale
 * output is not guaranteed stable across runtimes — and a date helper that is
 * subtly different on the server than in the browser would reintroduce exactly
 * the class of bug it is here to remove. Falls back to the default zone if the
 * runtime rejects the name, so a bad value degrades instead of throwing inside
 * a render.
 */
export function todayInZone(
  timeZone: string | null | undefined,
  now: Date = new Date()
): string {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const read = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  try {
    return read(zone);
  } catch {
    return read(DEFAULT_TIME_ZONE);
  }
}

export type DueBucket = "overdue" | "today" | "upcoming";

/** Which group a visit belongs in. Plain string compare — both are YYYY-MM-DD,
 *  which sorts correctly as text, so no Date objects and no timezone can creep
 *  back in here. */
export function dueBucket(dueDate: string, today: string): DueBucket {
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}

/**
 * Whole days a visit is late; 0 when due today or later.
 *
 * Both arguments are plain calendar dates, so they are parsed at UTC midnight
 * deliberately — that makes the subtraction exact and immune to DST, which a
 * local-midnight parse is not (two local midnights can be 23 or 25 hours apart).
 */
export function daysLate(dueDate: string, today: string): number {
  if (dueDate >= today) return 0;
  const a = Date.parse(`${dueDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** "Mon, 25 Aug" style stamp for a plain date. Parsed and formatted in UTC so
 *  the label can never disagree with the bucket it sits under. */
export function formatDueStamp(dueDate: string): string {
  const t = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(t)) return dueDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(t));
}

/** "3 days late" / "1 day late" / "" when not late. The office reads this on a
 *  list of exceptions, so it states the fact and nothing more. */
export function lateLabel(dueDate: string, today: string): string {
  const n = daysLate(dueDate, today);
  if (n <= 0) return "";
  return `${n} day${n === 1 ? "" : "s"} late`;
}
