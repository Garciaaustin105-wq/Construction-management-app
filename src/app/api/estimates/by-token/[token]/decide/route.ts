import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { deliverInvoice } from "@/lib/invoiceSend";
import { sendEstimateDecisionEmail } from "@/lib/email";

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

  // Round to cents, half away from zero (matches Postgres round(numeric, 2)).
  const round2 = (n: number) =>
    (Math.round(Math.abs(n) * 100) / 100) * (n < 0 ? -1 : 1);

  const markupPct = Number(estimate.markup_pct) || 0;
  const contingencyPct = Number(estimate.contingency_pct) || 0;
  const taxPct = Number(estimate.tax_pct) || 0;
  const depositPct = Number(estimate.deposit_pct) || 0;
  const depositAmt = Number(estimate.deposit_amount) || 0;

  const { data: items } = await admin
    .from("estimate_line_items")
    .select("description, quantity, unit_price, position")
    .eq("estimate_id", estimate.id)
    .order("position");
  const subtotal = (items ?? []).reduce(
    (s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0),
    0
  );
  const markupAmt = markupPct > 0 ? round2((subtotal * markupPct) / 100) : 0;
  const contAmt = contingencyPct > 0 ? round2((subtotal * contingencyPct) / 100) : 0;
  const preTax = round2(subtotal + markupAmt + contAmt);
  const taxAmt = taxPct > 0 ? round2((preTax * taxPct) / 100) : 0;
  const grandTotal = round2(preTax + taxAmt);
  const deposit =
    depositAmt > 0
      ? round2(depositAmt)
      : depositPct > 0
      ? round2((grandTotal * depositPct) / 100)
      : 0;

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
    return NextResponse.json({ ok: true, status: "approved" });
  }

  // Construction → deposit-only (or full-total when no deposit split) invoice,
  // amount_paid 0 (the deposit is now owed, not pre-paid).
  const { data: invoice, error: invError } = await admin
    .from("invoices")
    .insert({
      estimate_id: estimate.id,
      job_id: estimate.job_id,
      customer_id: estimate.customer_id,
      status: "sent",
      amount_paid: 0,
    })
    .select("id")
    .single();
  if (invError || !invoice) {
    return NextResponse.json(
      { error: `Failed to create invoice: ${invError?.message ?? "error"}` },
      { status: 500 }
    );
  }

  if (deposit > 0) {
    // Single deposit line — the invoice total IS the deposit to start work.
    const { error: lineError } = await admin
      .from("invoice_line_items")
      .insert({
        invoice_id: invoice.id,
        description: "Deposit to start work",
        quantity: 1,
        unit_price: deposit,
        position: 0,
      });
    if (lineError) {
      return NextResponse.json(
        { error: `Invoice created but deposit line failed: ${lineError.message}` },
        { status: 500 }
      );
    }
  } else {
    // No deposit split → full-total invoice: snapshot the line items.
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

    // Pricing-summary lines so the invoice total == estimate grand total.
    let pos = (items ?? []).reduce((m, i) => Math.max(m, Number(i.position) || 0), 0);
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
        return NextResponse.json(
          { error: `Invoice created but summary lines failed: ${summaryError.message}` },
          { status: 500 }
        );
      }
    }
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
    await deliverInvoice(invoice.id, { origin });
  } catch {
    // Swallow — delivery is best-effort on this public path.
  }

  await notifyOffice("approved");
  return NextResponse.json({ ok: true, status: "approved" });
}