// Daily Log lifecycle — the single source of truth for which status transitions
// are valid, plus the label/tone maps every daily log view shares. Drives
// HighlightsHeader `actions` on the detail page: only valid transitions render
// as action buttons, so an invalid action can't be shown.
//
// CORRECTNESS: the transition table MIRRORS the live DB. Derived from:
//  - gc_pro_features.sql:76  -> check (status in ('submitted','reviewed'))
//  - daily-logs/[id]/page.tsx -> submitted -> reviewed  (review action)
//
// Do NOT edit transitions from the UI. If a status-mutating path changes in the
// DB/RPCs/routes, update this table to match and re-verify against the live
// check constraint + every status-mutating handler.

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type DailyLogStatus =
  | "submitted"
  | "reviewed";

export const DAILY_LOG_STATUSES: DailyLogStatus[] = [
  "submitted",
  "reviewed",
];

// Valid status transitions. Status-only — role + variant gating stays in the
// page (the page intersects status-valid × role-allowed × variant-allowed).
export const DAILY_LOG_TRANSITIONS: Record<DailyLogStatus, DailyLogStatus[]> = {
  submitted: ["reviewed"],
  reviewed: [],
};

export const DAILY_LOG_STATUS_LABEL: Record<DailyLogStatus, string> = {
  submitted: "Submitted",
  reviewed: "Reviewed",
};

export const DAILY_LOG_STATUS_TONE: Record<DailyLogStatus, BadgeTone> = {
  submitted: "brand",
  reviewed: "success",
};

export function canTransition(
  from: DailyLogStatus,
  to: DailyLogStatus
): boolean {
  return DAILY_LOG_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTransitions(from: DailyLogStatus): DailyLogStatus[] {
  return DAILY_LOG_TRANSITIONS[from] ?? [];
}