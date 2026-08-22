// Shared types + display helpers for the ISP / fiber installs module.
// Kept in one place so the list page, the detail page, and the crew field UI
// can never drift on status wording or colour.
//
// Schema lives in isp_module.sql (installs, install_types) and
// isp_module_b.sql (time entries, issues, notes, materials, photos.install_id).

export type InstallStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "needs_followup"
  | "cancelled";

export type CompletionOutcome = "completed" | "partial" | "could_not_complete";

// A customer option rich enough for the install create/edit forms to
// auto-fill the install's address + site contact from the chosen customer and
// surface the service plan as a reference, instead of the office retyping it.
export type CustomerOption = {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  phone: string | null;
  address: string | null;
  service_plan: string | null;
};

export const INSTALL_STATUSES: InstallStatus[] = [
  "scheduled",
  "in_progress",
  "completed",
  "needs_followup",
  "cancelled",
];

export const OUTCOMES: { value: CompletionOutcome; label: string; hint: string }[] =
  [
    {
      value: "completed",
      label: "Completed",
      hint: "Work is finished, nothing left to do.",
    },
    {
      value: "partial",
      label: "Partially done",
      hint: "Some work done, a return trip is needed.",
    },
    {
      value: "could_not_complete",
      label: "Couldn't complete",
      hint: "Nothing could be done on this visit.",
    },
  ];

export const SEVERITIES: { value: string; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

export function statusLabel(s: string): string {
  if (s === "needs_followup") return "Needs follow-up";
  if (s === "in_progress") return "In progress";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function statusCls(s: string): string {
  if (s === "completed") return "bg-green-100 text-green-700";
  if (s === "in_progress") return "bg-amber-100 text-amber-800";
  if (s === "needs_followup") return "bg-orange-100 text-orange-800";
  if (s === "cancelled") return "bg-gray-100 text-gray-500";
  return "bg-gray-100 text-gray-700"; // scheduled
}

export function severityCls(s: string): string {
  if (s === "high") return "bg-red-100 text-red-700";
  if (s === "low") return "bg-gray-50 text-gray-500";
  return "bg-gray-100 text-gray-700";
}

// Priority uses the same low/normal/high value set as problem severity, so it
// shares the colour helper. The label helper keeps the wording in one place
// for the list badge, the detail page, and the create/edit form dropdowns.
export function priorityLabel(p: string | null | undefined): string {
  if (!p) return "Normal";
  const found = SEVERITIES.find((x) => x.value === p);
  return found ? found.label : p;
}

export function priorityCls(p: string | null | undefined): string {
  return severityCls(p ?? "normal");
}

export function outcomeLabel(o: string | null): string | null {
  if (!o) return null;
  const found = OUTCOMES.find((x) => x.value === o);
  return found ? found.label : o;
}

// Money — matches the invoice/estimate display convention (2dp, $ prefix).
export function money(n: number | string | null | undefined): string {
  const v = Number(n ?? 0) || 0;
  return `$${v.toFixed(2)}`;
}

// "2h 15m" / "45m" / "—". Input is milliseconds.
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export type TimeEntry = {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
};

// Total tracked time across every crew member's sessions. An OPEN entry (no
// ended_at) counts up to `now` so the field UI can show a live running total.
export function totalTrackedMs(entries: TimeEntry[], now: number = Date.now()): number {
  let ms = 0;
  for (const e of entries) {
    const start = new Date(e.started_at).getTime();
    const end = e.ended_at ? new Date(e.ended_at).getTime() : now;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      ms += end - start;
    }
  }
  return ms;
}

// Local date+time for a timestamptz, short form. Returns "—" for null so
// callers don't each write the same guard.
export function whenLabel(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
