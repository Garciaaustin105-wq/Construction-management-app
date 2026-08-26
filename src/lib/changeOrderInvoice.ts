// Server-only. Pulls an APPROVED change order onto the original estimate's
// invoice as a single line item, so the customer's invoice/receipt reflects
// approved COs. Mirrors src/lib/estimateInvoice.ts: the caller passes the
// service-role admin client (invoice writes bypass customer RLS). Called from
// every CO-approval path AFTER the status flip to 'approved' — the approval
// guard (in the decide_change_order / office_approve_change_order RPCs, or the
// token-route's status check) has already authorized the change; this helper
// only does the invoice write.
//
// Idempotent + double-billing-safe: a guard query checks for an existing line
// with this source_change_order_id, and the uniq_ili_source_change_order partial
// unique index is the concurrency backstop (a racing duplicate insert throws).
// Safe to retry, safe to re-run on a re-approve.
//
// Target invoice selection (per Issue 4 decisions):
//  - the invoice whose estimate is the CO's job's APPROVED, NO-DEPOSIT estimate
//    (a full-total invoice — deposit-only invoices are skipped, since their
//    total is just the deposit and tacking COs on would conflate deposit + COs
//    while omitting the remaining balance);
//  - the invoice must NOT be paid/void — loadInvoiceReceiptForEmail hardcodes
//    amountPaid=total/balanceDue=0 for paid invoices, so adding CO lines to a
//    paid invoice would falsely show the COs as already paid. A paid invoice is
//    closed; a CO approved after payment needs a new invoice (out of scope).
// If no such invoice exists the helper skips (returns skipped) — it never
// invents an invoice.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ApplyCoResult =
  | { invoiceId: string; skipped?: undefined; error?: undefined }
  | { invoiceId: string | null; skipped: string; error?: undefined }
  | { invoiceId: null; skipped?: undefined; error: string };

type CoRow = {
  id: string;
  status: string;
  job_id: string;
  organization_id: string;
  co_number: string | null;
  title: string;
  amount: string | number | null;
  is_credit: boolean | null;
};

type InvoiceRow = {
  id: string;
  organization_id: string;
  estimate_id: string;
};

export async function applyApprovedChangeOrderToInvoice(
  admin: SupabaseClient,
  coId: string
): Promise<ApplyCoResult> {
  // 1. Load the CO. Only approved COs belong on an invoice.
  const { data: coRow, error: coErr } = await admin
    .from("change_orders")
    .select(
      "id, status, job_id, organization_id, co_number, title, amount, is_credit"
    )
    .eq("id", coId)
    .maybeSingle();
  if (coErr) return { invoiceId: null, error: `load CO: ${coErr.message}` };
  if (!coRow) return { invoiceId: null, skipped: "change order not found" };
  const co = coRow as unknown as CoRow;
  if (co.status !== "approved") {
    return { invoiceId: null, skipped: `not approved (status=${co.status})` };
  }

  // 2. Find the target invoice: open (not paid/void) invoice from the job's
  //    approved no-deposit (full-total) estimate. Two-step to avoid a PostgREST
  //    embed; pick the oldest such invoice for the job.
  const { data: invCandidates, error: invErr } = await admin
    .from("invoices")
    .select("id, organization_id, estimate_id")
    .eq("job_id", co.job_id)
    .not("estimate_id", "is", null)
    .in("status", ["sent", "draft", "overdue"])
    .order("created_at", { ascending: true })
    .limit(10);
  if (invErr) return { invoiceId: null, error: `load invoices: ${invErr.message}` };

  const candidates = (invCandidates ?? []) as unknown as InvoiceRow[];
  if (candidates.length === 0) {
    return { invoiceId: null, skipped: "no open invoice for job" };
  }

  // Confirm each candidate's estimate is approved + no-deposit; take the first.
  const estimateIds = Array.from(
    new Set(candidates.map((c) => c.estimate_id).filter(Boolean))
  );
  const { data: estRows } = await admin
    .from("estimates")
    .select("id, status, deposit_amount, deposit_pct")
    .in("id", estimateIds);
  const estByid = new Map<
    string,
    { status: string; deposit_amount: string | number | null; deposit_pct: string | number | null }
  >();
  for (const e of (estRows ?? []) as {
    id: string;
    status: string;
    deposit_amount: string | number | null;
    deposit_pct: string | number | null;
  }[]) {
    estByid.set(e.id, e);
  }

  let target: InvoiceRow | null = null;
  for (const c of candidates) {
    const e = estByid.get(c.estimate_id);
    if (!e) continue;
    if (e.status !== "approved") continue;
    const depAmt = Number(e.deposit_amount) || 0;
    const depPct = Number(e.deposit_pct) || 0;
    if (depAmt > 0 || depPct > 0) continue; // deposit-only invoice — skip
    target = c;
    break;
  }
  if (!target) {
    return { invoiceId: null, skipped: "no full-total open invoice for job" };
  }

  // 3. Double-billing guard — already added?
  const { data: existing } = await admin
    .from("invoice_line_items")
    .select("id")
    .eq("source_change_order_id", coId)
    .maybeSingle();
  if (existing) {
    return { invoiceId: target.id, skipped: "already added" };
  }

  // 4. Insert the line. Credit COs use a negative unit_price (reduces total).
  const amount = Math.abs(Number(co.amount) || 0);
  const unitPrice = co.is_credit ? -amount : amount;
  const coLabel = co.co_number ? ` ${co.co_number}` : "";
  const description = `Change order${coLabel} — ${co.title}${
    co.is_credit ? " (credit)" : ""
  }`;

  // position = max existing position on the invoice + 1.
  const { data: posRow } = await admin
    .from("invoice_line_items")
    .select("position")
    .eq("invoice_id", target.id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextPos = (Number((posRow as { position: number | null } | null)?.position ?? 0) || 0) + 1;

  const { error: insErr } = await admin.from("invoice_line_items").insert({
    invoice_id: target.id,
    description,
    quantity: 1,
    unit_price: unitPrice,
    position: nextPos,
    organization_id: target.organization_id ?? co.organization_id,
    source_change_order_id: coId,
  });
  if (insErr) {
    // uniq_ili_source_change_order racing duplicate → already added, not a failure.
    if (/uniq_ili_source_change_order|duplicate key/i.test(insErr.message)) {
      return { invoiceId: target.id, skipped: "already added (race)" };
    }
    return { invoiceId: null, error: `insert line: ${insErr.message}` };
  }

  return { invoiceId: target.id };
}