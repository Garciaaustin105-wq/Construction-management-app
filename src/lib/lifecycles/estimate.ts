// Estimate lifecycle — the single source of truth for which status transitions
// are valid, plus the label/tone maps every estimate view shares. Drives
// HighlightsHeader `actions` on the detail page: only valid transitions render
// as action buttons, so an invalid action can't be shown.
//
// CORRECTNESS: the transition table MIRRORS the live DB. Derived from:
//  - estimates.sql:78  -> check (status in ('draft','sent','approved','converted','rejected'))
//  - /api/estimates/[id]/send      -> draft|sent -> sent  (resend is a same-status action, NOT a transition)
//  - approve_quote / approve_estimate / approve_deposit_invoice / invoice_deposit_applied
//      -> all guard `status='sent'`, set 'approved'  (sent -> approved)
//  - reject_quote / reject_estimate -> guard `status='sent'`, set 'rejected'  (sent -> rejected)
//  - /api/estimates/[id]/convert (lawn Track 3) -> guards `status='approved'`, sets 'converted'
//      (approved -> converted; lawn-only — the legacy construction convert_estimate_to_quote
//      RPC was dropped in estimates_merge_b.sql:23, so 'converted' is now lawn-only)
//
// Do NOT edit transitions from the UI. If a status-mutating path changes in the
// DB/RPCs/routes, update this table to match and re-verify against the live
// check constraint + every status-mutating handler.

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type EstimateStatus =
  | "draft"
  | "sent"
  | "approved"
  | "converted"
  | "rejected";

export const ESTIMATE_STATUSES: EstimateStatus[] = [
  "draft",
  "sent",
  "approved",
  "converted",
  "rejected",
];

// Valid status transitions. Status-only — role + variant gating stays in the
// page (the page intersects status-valid × role-allowed × variant-allowed).
// `approved -> converted` is lawn-only in practice; the page hides the action
// on construction, so the table can stay variant-agnostic.
export const ESTIMATE_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ["sent"],
  sent: ["approved", "rejected"],
  approved: ["converted"],
  rejected: [],
  converted: [],
};

export const ESTIMATE_STATUS_LABEL: Record<EstimateStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  converted: "Converted",
  rejected: "Rejected",
};

export const ESTIMATE_STATUS_TONE: Record<EstimateStatus, BadgeTone> = {
  draft: "neutral",
  sent: "brand",
  approved: "success",
  converted: "success",
  rejected: "danger",
};

export function canTransition(
  from: EstimateStatus,
  to: EstimateStatus
): boolean {
  return ESTIMATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTransitions(from: EstimateStatus): EstimateStatus[] {
  return ESTIMATE_TRANSITIONS[from] ?? [];
}