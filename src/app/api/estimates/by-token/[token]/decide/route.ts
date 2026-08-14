import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Frictionless customer decision — public (no auth); the share_token in the URL
// is the only credential. Mirrors the logged-in approve_estimate / reject_estimate
// RPCs but resolves the estimate by token. Service role because there is no user
// session. Guards: token must resolve + status must be 'sent' + (for approve)
// no existing invoice — so a draft, an already-decided estimate, or a double-
// click can't act twice.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  let body: { decision?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'reject'" },
      { status: 400 }
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: estimate } = await admin
    .from("estimates")
    .select("id, status, job_id, customer_id")
    .eq("share_token", token)
    .maybeSingle();

  if (!estimate) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
  }
  if (estimate.status !== "sent") {
    return NextResponse.json(
      { error: "This estimate is not awaiting action." },
      { status: 400 }
    );
  }

  if (decision === "reject") {
    const { error } = await admin
      .from("estimates")
      .update({
        status: "rejected",
        rejected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", estimate.id);
    if (error) {
      return NextResponse.json(
        { error: `Failed: ${error.message}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // approve — mirror approve_estimate: guard against an existing invoice, create
  // the invoice (status 'sent'), snapshot the line items, then flip the
  // estimate. Snapshot selects only customer-safe columns (no cost_code_id).
  const { data: existing } = await admin
    .from("invoices")
    .select("id")
    .eq("estimate_id", estimate.id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "This estimate has already been approved." },
      { status: 400 }
    );
  }

  const { data: invoice, error: invError } = await admin
    .from("invoices")
    .insert({
      estimate_id: estimate.id,
      job_id: estimate.job_id,
      customer_id: estimate.customer_id,
      status: "sent",
    })
    .select("id")
    .single();
  if (invError || !invoice) {
    return NextResponse.json(
      { error: `Failed to create invoice: ${invError?.message ?? "error"}` },
      { status: 500 }
    );
  }

  const { data: items } = await admin
    .from("estimate_line_items")
    .select("description, quantity, unit_price, position")
    .eq("estimate_id", estimate.id)
    .order("position");
  if (items && items.length > 0) {
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
      return NextResponse.json(
        { error: `Invoice created but line items failed: ${linesError.message}` },
        { status: 500 }
      );
    }
  }

  const { error: eError } = await admin
    .from("estimates")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", estimate.id);
  if (eError) {
    return NextResponse.json(
      { error: `Invoice created but estimate status failed: ${eError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, status: "approved" });
}