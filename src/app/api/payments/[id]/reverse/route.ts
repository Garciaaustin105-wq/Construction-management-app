import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { reversePayment } from "@/lib/payments";

export const dynamic = "force-dynamic";

// POST /api/payments/[id]/reverse — §1.5 soft-reverse a recorded offline
// payment (cash / check / other). The original payment row is marked reversed
// (kept for audit), invoices.amount_paid is adjusted DOWN, and a `paid`
// invoice is re-opened to `sent` when the balance returns. All atomicity + the
// org / double-reversal / void guards live in the SECURITY DEFINER RPC
// `reverse_payment` (see reverse_payment.sql); this route just auths the
// caller, requires a reason, and forwards.
//
// Gate: office / admin / project_manager with an org. super_admin has no org
// (null orgId) so the `!orgId` clause blocks it — the platform account can't
// mutate tenant financials, consistent with the manual payments route.
// Accounting sync (pushing a correcting entry to QBO/Xero/FreshBooks) is a
// follow-up — the in-app ledger becomes correct here regardless.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // One cached identity read (shared with the root layout) — no extra RT.
  const tenant = await getMe();
  if (!tenant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can reverse payments" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason?.trim() ?? "";
  if (!reason) {
    return NextResponse.json(
      { error: "A reason is required to reverse a payment" },
      { status: 400 }
    );
  }

  const result = await reversePayment({
    paymentId: id,
    orgId: tenant.orgId,
    reason,
    reversedBy: tenant.user.id,
  });

  if (!result.reversed) {
    // RPC raises: 'Payment not found' / 'Invoice not found' → 404,
    // 'Payment already reversed' / 'Cannot reverse a payment on a void invoice'
    // → 409, anything else → 500.
    const status = /not found/i.test(result.error) ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    amount_paid: result.newAmountPaid,
    status: result.newStatus,
    balance_due: result.newBalanceDue,
  });
}