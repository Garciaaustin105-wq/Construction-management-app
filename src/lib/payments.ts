// src/lib/payments.ts
// ----------------------------------------------------------------------------
// §1.5 Payment reversal — server-only contract. Soft-reverse: the original
// payment row is marked reversed (stays for audit), invoices.amount_paid is
// adjusted DOWN, and a `paid` invoice is re-opened to `sent` when the balance
// returns. All atomicity + the org/double-reversal/void guards live in the
// SECURITY DEFINER RPC `reverse_payment` (see reverse_payment.sql); this module
// just forwards the call from the office-gated route and normalizes the
// numeric-as-string columns PostgREST returns.
//
// Accounting sync is DEFERRED: the in-app ledger + invoice summary become
// correct immediately; pushing a correcting entry to QBO/Xero/FreshBooks is a
// follow-up (each provider has its own credit-note / void semantics).
//
// Security: this module uses the service-role admin client (the RPC has
// execute revoked from anon + authenticated, so only service_role can call
// it). The calling route is responsible for the office gate + passing the
// caller's org id + user id; the RPC re-checks org itself.

import { createAdminClient } from "@/lib/supabase/admin";

export type ReversePaymentResult =
  | {
      reversed: true;
      newAmountPaid: number;
      newStatus: string;
      newBalanceDue: number;
    }
  | { reversed: false; error: string };

// Reverse one recorded offline payment. `reason` must be a non-empty string
// (the route validates this before calling). Returns the post-reversal invoice
// summary so the route can hand it back to the UI without a re-read.
export async function reversePayment(args: {
  paymentId: string;
  orgId: string;
  reason: string;
  reversedBy: string;
}): Promise<ReversePaymentResult> {
  const { paymentId, orgId, reason, reversedBy } = args;
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("reverse_payment", {
    p_payment_id: paymentId,
    p_org_id: orgId,
    p_reason: reason,
    p_reversed_by: reversedBy,
  });

  if (error) {
    // The RPC raises: 'Payment not found' / 'Invoice not found' (404),
    // 'Payment already reversed' (409), 'Cannot reverse a payment on a void
    // invoice' (400/409). The route maps these to status codes; here we just
    // surface the message.
    return { reversed: false, error: error.message };
  }

  // RPC returns one row: { new_amount_paid, new_status, new_balance_due }.
  // PostgREST returns numerics as strings — normalize to numbers.
  const row = (
    (data as unknown as Array<{
      new_amount_paid: number | string;
      new_status: string;
      new_balance_due: number | string;
    }> | null) ?? []
  )[0];
  if (!row) {
    return { reversed: false, error: "Reversal returned no result" };
  }

  return {
    reversed: true,
    newAmountPaid: Number(row.new_amount_paid) || 0,
    newStatus: row.new_status,
    newBalanceDue: Number(row.new_balance_due) || 0,
  };
}