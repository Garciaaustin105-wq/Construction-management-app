// Invoice lifecycle — single source of truth for invoice status transitions +
// the label/tone maps every invoice view shares. Replaces the per-page
// STATUS_TONE/STATUS_LABEL maps added in Workstream A (list + detail), which
// had drifted: list used void=muted, detail used void=neutral. Now one map.
//
// CORRECTNESS: derived from:
//  - quotes_invoices.sql:37 -> check (status in ('sent','paid','void')), default 'sent'
//      (invoices have NO 'draft' status — created on approval as 'sent')
//  - /api/invoices/[id]/payments -> newStatus = isPaid ? 'paid' : 'sent'; guards void->400
//      (sent -> paid when balance covered; partial payment keeps 'sent')
//  - InvoiceActions.updateStatus (direct client writes, service-role-scoped):
//      sent  -> 'void'   (Mark Void)
//      paid  -> 'sent'   (Mark Unpaid)
//      void  -> 'sent'   (Restore as Unpaid)
//  - /api/invoices/[id]/send -> re-send keeps status 'sent' (same-status action, NOT a transition)
//
// No paid->void (must mark unpaid first), no void->paid (must restore->sent->pay).

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type InvoiceStatus = "sent" | "paid" | "void";

export const INVOICE_STATUSES: InvoiceStatus[] = ["sent", "paid", "void"];

// Valid status transitions. Status-only — role gating stays in the page
// (InvoiceActions already role-gates which buttons render; the page intersects
// status-valid × role-allowed).
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  sent: ["paid", "void"],
  paid: ["sent"],
  void: ["sent"],
};

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  sent: "Unpaid",
  paid: "Paid",
  void: "Void",
};

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  sent: "brand",
  paid: "success",
  void: "muted",
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTransitions(from: InvoiceStatus): InvoiceStatus[] {
  return INVOICE_TRANSITIONS[from] ?? [];
}