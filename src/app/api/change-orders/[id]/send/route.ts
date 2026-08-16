import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { formatMoney } from "@/lib/money";
import { sendChangeOrderEmail } from "@/lib/email";
import { OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office/PM hits Send → deliver the change order to the customer (job owner)
// and mark it sent. Mints a fresh share_token (rotates — old links stop working),
// flips status draft/submitted → sent, stamps sent_at, and emails a /co/{token}
// portal link to the customer's contact_email. Mirrors the estimate send route
// but email-only (no SMS in v1) and no pricing summary (the CO carries its own
// header amount + optional cost-coded lines). The caller must be office/admin/
// PM (user-scoped client, RLS scopes the read to the caller's org); the service
// role is used only for the delivery + the status/token write.
//
// "sent means delivered": if the email fails (e.g. Resend not configured / no
// customer email on file) the CO is NOT marked sent and the error is returned.

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
    .maybeSingle();
  if (!profile?.role || !OFFICE_OR_PM.has(profile.role as never)) {
    return NextResponse.json({ error: "Office or PM only" }, { status: 403 });
  }

  // Change order + job name + the job's customer (email/name). RLS scopes to
  // the caller's org (super_admin admitted via tier_office_or_pm).
  const { data: co } = await supabase
    .from("change_orders")
    .select(
      "id, status, organization_id, co_number, title, amount, is_credit, jobs(name, customers(name, contact_email))"
    )
    .eq("id", id)
    .maybeSingle();

  if (!co) {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 });
  }

  if (co.status !== "draft" && co.status !== "submitted") {
    return NextResponse.json(
      { error: `This change order is already ${co.status}` },
      { status: 400 }
    );
  }

  const jobRow = co.jobs as unknown as
    | { name: string | null; customers: { name: string | null; contact_email: string | null } | null }
    | null;
  const jobName = jobRow?.name ?? co.title ?? "your project";
  const customer = jobRow?.customers ?? null;
  const customerEmail = customer?.contact_email?.trim() || null;

  if (!customerEmail) {
    return NextResponse.json(
      { error: "The job's customer has no email on file — add one in Customers first." },
      { status: 400 }
    );
  }

  let orgName = "";
  if (co.organization_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", co.organization_id)
      .maybeSingle();
    if (org?.name) orgName = org.name;
  }

  const token = crypto.randomUUID();
  const host = requestHost(request);
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const changeOrderUrl = `${scheme}://${host}/co/${token}`;

  const { error: emailError } = await sendChangeOrderEmail({
    to: customerEmail,
    customerName: customer?.name ?? "",
    orgName,
    jobName,
    coNumber: co.co_number ?? null,
    title: co.title,
    amount: formatMoney(Number(co.amount) || 0),
    isCredit: !!co.is_credit,
    changeOrderUrl,
    message,
  });

  if (emailError) {
    return NextResponse.json(
      { error: `Email failed: ${emailError.message}. Check RESEND_API_KEY / RESEND_FROM.` },
      { status: 502 }
    );
  }

  // Delivered → mark sent + persist the token (service role so it always
  // applies, regardless of RLS).
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { error: updateError } = await admin
    .from("change_orders")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      share_token: token,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json(
      {
        error: `Email delivered, but failed to mark the change order sent: ${updateError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, sentTo: { email: customerEmail } });
}