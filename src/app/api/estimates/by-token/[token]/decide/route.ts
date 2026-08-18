import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { deliverInvoice } from "@/lib/invoiceSend";
import { sendEstimateDecisionEmail } from "@/lib/email";
import { createInvoiceFromEstimate } from "@/lib/estimateInvoice";

export const dynamic = "force-dynamic";

// Frictionless customer decision — public (no auth); the share_token in the URL
// is the only credential. Mirrors the logged-in approve_estimate / reject_estimate
// RPCs but resolves the estimate by token. Service role because there is no user
// session. Guards: token must resolve + status must be 'sent' + (for approve)
// no existing invoice — so a draft, an already-decided estimate, or a double-
// click can't act twice.
//
// On APPROVE the invoice shape depends on the job type (matches the
// approve_estimate RPC):
//   • Lawn job          → approve ONLY (no invoice). Lawn is billed by monthly
//     cycle billing, so an invoice here would double-bill.
//   • Construction      → a DEPOSIT-ONLY invoice (one "Deposit to start work"
//     line for the deposit, amount_paid 0) when a deposit split is set, else a
//     full-total invoice (all line items + markup/contingency/tax summary
//     lines, amount_paid 0).
// After a construction invoice is created it's auto-delivered to the customer
// (email/SMS, whichever is on file) via deliverInvoice — non-fatal, so an
// unconfigured Resend/Twilio never fails the approval itself.

function requestOrigin(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  const host =
    xfhost ||
    request.headers.get("host") ||
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return "localhost";
      }
    })();
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

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
    .select(
      "id, status, organization_id, job_id, customer_id, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, estimate_number, title, jobs(name, type), customers(name)"
    )
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

  // Resolve the org (office) to notify + display names, for the decision email.
  const customerRow = estimate.customers as unknown as { name: string | null } | null;
  const customerName = customerRow?.name ?? "";
  const jobName =
    (estimate.jobs as unknown as { name: string } | null)?.name ??
    (estimate.title as string | null) ??
    "your project";
  const estimateNumber = (estimate.estimate_number as string | null) ?? null;

  let orgName = "";
  let orgEmail: string | null = null;
  if (estimate.organization_id) {
    const { data: orgRow } = await admin
      .from("organizations")
      .select("name, email")
      .eq("id", estimate.organization_id)
      .maybeSingle();
    if (orgRow?.name) orgName = orgRow.name as string;
    orgEmail = (orgRow?.email as string | null)?.trim() || null;
  }

  const origin = requestOrigin(request);
  const estimateOfficeUrl = `${origin}/estimates/${estimate.id}`;

  // Notify the office that the customer acted. Non-fatal — never block the
  // decision; the estimate/invoice state change already succeeded by the time
  // this runs. A missing org email or unconfigured Resend is silently skipped.
  const notifyOffice = async (decision: "approved" | "rejected") => {
    if (!orgEmail) return;
    try {
      await sendEstimateDecisionEmail({
        to: orgEmail,
        orgName,
        customerName,
        jobName,
        estimateNumber,
        decision,
        estimateUrl: estimateOfficeUrl,
      });
    } catch {
      // Swallow — delivery is best-effort.
    }
  };

  // Record an in-app notification for the office feed on the dashboard. Service
  // role (bypasses RLS). Non-fatal — the estimate/invoice state change already
  // succeeded by the time this runs; a DB hiccup must never fail the decision.
  // The unique (type, entity_id) index makes a double-click a no-op.
  const recordNotification = async (
    type: "estimate_approved" | "estimate_rejected",
    title: string
  ) => {
    try {
      await admin.from("notifications").insert({
        organization_id: estimate.organization_id,
        type,
        title,
        body: [customerName, jobName].filter(Boolean).join(" · "),
        href: `/estimates/${estimate.id}`,
        entity_id: estimate.id,
      });
    } catch {
      // Swallow — feed is best-effort.
    }
  };

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
    await notifyOffice("rejected");
    await recordNotification("estimate_rejected", "Estimate declined");
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // approve — guard against an existing invoice (double-click / re-open).
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

  const jobType =
    (estimate.jobs as unknown as { type: string } | null)?.type ?? "construction";

  const markupPct = Number(estimate.markup_pct) || 0;
  const contingencyPct = Number(estimate.contingency_pct) || 0;
  const taxPct = Number(estimate.tax_pct) || 0;
  const depositPct = Number(estimate.deposit_pct) || 0;
  const depositAmount = Number(estimate.deposit_amount) || 0;

  const { data: items } = await admin
    .from("estimate_line_items")
    .select("description, quantity, unit_price, position")
    .eq("estimate_id", estimate.id)
    .order("position");

  // Lawn → approve only, no invoice (cycle billing handles lawn invoicing).
  if (jobType === "lawn") {
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
        { error: `Failed: ${eError.message}` },
        { status: 500 }
      );
    }
    await notifyOffice("approved");
    await recordNotification("estimate_approved", "Estimate approved");
    return NextResponse.json({ ok: true, status: "approved" });
  }

  // Construction → invoice via the shared helper (deposit-only or full-total +
  // summary lines). Mirrors approve_estimate; the same helper is used by the
  // authed proposal e-sign route so the invoice shape can never drift.
  const invoiceResult = await createInvoiceFromEstimate(admin, {
    estimateId: estimate.id,
    jobId: estimate.job_id,
    customerId: estimate.customer_id,
    markupPct,
    contingencyPct,
    taxPct,
    depositPct,
    depositAmount,
    items: (items ?? []) as {
      description: string | null;
      quantity: number | string | null;
      unit_price: number | string | null;
      position: number | string | null;
    }[],
  });
  if (invoiceResult.error) {
    return NextResponse.json({ error: invoiceResult.error }, { status: 500 });
  }
  const invoiceId = invoiceResult.invoiceId;
  if (!invoiceId) {
    return NextResponse.json(
      { error: "Invoice creation failed" },
      { status: 500 }
    );
  }

  // Flip the estimate to approved.
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

  // Auto-deliver the invoice to the customer (whichever channel is on file).
  // Non-fatal — a not-yet-configured Resend/Twilio records a warning but the
  // approval + invoice creation already succeeded; the invoice is re-sendable
  // manually from the invoice detail page once the provider is set up.
  try {
    await deliverInvoice(invoiceId, { origin });
  } catch {
    // Swallow — delivery is best-effort on this public path.
  }

  await notifyOffice("approved");
  await recordNotification("estimate_approved", "Estimate approved");
  return NextResponse.json({ ok: true, status: "approved" });
}