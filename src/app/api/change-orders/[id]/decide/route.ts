import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Authed-customer Approve/Reject for a change order awaiting their decision —
// the logged-in equivalent of the public /co/{token} decide route. Calls the
// decide_change_order SECURITY DEFINER RPC (see portal_messages.sql), which
// guards server-side: the caller must be a customer whose profiles.customer_id
// equals the CO's job's customer_id, same_org, and the CO must be status='sent'.
// On approve/reject it flips status + stamps approved_at/rejected_at and records
// the office feed notification (best-effort, deduped). No invoice is created
// (change orders don't auto-invoice; the office invoices the approved CO).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let decision: "approve" | "reject" | null = null;
  try {
    const body = await request.json();
    if (body?.decision === "approve" || body?.decision === "reject") {
      decision = body.decision;
    }
  } catch {
    // No body / invalid JSON → 400 below.
  }
  if (!decision) {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'reject'" },
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

  // The RPC enforces customer-ownership + same_org + status='sent'. A non-
  // customer or wrong-customer caller gets a raised exception → 403.
  const { error } = await supabase.rpc("decide_change_order", {
    p_co_id: id,
    p_decision: decision,
  });
  if (error) {
    // Map the guard failures to 403; anything else to 500.
    const msg = error.message ?? "Failed";
    const forbidden =
      /Not authorized|Only customer accounts|not awaiting action/i.test(msg);
    return NextResponse.json(
      { error: msg },
      { status: forbidden ? 403 : 500 }
    );
  }

  return NextResponse.json({ ok: true, decision });
}