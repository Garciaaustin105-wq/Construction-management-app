import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sendEstimateEmail } from "@/lib/email";
import { sendEstimateSms, normalizePhoneToE164 } from "@/lib/sms";
import { loadEstimateForEmail } from "@/lib/emailLoaders";

export const dynamic = "force-dynamic";

// Office hits Send → deliver the estimate to the customer and mark it sent.
// `via` selects the channel: "email" (default), "sms", or "both". Email goes
// through Resend; SMS goes through Twilio (needs TWILIO_* env vars — until
// then it returns a "not configured" error without blocking email). The
// estimate is marked sent + token stored iff at least one attempted channel
// delivered, preserving "sent means delivered" semantics. For "both", a
// partial failure (e.g. email fails because Resend isn't verified yet while
// the text goes out) still marks sent and reports the failed channel as a
// warning. The caller must be office/admin (user-scoped client, RLS scopes
// the read to the caller's org); the service role is used only for the
// delivery + the status/token write.
//
// Row load + field mapping live in src/lib/emailLoaders.ts (loadEstimateForEmail)
// and are SHARED with the /admin/email-preview "preview with real data" feature
// so a preview is guaranteed to match what ships. This route keeps all
// validation + the token mint/persist + the status write.

type Channel = "email" | "sms" | "both";

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

  // Optional personal note (email only — an SMS is too short to carry it) +
  // the delivery channel (defaults to email so the existing UX is unchanged).
  let message: string | null = null;
  let via: Channel = "email";
  try {
    const body = await request.json();
    if (typeof body?.message === "string") message = body.message;
    if (
      body?.via === "email" ||
      body?.via === "sms" ||
      body?.via === "both"
    ) {
      via = body.via as Channel;
    }
  } catch {
    // No body / invalid JSON is fine — message stays null, via stays "email".
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

  const loaded = await loadEstimateForEmail(supabase, id);
  if (!loaded) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
  }

  if (loaded.status !== "draft" && loaded.status !== "sent") {
    return NextResponse.json(
      { error: `This estimate is already ${loaded.status}` },
      { status: 400 }
    );
  }

  if (!loaded.customerId) {
    return NextResponse.json(
      { error: "No customer is linked to this estimate. Add one in Customers first." },
      { status: 400 }
    );
  }

  const wantEmail = via === "email" || via === "both";
  const wantSms = via === "sms" || via === "both";

  if (wantEmail && !loaded.to) {
    return NextResponse.json(
      { error: "Customer has no email on file — add one in Customers first (or send via Text)." },
      { status: 400 }
    );
  }
  if (wantSms && !loaded.customerPhone) {
    return NextResponse.json(
      { error: "Customer has no phone on file — add one in Customers first (or send via Email)." },
      { status: 400 }
    );
  }

  // Fresh token each send (rotates — old links stop working). Built before
  // delivery so both the email + the SMS can carry the same /q/{token} URL.
  const token = crypto.randomUUID();
  const host = requestHost(request);
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const estimateUrl = `${scheme}://${host}/q/${token}`;

  // Deliver each requested channel, collecting results. A channel "succeeds"
  // when its provider returns data (no error). We mark sent iff at least one
  // succeeded; failures become warnings (for "both") or the returned error
  // (for a single-channel send where nothing delivered).
  const sentVia: ("email" | "sms")[] = [];
  const warnings: { channel: "email" | "sms"; message: string }[] = [];
  let firstError: string | null = null;

  if (wantEmail) {
    try {
      const { error } = await sendEstimateEmail({
        to: loaded.to!,
        customerName: loaded.customerName,
        orgName: loaded.orgName,
        jobName: loaded.jobName,
        estimateNumber: loaded.estimateNumber,
        total: loaded.total,
        validUntil: loaded.validUntil,
        estimateUrl,
        message,
      });
      if (error) {
        const msg = `Email failed: ${error.message}`;
        warnings.push({ channel: "email", message: msg });
        if (firstError === null) firstError = msg;
      } else {
        sentVia.push("email");
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Email failed to send. Check RESEND_API_KEY / RESEND_FROM.";
      warnings.push({ channel: "email", message: msg });
      if (firstError === null) firstError = msg;
    }
  }

  if (wantSms) {
    const e164 = normalizePhoneToE164(loaded.customerPhone!);
    if (!e164) {
      const msg =
        "Text failed: the customer's phone isn't a valid US mobile number.";
      warnings.push({ channel: "sms", message: msg });
      if (firstError === null) firstError = msg;
    } else {
      const { error } = await sendEstimateSms({
        to: e164,
        orgName: loaded.orgName,
        jobName: loaded.jobName,
        total: loaded.total,
        estimateUrl,
      });
      if (error) {
        warnings.push({ channel: "sms", message: `Text failed: ${error.message}` });
        if (firstError === null) firstError = `Text failed: ${error.message}`;
      } else {
        sentVia.push("sms");
      }
    }
  }

  // Nothing delivered → don't mark sent; return the first failure.
  if (sentVia.length === 0) {
    return NextResponse.json(
      { error: firstError ?? "Send failed — no channel delivered." },
      { status: 502 }
    );
  }

  // At least one channel delivered → mark sent + persist the token (service
  // role so it always applies, regardless of RLS).
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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
        error: `Delivered via ${sentVia.join(" + ")}, but failed to mark the estimate sent: ${updateError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    sentVia,
    sentTo: {
      email: sentVia.includes("email") ? loaded.to : undefined,
      phone: sentVia.includes("sms") ? loaded.customerPhone : undefined,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}