// Submittal lifecycle — the single source of truth for which status transitions
// are valid, plus the label/tone maps every submittal view shares. Drives
// HighlightsHeader `actions` on the detail page: only valid transitions render
// as action buttons, so an invalid action can't be shown.
//
// CORRECTNESS: the transition table MIRRORS the live DB. Derived from:
//  - gc_pro_features.sql:344 -> check (status in ('draft','submitted','returned','closed'))
//  - /api/submittals/[id]/send -> guards status in (draft, returned), sets 'submitted'
//        (draft -> submitted; returned -> submitted on resubmit)
//  - /api/submittals/by-token/[token]/return -> guard `status='submitted'`, set 'returned'  (submitted -> returned)
//  - submittals/[id]/page.tsx closeSubmittal() -> sets 'closed' with NO status guard, so the
//        office can close from submitted OR returned (submitted -> closed after a successful
//        review round; returned -> closed to abandon a returned submittal the office decides
//        not to proceed with). closeSubmittal is the authority; this table mirrors it.
//
// Do NOT edit transitions from the UI. If a status-mutating path changes in the
// DB/RPCs/routes, update this table to match and re-verify against the live
// check constraint + every status-mutating handler.

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type SubmittalStatus =
  | "draft"
  | "submitted"
  | "returned"
  | "closed";

export const SUBMITTAL_STATUSES: SubmittalStatus[] = [
  "draft",
  "submitted",
  "returned",
  "closed",
];

// Valid status transitions. Status-only — role + variant gating stays in the
// page (the page intersects status-valid × role-allowed × variant-allowed).
export const SUBMITTAL_TRANSITIONS: Record<SubmittalStatus, SubmittalStatus[]> = {
  draft: ["submitted"],
  submitted: ["returned", "closed"],
  returned: ["submitted", "closed"],
  closed: [],
};

export const SUBMITTAL_STATUS_LABEL: Record<SubmittalStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  returned: "Returned",
  closed: "Closed",
};

export const SUBMITTAL_STATUS_TONE: Record<SubmittalStatus, BadgeTone> = {
  draft: "neutral",
  submitted: "brand",
  returned: "warning",
  closed: "success",
};

export function canTransition(
  from: SubmittalStatus,
  to: SubmittalStatus
): boolean {
  return SUBMITTAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTransitions(from: SubmittalStatus): SubmittalStatus[] {
  return SUBMITTAL_TRANSITIONS[from] ?? [];
}