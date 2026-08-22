import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sendChangeOrderEmail } from "@/lib/email";
import { loadChangeOrderForEmail } from "@/lib/emailLoaders";
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
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  if (!me.role || !OFFICE_OR_PM.has(me.role as never)) {
    return NextResponse.json({ error: "Office or PM only" }, { status: 403 });
  }

  // Change order + job name + the job's customer (email/name). Row load + field
  // mapping live in src/lib/emailLoaders.ts (loadChangeOrderForEmail) and are
  // SHARED with the /admin/email-preview "preview with real data" feature so a
  // preview matches what ships. RLS scopes the read to the caller's org.
  const loaded = await loadChangeOrderForEmail(supabase, id);

  if (!loaded) {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 });
  }

  if (loaded.status !== "draft" && loaded.status !== "submitted") {
    return NextResponse.json(
      { error: `This change order is already ${loaded.status}` },
      { status: 400 }
    );
  }

  const customerEmail = loaded.to;
  if (!customerEmail) {
    return NextResponse.json(
      { error: "The job's customer has no email on file — add one in Customers first." },
      { status: 400 }
    );
  }

  const token = crypto.randomUUID();
  const host = requestHost(request);
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const changeOrderUrl = `${scheme}://${host}/co/${token}`;

  const { error: emailError } = await sendChangeOrderEmail({
    to: customerEmail,
    customerName: loaded.customerName,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    coNumber: loaded.coNumber,
    title: loaded.title,
    amount: loaded.amount,
    isCredit: loaded.isCredit,
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