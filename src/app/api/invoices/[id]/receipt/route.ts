import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { computeTotal, formatMoney } from "@/lib/money";
import { sendInvoiceReceiptEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// Send a payment receipt email to the customer for a PAID invoice. Used for
// offline payments (cash/check) the office recorded by marking the invoice
// paid — online (Stripe) payments get Stripe's own receipt, so this route is
// the manual path the office triggers from the invoice detail "Send receipt"
// button. Auth mirrors /api/invoices/[id]/send: the signed-in user must be
// office/admin/project_manager OR the owning customer. The session client
// gates that; the service role then reads line items + customer + org and
// recomputes totals (never trust a client amount) and mints a share_token if
// none exists so the receipt links to a viewable, paid invoice.
//
// A paid invoice is paid in full, so the receipt always shows amount paid =
// the invoice total and balance = $0.00 ("Paid in full"). We do NOT read the
// invoices.amount_paid column for the receipt amount, because the office
// "Mark Paid" action flips status without updating amount_paid — so that
// column can be stale (e.g. still just the deposit) on a manually-paid
// invoice. The total is the correct "paid" figure for a paid-in-full invoice.

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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Auth via the session client (RLS scopes the read to the caller's org or
  // own invoice — a row they can't see → 404, same as the send route).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, customer_id")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";

  const { data: visible } = await supabase
    .from("invoices")
    .select("id, customer_id")
    .eq("id", id)
    .maybeSingle();
  if (!visible) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  const isOfficeLike =
    role === "office" || role === "admin" || role === "project_manager";
  const isOwningCustomer =
    !!profile?.customer_id && profile.customer_id === visible.customer_id;
  if (!isOfficeLike && !isOwningCustomer) {
    return NextResponse.json(
      { error: "Not authorized to send a receipt for this invoice" },
      { status: 403 }
    );
  }

  // Service role: full invoice + customer + job + line items (recompute totals).
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: invoice } = await admin
    .from("invoices")
    .select(
      "id, status, organization_id, paid_at, share_token, jobs(name), customers(name, contact_email)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (invoice.status !== "paid") {
    return NextResponse.json(
      { error: "Receipts can only be sent for paid invoices" },
      { status: 400 }
    );
  }

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null }
    | null;
  const customerEmail = customer?.contact_email?.trim() || null;
  if (!customerEmail) {
    return NextResponse.json(
      { error: "No email on file for this customer — add one in Customers first." },
      { status: 400 }
    );
  }

  const jobName =
    (invoice.jobs as unknown as { name: string } | null)?.name ?? "your project";

  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", id);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );

  // Org name for branding (falls back to BRAND.company inside the email helper).
  let orgName = "";
  if (invoice.organization_id) {
    const { data: org } = await admin
      .from("organizations")
      .select("name")
      .eq("id", invoice.organization_id)
      .maybeSingle();
    if (org?.name) orgName = org.name;
  }

  // Mint a share_token only if none exists (re-sends keep the same link — same
  // semantics as deliverInvoice). Persist it so the receipt link stays valid.
  const token = invoice.share_token ?? crypto.randomUUID();
  const origin = requestOrigin(request);
  const invoiceUrl = `${origin}/invoices/view/${token}`;

  const paidAt = invoice.paid_at
    ? new Date(invoice.paid_at).toLocaleDateString()
    : null;

  const { error } = await sendInvoiceReceiptEmail({
    to: customerEmail,
    customerName: customer?.name ?? "",
    orgName,
    jobName,
    amountPaid: formatMoney(total), // paid in full → the total is the paid amount
    balanceDue: formatMoney(0), // a paid invoice has $0.00 balance → "Paid in full"
    paidAt,
    invoiceUrl,
  });

  if (error) {
    // Non-fatal: surface the provider message (e.g. "email not configured")
    // without a 500 so the office gets a clear toast instead of a hard error.
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
  }

  if (!invoice.share_token) {
    try {
      await admin.from("invoices").update({ share_token: token }).eq("id", id);
    } catch {
      // Token persist is best-effort — the email already went out.
    }
  }

  return NextResponse.json({ ok: true, sentTo: { email: customerEmail } });
}