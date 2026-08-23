// Punch lifecycle — the single source of truth for which status transitions
// are valid, plus the label/tone maps every punch view shares. Drives
// HighlightsHeader `actions` on the detail page: only valid transitions render
// as action buttons, so an invalid action can't be shown.
//
// CORRECTNESS: the transition table MIRRORS the live DB. Derived from:
//  - gc_pro_features.sql:152  -> check (status in ('open','in_progress','complete','void'))
//  - src/app/punch/[id]/page.tsx advance() -> the one-tap crew button (canAdvance,
//        non-canEdit users) cycles: open -> in_progress (Start), in_progress ->
//        complete (Mark Complete), complete -> open (Reopen). THIS table drives
//        that button via validTransitions(status)[0].
//  - SEPARATE path: the Status <select> (canEdit / FIELD_MGMT) in the same page
//        writes `status: item.status` via save() and lets an admin set ANY status
//        to ANY status (incl. void, complete->in_progress, open->complete). It is
//        an intentional admin free-edit / override path, NOT gated by this table.
//  - void: reachable ONLY via that admin <select>, not via a transition action.
//        The table has no inbound edge to void (no transition button sets it) and
//        void is terminal (no out-edge). If void should be reachable from a
//        normal action button, add the inbound edge here AND wire the button.
//
// Do NOT edit transitions from the UI. If a status-mutating path changes in the
// DB/RPCs/routes, update this table to match and re-verify against the live
// check constraint + every status-mutating handler.

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type PunchStatus =
  | "open"
  | "in_progress"
  | "complete"
  | "void";

export const PUNCH_STATUSES: PunchStatus[] = [
  "open",
  "in_progress",
  "complete",
  "void",
];

// Valid status transitions. Status-only — role + variant gating stays in the
// page (the page intersects status-valid × role-allowed × variant-allowed).
export const PUNCH_TRANSITIONS: Record<PunchStatus, PunchStatus[]> = {
  open: ["in_progress"],
  in_progress: ["complete"],
  complete: ["open"],
  void: [],
};

export const PUNCH_STATUS_LABEL: Record<PunchStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  complete: "Complete",
  void: "Void",
};

export const PUNCH_STATUS_TONE: Record<PunchStatus, BadgeTone> = {
  open: "neutral",
  in_progress: "warning",
  complete: "success",
  void: "muted",
};

export function canTransition(
  from: PunchStatus,
  to: PunchStatus
): boolean {
  return PUNCH_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTransitions(from: PunchStatus): PunchStatus[] {
  return PUNCH_TRANSITIONS[from] ?? [];
}