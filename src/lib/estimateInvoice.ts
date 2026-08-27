// Shared invoice-on-approve creation, extracted from the public
// /api/estimates/by-token/[token]/decide route so both the public (token)
// estimate-approval path AND the authed proposal e-sign path create the
// identical construction invoice (deposit-only vs full-total + summary lines).
//
// Server-only; the caller passes the service-role admin client (invoice writes
// bypass customer RLS). Behavior-preserving: the math + line shapes are lifted
// verbatim from the decide route's construction branch.
//
// Does NOT flip estimates.status — the caller owns the status transition
// (the public route flips after the invoice succeeds; the sign route's
// sign_proposal RPC flips atomically before this runs). Lawn handling is also
// the caller's job (lawn → approve only, no invoice) — this helper is only for
// construction invoices.

import type { SupabaseClient } from "@supabase/supabase-js";

export type EstimateItemForInvoice = {
  description: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  position: number | string | null;
};

export type CreateInvoiceFromEstimateInput = {
  estimateId: string;
  jobId: string | null;
  customerId: string | null;
  markupPct: number;
  contingencyPct: number;
  taxPct: number;
  depositPct: number;
  depositAmount: number;
  items: EstimateItemForInvoice[];
};

export type CreateInvoiceResult =
  | { invoiceId: string; error?: undefined }
  | { invoiceId?: undefined; error: string };

// Round to cents, half away from zero (matches Postgres round(numeric, 2)).
const round2 = (n: number) =>
  (Math.round(Math.abs(n) * 100) / 100) * (n < 0 ? -1 : 1);

export async function createInvoiceFromEstimate(
  admin: SupabaseClient,
  input: CreateInvoiceFromEstimateInput
): Promise<CreateInvoiceResult> {
  const {
    estimateId,
    jobId,
    customerId,
    markupPct,
    contingencyPct,
    taxPct,
    depositPct,
    depositAmount,
    items,
  } = input;

  const subtotal = items.reduce(
    (s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0),
    0
  );
  const markupAmt = markupPct > 0 ? round2((subtotal * markupPct) / 100) : 0;
  const contAmt = contingencyPct > 0 ? round2((subtotal * contingencyPct) / 100) : 0;
  const preTax = round2(subtotal + markupAmt + contAmt);
  const taxAmt = taxPct > 0 ? round2((preTax * taxPct) / 100) : 0;
  const grandTotal = round2(preTax + taxAmt);
  const deposit =
    depositAmount > 0
      ? round2(depositAmount)
      : depositPct > 0
      ? round2((grandTotal * depositPct) / 100)
      : 0;

  // Construction → deposit-only (or full-total when no deposit split) invoice,
  // amount_paid 0 (the deposit is now owed, not pre-paid). Created 'draft': the
  // caller auto-delivers via deliverInvoice, which flips draft→sent on the first
  // send (see invoiceSend.ts). Letting it start as draft means the office could,
  // in principle, edit the just-created invoice before the (non-fatal) delivery
  // lands — but delivery is synchronous in the decide/sign routes, so in
  // practice the customer receives a 'sent' invoice just as before.
  const { data: invoice, error: invError } = await admin
    .from("invoices")
    .insert({
      estimate_id: estimateId,
      job_id: jobId,
      customer_id: customerId,
      status: "draft",
      amount_paid: 0,
    })
    .select("id")
    .single();
  if (invError || !invoice) {
    return { error: `Failed to create invoice: ${invError?.message ?? "error"}` };
  }

  if (deposit > 0) {
    // Single deposit line — the invoice total IS the deposit to start work.
    const { error: lineError } = await admin.from("invoice_line_items").insert({
      invoice_id: invoice.id,
      description: "Deposit to start work",
      quantity: 1,
      unit_price: deposit,
      position: 0,
    });
    if (lineError) {
      return { error: `Invoice created but deposit line failed: ${lineError.message}` };
    }
  } else {
    // No deposit split → full-total invoice: snapshot the line items.
    if (items.length > 0) {
      const { error: linesError } = await admin.from("invoice_line_items").insert(
        items.map((i) => ({
          invoice_id: invoice.id,
          description: i.description,
          quantity: i.quantity,
          unit_price: i.unit_price,
          position: i.position,
        }))
      );
      if (linesError) {
        return { error: `Invoice created but line items failed: ${linesError.message}` };
      }
    }

    // Pricing-summary lines so the invoice total == estimate grand total.
    let pos = items.reduce((m, i) => Math.max(m, Number(i.position) || 0), 0);
    const summaryRows: {
      invoice_id: string;
      description: string;
      quantity: number;
      unit_price: number;
      position: number;
    }[] = [];
    if (markupPct > 0) {
      pos += 1;
      summaryRows.push({
        invoice_id: invoice.id,
        description: `Overhead & Profit (${markupPct}%)`,
        quantity: 1,
        unit_price: markupAmt,
        position: pos,
      });
    }
    if (contingencyPct > 0) {
      pos += 1;
      summaryRows.push({
        invoice_id: invoice.id,
        description: `Contingency (${contingencyPct}%)`,
        quantity: 1,
        unit_price: contAmt,
        position: pos,
      });
    }
    if (taxPct > 0) {
      pos += 1;
      summaryRows.push({
        invoice_id: invoice.id,
        description: `Sales Tax (${taxPct}%)`,
        quantity: 1,
        unit_price: taxAmt,
        position: pos,
      });
    }
    if (summaryRows.length > 0) {
      const { error: summaryError } = await admin
        .from("invoice_line_items")
        .insert(summaryRows);
      if (summaryError) {
        return { error: `Invoice created but summary lines failed: ${summaryError.message}` };
      }
    }
  }

  return { invoiceId: invoice.id };
}