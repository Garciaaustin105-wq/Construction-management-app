import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sendInvoiceReceiptEmail } from "@/lib/email";
import { loadInvoiceReceiptForEmail } from "@/lib/emailLoaders";

export const dynamic = "force-dynamic";

// Send a payment receipt email to the customer for a PAID invoice. Used for
// offline payments (cash/check) the office recorded by marking the invoice
// paid — online (Stripe) payments get Stripe's own receipt, so this route is
// the manual path the office triggers from the invoice detail "Send receipt"
// button. Auth mirrors /api/invoices/[id]/send: the signed-in user must be
// office/admin/project_manager OR the owning customer. The session client
// gates that; the service role then loads the row (via loadInvoiceReceiptForEmail,
// shared with the email-preview "preview with real data" feature) and mints a
// share_token if none exists so the receipt links to a viewable, paid invoice.
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

  const loaded = await loadInvoiceReceiptForEmail(admin, id);
  if (!loaded) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (loaded.status !== "paid") {
    return NextResponse.json(
      { error: "Receipts can only be sent for paid invoices" },
      { status: 400 }
    );
  }
  if (!loaded.to) {
    return NextResponse.json(
      { error: "No email on file for this customer — add one in Customers first." },
      { status: 400 }
    );
  }

  // Mint a share_token only if none exists (re-sends keep the same link — same
  // semantics as deliverInvoice). Persist it so the receipt link stays valid.
  const token = loaded.shareToken ?? crypto.randomUUID();
  const origin = requestOrigin(request);
  const invoiceUrl = `${origin}/invoices/view/${token}`;

  const { error } = await sendInvoiceReceiptEmail({
    to: loaded.to,
    customerName: loaded.customerName,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    amountPaid: loaded.amountPaid, // paid in full → the total is the paid amount
    balanceDue: loaded.balanceDue, // a paid invoice has $0.00 balance → "Paid in full"
    paidAt: loaded.paidAt,
    invoiceUrl,
  });

  if (error) {
    // Non-fatal: surface the provider message (e.g. "email not configured")
    // without a 500 so the office gets a clear toast instead of a hard error.
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
  }

  if (!loaded.shareToken) {
    try {
      await admin.from("invoices").update({ share_token: token }).eq("id", id);
    } catch {
      // Token persist is best-effort — the email already went out.
    }
  }

  return NextResponse.json({ ok: true, sentTo: { email: loaded.to } });
}