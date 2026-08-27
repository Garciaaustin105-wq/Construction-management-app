// Invoice lifecycle — single source of truth for invoice status transitions +
// the label/tone maps every invoice view shares. Replaces the per-page
// STATUS_TONE/STATUS_LABEL maps added in Workstream A (list + detail), which
// had drifted: list used void=muted, detail used void=neutral. Now one map.
//
// CORRECTNESS: derived from:
//  - invoices_draft_status.sql -> check (status in ('draft','sent','paid','void')),
//      default 'draft' (new invoices start editable; office Send flips draft→sent)
//  - createInvoiceFromEstimate / runCycleBilling / NewInvoiceForm -> insert 'draft'
//      (the auto-paths auto-deliver via deliverInvoice, which flips draft→sent on
//      the first send; auto-charge flips draft→paid directly via recordInvoicePayment)
//  - /api/invoices/[id]/payments -> newStatus = isPaid ? 'paid' : 'sent'; guards void->400
//      (sent -> paid when balance covered; partial payment keeps 'sent'; a draft
//      recorded fully paid goes draft -> paid, which is correct)
//  - InvoiceActions.updateStatus (direct client writes, service-role-scoped):
//      sent  -> 'void'   (Mark Void)
//      paid  -> 'sent'   (Mark Unpaid)
//      void  -> 'sent'   (Restore as Unpaid)
//  - /api/invoices/[id]/send -> deliverInvoice flips draft→sent on the first send;
//      a re-send of an already-sent invoice keeps status 'sent' (same-status action)
//
// No paid->void (must mark unpaid first), no void->paid (must restore->sent->pay).
// draft is editable: line items may be added/edited/removed only while status='draft'
// (server-enforced — see src/lib/invoiceLineItems.ts). draft->paid happens only via
// the payment path, so it isn't a status-only transition button here.

import type { BadgeTone } from "@/components/ui/StatusBadge";

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

export const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "void"];

// Valid status transitions. Status-only — role gating stays in the page
// (InvoiceActions already role-gates which buttons render; the page intersects
// status-valid × role-allowed). draft→paid is intentionally absent: payment is
// not a status-only button (it goes through the payments API, which is the
// source of truth for amount_paid). A draft that gets fully paid flips directly
// to 'paid' server-side without consulting this map.
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["sent", "void"],
  sent: ["paid", "void"],
  paid: ["sent"],
  void: ["sent"],
};

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Unpaid",
  paid: "Paid",
  void: "Void",
};

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: "neutral",
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