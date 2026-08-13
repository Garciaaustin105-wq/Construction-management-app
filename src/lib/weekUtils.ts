// Monday-based week helpers shared by /time and the weekly report.

// Monday of the week containing d (local time).
export function startOfWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sun … 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

export function addDays(d: Date, n: number): Date {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse a ?weekStart=YYYY-MM-DD into a Monday-based Date, falling back to the
// current week on any parse failure.
export function parseWeekStart(input: string | undefined): Date {
  const today = new Date();
  if (input) {
    const parsed = new Date(`${input}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return startOfWeek(parsed);
  }
  return startOfWeek(today);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Hours as a decimal number (e.g. 7.5) — used in spreadsheet export.
export function hoursFromMs(ms: number): number {
  return Math.round((Math.max(0, ms) / 3_600_000) * 100) / 100;
}