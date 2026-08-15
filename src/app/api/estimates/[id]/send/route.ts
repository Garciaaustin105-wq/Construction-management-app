import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { computeEstimateTotals, formatMoney } from "@/lib/money";
import { sendEstimateEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const requestHost = (request: Request): string => {
  const xfhost = request.headers.get("x-forwarded-host");
  if (xfhost) return xfhost;
  const hostHeader = request.headers.get("host");
  if (hostHeader) return hostHeader;
  try {
    return new URL(request.url).host;
  } catch {
    return "localhost";
  }
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Optional personal note from the office, shown at the top of the email.
  let message: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.message === "string") message = body.message;
  } catch {
    // No body / invalid JSON is fine — message stays null.
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "office" && profile?.role !== "admin") {
    return NextResponse.json({ error: "Office only" }, { status: 403 });
  }

  // Estimate + customer email + job name (RLS scopes to caller org).
  const { data: estimate } = await supabase
    .from("estimates")
    .select(
      "id, status, customer_id, organization_id, valid_until, estimate_number, title, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, jobs(name, address), customers(name, contact_email)"
    )
    .eq("id", id)
    .maybeSingle();

  if (!estimate) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
  }

  if (estimate.status !== "draft" && estimate.status !== "sent") {
    return NextResponse.json(
      { error: `This estimate is already ${estimate.status}` },
      { status: 400 }
    );
  }

  const customer = estimate.customers as unknown as
    | { name: string | null; contact_email: string | null }
    | null;
  const jobName =
    (estimate.jobs as unknown as { name: string } | null)?.name ??
    (estimate.title as string | null) ??
    "your project";
  const customerEmail = customer?.contact_email?.trim() || null;
  const estimateNumber = estimate.estimate_number ?? null;

  if (!estimate.customer_id) {
    return NextResponse.json(
      { error: "No customer is linked to this estimate. Add one in Customers first." },
      { status: 400 }
    );
  }
  if (!customerEmail) {
    return NextResponse.json(
      { error: "Customer has no email on file — add one in Customers first." },
      { status: 400 }
    );
  }

  // Line items → grand total (incl. markup/contingency/tax) for the email.
  const { data: lineItems } = await supabase
    .from("estimate_line_items")
    .select("quantity, unit_price")
    .eq("estimate_id", id);
  const totals = computeEstimateTotals(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    })),
    {
      markupPct: Number(estimate.markup_pct) || 0,
      contingencyPct: Number(estimate.contingency_pct) || 0,
      taxPct: Number(estimate.tax_pct) || 0,
      depositPct: Number(estimate.deposit_pct) || 0,
      depositAmount: Number(estimate.deposit_amount) || 0,
    }
  );
  const hasPricing =
    totals.markupAmount > 0 ||
    totals.contingencyAmount > 0 ||
    totals.taxAmount > 0 ||
    totals.depositAmount > 0;
  const total = formatMoney(hasPricing ? totals.grandTotal : totals.subtotal);

  // Org name for branding.
  let orgName = "Terra Vista Construction";
  if (estimate.organization_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", estimate.organization_id)
      .maybeSingle();
    if (org?.name) orgName = org.name;
  }

  const validUntil = estimate.valid_until
    ? new Date(`${estimate.valid_until}T00:00:00`).toLocaleDateString()
    : null;

  // Fresh token each send (rotates — old links stop working).
  const token = crypto.randomUUID();
  const host = requestHost(request);
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const estimateUrl = `${scheme}://${host}/q/${token}`;

  // Email first; only mark sent on success.
  try {
    const { error } = await sendEstimateEmail({
      to: customerEmail,
      customerName: customer?.name ?? "",
      orgName,
      jobName,
      estimateNumber,
      total,
      validUntil,
      estimateUrl,
      message,
    });
    if (error) {
      return NextResponse.json(
        { error: `Email failed: ${error.message}` },
        { status: 502 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Email failed to send. Check RESEND_API_KEY / RESEND_FROM.",
      },
      { status: 500 }
    );
  }

  // Mark sent + persist the token (service role so it always applies).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "Missing Supabase configuration." },
      { status: 500 }
    );
  }

  const admin = createAdminClient(
    supabaseUrl,
    supabaseKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { error: updateError } = await admin
    .from("estimates")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      share_token: token,
    })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json(
      {
        error: `Email sent to ${customerEmail}, but failed to mark the estimate sent: ${updateError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, sentTo: customerEmail });
}