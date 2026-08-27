// Lawn visit lifecycle — single source of truth for lawn_visits status
// transitions + the label/tone maps every visit view shares. Drives
// HighlightsHeader `actions` on the visit detail page: only valid transitions
// render as action buttons, so an invalid action can't be shown.
//
// CORRECTNESS: derived from:
//  - lawn_maintenance.sql:167 -> status text not null default 'pending'
//      (comment: 'pending'|'done'|'skipped'|'paused')
//  - lawn_maintenance.sql:29 -> NO DB CHECK constraint on status — the APP
//      enforces the domain. So this module IS the enforcement source for the
//      UI; treat it as authoritative, not a mirror of a DB constraint.
//  - /api/lawn/visits/[id]/status -> pending -> done (mark done) / skipped;
//      done -> pending (reopen); skipped -> pending (reopen). completed_at set
//      on done, cleared otherwise; skip_reason set on skipped, cleared on pending.
//  - /api/lawn/schedules/bulk-pause -> sets status='paused' (schedule-level
//      bulk action, NOT a per-visit transition). bulk-resume flips paused visits
//      with due_date >= resume_from back to pending (audit §5.1: they used to
//      be left as-is and cluttered the calendar forever). A single paused visit
//      can also be reopened per-visit via the /status route (paused -> pending).
//
// Tones mirror the previous hand-rolled map (visits/[id]/page.tsx:66 + lawn
// page.tsx:56): pending amber, done green, skipped gray, paused blue.

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type LawnVisitStatus = "pending" | "done" | "skipped" | "paused";

export const LAWN_VISIT_STATUSES: LawnVisitStatus[] = [
  "pending",
  "done",
  "skipped",
  "paused",
];

// Valid status transitions. Status-only — role + variant gating stays in the
// page (the visit-status route already role-gates OFFICE_OR_PM vs crew;
// the page intersects status-valid × role-allowed). `paused` is set by the
// schedule bulk-pause mechanism; it can be cleared two ways: bulk-resume (for
// a whole customer — flips paused visits with due_date >= resume_from back to
// pending) OR a per-visit "Reopen" on this detail page (audit §5.1: an office
// that wants to service one property mid-pause needs a way to reopen its visit
// without un-pausing the whole account). paused -> pending reuses the existing
// Reopen action + the /status route (which clears completed_at/skip_reason and
// fires no notification — only done/skipped notify).
export const LAWN_VISIT_TRANSITIONS: Record<LawnVisitStatus, LawnVisitStatus[]> = {
  pending: ["done", "skipped"],
  done: ["pending"],
  skipped: ["pending"],
  paused: ["pending"],
};

export const LAWN_VISIT_STATUS_LABEL: Record<LawnVisitStatus, string> = {
  pending: "Pending",
  done: "Done",
  skipped: "Skipped",
  paused: "Paused",
};

export const LAWN_VISIT_STATUS_TONE: Record<LawnVisitStatus, BadgeTone> = {
  pending: "warning",
  done: "success",
  skipped: "muted",
  paused: "brand",
};

export function canTransition(
  from: LawnVisitStatus,
  to: LawnVisitStatus
): boolean {
  return LAWN_VISIT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTransitions(from: LawnVisitStatus): LawnVisitStatus[] {
  return LAWN_VISIT_TRANSITIONS[from] ?? [];
}