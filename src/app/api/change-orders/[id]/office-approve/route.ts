import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { applyApprovedChangeOrderToInvoice } from "@/lib/changeOrderInvoice";

export const dynamic = "force-dynamic";

// Office/admin/PM manual approval of a change order "on behalf of a customer"
// — for in-person or check approvals where the customer never clicks the
// portal link. Calls the office_approve_change_order SECURITY DEFINER RPC (see
// the co_office_approval_attribution migration), which guards server-side: the
// caller must be office/admin/PM (tier_office_or_pm) AND same_org as the CO,
// and the CO must be status='sent'. It stamps approved_by / approved_at /
// approval_method='manual_office' / approval_note and fires the same office
// feed notification the customer path does. The required note is the
// accountability record — it is what discourages casual approvals, which is the
// whole point of Issue 5.
//
// Mirrors /api/change-orders/[id]/decide (the customer path) in structure and
// guard-failure mapping. A crew/customer role, or an office user in another
// org, gets a 403 from the RPC guard — never a successful approve.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let note: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.note === "string") note = body.note;
  } catch {
    // No body / invalid JSON → 400 below.
  }
  // The note is required — it's the accountability record the user asked for.
  if (!note || !note.trim()) {
    return NextResponse.json(
      {
        error:
          "A note is required (e.g. 'paid by check #1234' or 'approved in person').",
      },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // The RPC enforces tier_office_or_pm + same_org + status='sent'. A non-office
  // caller or a wrong-org office caller gets a raised exception → mapped below.
  const { error } = await supabase.rpc("office_approve_change_order", {
    p_co_id: id,
    p_note: note.trim(),
  });
  if (error) {
    const msg = error.message ?? "Failed";
    if (/not found/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (/not authorized|only office|not awaiting action/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Issue 4: pull the approved CO onto the original estimate's invoice as a line
  // item (non-fatal — the RPC approval already succeeded). No-op for deposit-only
  // jobs, paid invoices, or COs already added.
  try {
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    await applyApprovedChangeOrderToInvoice(admin, id);
  } catch {
    // best-effort; never fail the approval over the invoice line
  }

  return NextResponse.json({ ok: true });
}