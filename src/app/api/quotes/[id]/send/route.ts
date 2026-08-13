import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { computeTotal, formatMoney } from "@/lib/money";
import { sendQuoteEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// Office hits Send → email the customer a frictionless /q/{token} link and
// mark the quote sent. Email is sent FIRST; the quote is only marked sent +
// token stored if the email succeeds (so "sent" always means "delivered").
// The caller must be office/admin (user-scoped client, RLS scopes the read to
// the caller's org); the service role is used only for the email + the
// status/token write.

function requestHost(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  if (xfhost) return xfhost;
  const hostHeader = request.headers.get("host");
  if (hostHeader) return hostHeader;
  try {
    return new URL(request.url).host;
  } catch {
    return "localhost";
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  // Quote + customer email + job name (RLS scopes to caller org).
  const { data: quote } = await supabase
    .from("quotes")
    .select(
      "id, status, customer_id, organization_id, valid_until, jobs(name), customers(name, contact_email)"
    )
    .eq("id", id)
    .maybeSingle();

  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (quote.status !== "draft" && quote.status !== "sent") {
    return NextResponse.json(
      { error: `This quote is already ${quote.status}` },
      { status: 400 }
    );
  }

  const customer = quote.customers as unknown as
    | { name: string | null; contact_email: string | null }
    | null;
  const jobName = (quote.jobs as unknown as { name: string } | null)?.name ?? "your project";
  const customerEmail = customer?.contact_email?.trim() || null;

  if (!quote.customer_id) {
    return NextResponse.json(
      { error: "No customer is linked to this job. Add one in Customers first." },
      { status: 400 }
    );
  }
  if (!customerEmail) {
    return NextResponse.json(
      { error: "Customer has no email on file — add one in Customers first." },
      { status: 400 }
    );
  }

  // Line items → total for the email summary.
  const { data: lineItems } = await supabase
    .from("quote_line_items")
    .select("quantity, unit_price")
    .eq("quote_id", id);
  const total = formatMoney(
    computeTotal(
      (lineItems ?? []).map((i) => ({
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
      }))
    )
  );

  // Org name for branding.
  let orgName = "Terra Vista Construction";
  if (quote.organization_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", quote.organization_id)
      .maybeSingle();
    if (org?.name) orgName = org.name;
  }

  const validUntil = quote.valid_until
    ? new Date(`${quote.valid_until}T00:00:00`).toLocaleDateString()
    : null;

  // Fresh token each send (rotates — old links stop working).
  const token = crypto.randomUUID();
  const host = requestHost(request);
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const quoteUrl = `${scheme}://${host}/q/${token}`;

  // Email first; only mark sent on success.
  try {
    const { error } = await sendQuoteEmail({
      to: customerEmail,
      customerName: customer?.name ?? "",
      orgName,
      jobName,
      total,
      validUntil,
      quoteUrl,
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
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { error: updateError } = await admin
    .from("quotes")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      share_token: token,
    })
    .eq("id", id);

  if (updateError) {
    // Email went out but we couldn't record it — surface so office knows.
    return NextResponse.json(
      {
        error: `Email sent to ${customerEmail}, but failed to mark the quote sent: ${updateError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, sentTo: customerEmail });
}