import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { computeTotal } from "@/lib/money";

// /api/invoices/[id]/payments — record + list offline (cash / check / other)
// payments against an invoice. The platform never touches customer money
// (Stripe = SaaS subs only); these rows record what the office received
// directly so the invoice's amount_paid / balance / paid status stay accurate.
//
// Gate: office / admin / project_manager (matches the InvoiceActions UI render
// gate at invoices/[id]/page.tsx — super_admin is intentionally EXCLUDED so the
// platform account can't mutate tenant financials, consistent with the
// super_admin read-only-org-identity lockdown). RLS (payments.sql
// office_payments_all = tier_office_or_pm(organization_id)) additionally
// enforces same-org on the actual write; a cross-org invoice id is unreadable
// (invoices RLS) so it 404s before any insert.
//
// amount_paid reconciliation (v1, ACCUMULATE — NOT a from-scratch recompute):
// invoices.amount_paid is seeded with the estimate deposit on approval (or 0
// for deposit-owed invoices), and the deposit is NOT a payment row. Recomputing
// sum(payments) would clobber the deposit and UNDERSTATE what the customer paid.
// So: new_amount_paid = invoices.amount_paid + payment.amount. Money-correct
// for both deposit flows; never touches existing rows. v1 is insert-only.
export const dynamic = "force-dynamic";

const ALLOWED_METHODS = new Set(["cash", "check", "other"]);

// Round to cents (matches Postgres numeric(12,2)). Avoids float drift on the
// paid/sent threshold comparison (e.g. 5000.00 vs 4999.9999999).
function round2(n: number): number {
  const neg = n < 0 ? -1 : 1;
  return (Math.round(Math.abs(n) * 100) / 100) * neg;
}

type InvoiceRow = {
  id: string;
  status: string;
  amount_paid: number | string | null;
  organization_id: string;
  jobs: { name: string | null } | null;
  customers: { name: string | null } | null;
};
type LineItemRow = { quantity: number | string; unit_price: number | string };

// Applies one payment to the invoice summary with optimistic concurrency: read
// amount_paid + status, compute the new totals, then write with
// .eq("amount_paid", <the value just read>) so the write only lands if nothing
// else changed amount_paid in between. If another concurrent payment won the
// race (0 rows matched), re-read and retry — each retry re-accumulates onto
// whatever amount_paid now is, so no payment is ever lost or double-counted.
// (invoices.amount_paid is `numeric(12,2) not null default 0` — never null —
// so a plain .eq comparison is safe without an `.is(null)` branch.)
async function applyPaymentToInvoice(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  paymentAmount: number,
  paidAtArg: string | null,
  total: number,
  now: string,
  maxAttempts = 5
): Promise<
  | { ok: true; newAmountPaid: number; newStatus: string; justPaid: boolean }
  | { ok: false; error: string }
> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: fresh, error: freshErr } = await supabase
      .from("invoices")
      .select("amount_paid, status")
      .eq("id", invoiceId)
      .maybeSingle();
    if (freshErr || !fresh)
      return {
        ok: false,
        error: freshErr?.message ?? "Invoice not found during update",
      };
    const priorAmountPaidRaw = (fresh as { amount_paid: number | string })
      .amount_paid;
    const priorStatus = (fresh as { status: string }).status;
    const currentAmountPaid = round2(Number(priorAmountPaidRaw ?? 0) || 0);
    const newAmountPaid = round2(currentAmountPaid + paymentAmount);
    const isPaid = total > 0 && newAmountPaid >= total;
    const newStatus = isPaid ? "paid" : "sent";
    const paidAt = isPaid ? paidAtArg ?? now : null;

    const { data: updated, error: updErr } = await supabase
      .from("invoices")
      .update({
        amount_paid: newAmountPaid,
        status: newStatus,
        paid_at: paidAt,
        updated_at: now,
      })
      .eq("id", invoiceId)
      .eq("amount_paid", priorAmountPaidRaw)
      .select("id")
      .maybeSingle();

    if (updErr) return { ok: false, error: updErr.message };
    if (updated)
      return {
        ok: true,
        newAmountPaid,
        newStatus,
        justPaid: isPaid && priorStatus !== "paid",
      };
    // else: amount_paid changed under us since the read above (a concurrent
    // payment landed first) — loop and retry against the fresh value.
  }
  return {
    ok: false,
    error:
      "Concurrent payments on this invoice — could not update the summary after several attempts. Refresh and verify amount_paid.",
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (role !== "office" && role !== "admin" && role !== "project_manager")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: {
    amount?: number | string;
    method?: string;
    reference?: string | null;
    paid_at?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const amount = Number(body.amount);
  const method = body.method?.trim().toLowerCase();
  const reference = body.reference?.trim() || null;
  const paidAtArg = body.paid_at?.trim() || null;

  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  if (!method || !ALLOWED_METHODS.has(method))
    return NextResponse.json(
      { error: "method must be cash, check, or other" },
      { status: 400 }
    );

  // Fetch the invoice (RLS scopes to the caller's org; cross-org 404s here).
  const { data: invoiceData, error: invErr } = await supabase
    .from("invoices")
    .select(
      "id, status, amount_paid, organization_id, jobs(name), customers(name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (invErr || !invoiceData)
    return NextResponse.json(
      { error: "Invoice not found" },
      { status: 404 }
    );
  const invoice = invoiceData as unknown as InvoiceRow;

  if (invoice.status === "void")
    return NextResponse.json(
      { error: "Can't record a payment on a voided invoice" },
      { status: 400 }
    );

  // Line items → grand total (mirrors invoices/[id]/page.tsx + money.ts).
  const { data: lineItemsData } = await supabase
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", id);
  const items = (lineItemsData as unknown as LineItemRow[] | null) ?? [];
  const total = round2(
    computeTotal(
      items.map((i) => ({
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
      }))
    )
  );

  // Insert the payment row first (the source-of-truth record). organization_id
  // is stamped from the invoice so RLS + the org index work.
  const now = new Date().toISOString();
  const { error: payErr } = await supabase.from("payments").insert({
    organization_id: invoice.organization_id,
    invoice_id: id,
    amount: round2(amount),
    method,
    reference,
    paid_at: paidAtArg ?? now,
    recorded_by: user.id,
  });
  if (payErr)
    return NextResponse.json(
      { error: `Failed to record payment: ${payErr.message}` },
      { status: 500 }
    );

  // Then update the invoice summary (ACCUMULATE onto whatever amount_paid is
  // — never recompute from sum(payments), which would clobber a seeded
  // deposit). Optimistic-concurrency retry loop: see applyPaymentToInvoice.
  // If this ultimately fails the payment row still exists (the truth); the
  // office can refresh / re-record. v1 accepts this narrow window.
  const result = await applyPaymentToInvoice(
    supabase,
    id,
    amount,
    paidAtArg,
    total,
    now
  );
  if (!result.ok)
    return NextResponse.json(
      {
        error: `Payment recorded, but invoice summary failed to update: ${result.error}`,
      },
      { status: 500 }
    );

  // Fire the invoice_paid notification the first time this invoice crosses
  // into "paid" (not on every later overpayment). Service-role client — the
  // notifications table has no INSERT policy for authenticated roles (see
  // notifications.sql). Non-fatal: the payment + invoice update already
  // succeeded by the time this runs. The unique (type, entity_id) index makes
  // a duplicate/racing insert a no-op even if two requests both see justPaid.
  if (result.justPaid) {
    try {
      const admin = createAdminClient();
      const customerName = invoice.customers?.name ?? "";
      const jobName = invoice.jobs?.name ?? "";
      await admin.from("notifications").insert({
        organization_id: invoice.organization_id,
        type: "invoice_paid",
        title: "Invoice paid",
        body: [customerName, jobName].filter(Boolean).join(" · "),
        href: `/invoices/${id}`,
        entity_id: id,
      });
    } catch {
      // best-effort
    }
  }

  return NextResponse.json({
    ok: true,
    amount_paid: result.newAmountPaid,
    status: result.newStatus,
    balance_due: Math.max(0, round2(total - result.newAmountPaid)),
  });
}

// GET — list an invoice's recorded payments (office / customer / accountant
// per payments.sql RLS). Used to render the Payments section on the invoice
// page (the server page reads directly; this route is for client refresh + the
// public/customer view if needed).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, amount, method, reference, paid_at, recorded_by, created_at, profiles(full_name)"
    )
    .eq("invoice_id", id)
    .order("paid_at", { ascending: false })
    .order("created_at", { ascending: false });

  if (error)
    return NextResponse.json(
      { error: `Failed to load payments: ${error.message}` },
      { status: 500 }
    );

  const rows = ((data as unknown as Array<{
    id: string;
    amount: number | string;
    method: string;
    reference: string | null;
    paid_at: string;
    recorded_by: string | null;
    created_at: string;
    profiles: { full_name: string | null } | null;
  }> | null) ?? []).map((r) => ({
    id: r.id,
    amount: Number(r.amount) || 0,
    method: r.method,
    reference: r.reference,
    paid_at: r.paid_at,
    recorded_by_name: r.profiles?.full_name ?? null,
    created_at: r.created_at,
  }));

  return NextResponse.json({ payments: rows });
}