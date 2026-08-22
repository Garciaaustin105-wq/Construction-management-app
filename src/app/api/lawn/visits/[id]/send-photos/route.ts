import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import { resolveContact, buildPhotoLink } from "@/lib/customerNotifications";
import { sendCustomerEmail } from "@/lib/email";
import { sendCustomerSms } from "@/lib/sms";

export const dynamic = "force-dynamic";

// Crew/office hits "Send to customer" on a lawn visit → deliver a short note +
// a link to the visit's before/after photo portal (/v/{share_token}) to the
// job's customer. Unlike the automated milestone suite in
// customerNotifications.ts (fixed events, office-managed templates, one-shot
// notified_at gate), this is a manual, repeatable, ad-hoc send — no template,
// no gate — so it's built on the same primitives (resolveContact,
// sendCustomerEmail/Sms, notification_log) rather than through
// sendCustomerNotification. Logged under event "photo_share";
// notification_log.event is a free-text column (no CHECK constraint — see
// customer_notifications.sql), so no migration is needed to add this value.
//
// `via` selects the channel like the estimate Send flow: "email" (default),
// "sms", or "both". SMS is coded but inert until Twilio is configured —
// sendCustomerSms self-gates on TWILIO_* env and returns a non-fatal "not
// configured" error. The client hides Text/Both behind SMS_ENABLED
// (src/lib/smsFeature.ts); the server does not additionally need to trust that
// flag since sendCustomerSms is safe to call either way.
//
// Auth: office/PM may send for any visit in their org (RLS). Crew/superintendent
// may only send for a visit assigned directly to them (crew_id === caller),
// mirroring the visits/[id]/status route's ownership check exactly. The
// customer is always resolved server-side from the visit's job — never taken
// from the request body — so there is no way to target a customer who isn't
// actually attached to this job/visit.

type Channel = "email" | "sms" | "both";
type ChannelResult = {
  channel: "email" | "sms";
  status: "sent" | "failed" | "skipped";
  reason?: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let message: string | null = null;
  let via: Channel = "email";
  try {
    const body = await request.json();
    if (typeof body?.message === "string") {
      message = body.message.trim().slice(0, 480) || null;
    }
    if (body?.via === "email" || body?.via === "sms" || body?.via === "both") {
      via = body.via as Channel;
    }
  } catch {
    // No body / invalid JSON — defaults stand.
  }

  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const user = me.user;

  const role = (me.hasProfile ? me.role : null);
  const officeLike = !!role && OFFICE_OR_PM.has(role as never);
  const crewLike = role === "crew" || role === "superintendent";
  if (!officeLike && !crewLike) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { data: visitRow } = await supabase
    .from("lawn_visits")
    .select("id, job_id, organization_id, crew_id, share_token")
    .eq("id", id)
    .maybeSingle();
  const visit = visitRow as unknown as {
    id: string;
    job_id: string;
    organization_id: string | null;
    crew_id: string | null;
    share_token: string | null;
  } | null;
  if (!visit) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }
  // Mirrors the status route: a crew/superintendent caller may only act on a
  // visit assigned directly to them. Office/PM oversee every org visit.
  if (crewLike && visit.crew_id !== user.id) {
    return NextResponse.json({ error: "Not your visit" }, { status: 403 });
  }
  if (!visit.share_token) {
    return NextResponse.json(
      { error: "This visit has no photo-portal link yet — contact support." },
      { status: 500 }
    );
  }

  // Reads below run as the SERVICE ROLE (mirrors the status route's notify
  // block) so they succeed regardless of who is sending — a crew session
  // client may not be able to read the job/customer/org rows.
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: photoRow } = await admin
    .from("photos")
    .select("id")
    .eq("visit_id", id)
    .limit(1)
    .maybeSingle();
  if (!photoRow) {
    return NextResponse.json(
      { error: "No photos on this visit yet — add a photo first." },
      { status: 400 }
    );
  }

  const { data: job } = await admin
    .from("jobs")
    .select("customer_id, name, organization_id")
    .eq("id", visit.job_id)
    .maybeSingle();
  const jobRow = job as unknown as {
    customer_id: string | null;
    name: string | null;
    organization_id: string | null;
  } | null;
  const customerId = jobRow?.customer_id ?? null;
  const organizationId = visit.organization_id ?? jobRow?.organization_id ?? null;
  if (!customerId || !organizationId) {
    return NextResponse.json(
      { error: "No customer is linked to this job. Add one in Customers first." },
      { status: 400 }
    );
  }

  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  const orgName = (org as unknown as { name: string | null } | null)?.name ?? "";

  const contact = await resolveContact(admin, customerId);
  const photoLink = buildPhotoLink(visit.share_token);
  const jobName = jobRow?.name ?? "your property";

  const wantEmail = via === "email" || via === "both";
  const wantSms = via === "sms" || via === "both";

  const results: ChannelResult[] = [];

  async function logAttempt(
    channel: "email" | "sms",
    toContact: string | null,
    status: "sent" | "failed" | "skipped",
    error: string | null
  ) {
    try {
      await admin.from("notification_log").insert({
        organization_id: organizationId,
        event: "photo_share",
        channel,
        to_contact: toContact,
        entity_type: "visit",
        entity_id: id,
        status,
        error,
      });
    } catch {
      // Never let logging break the send path.
    }
  }

  if (wantEmail) {
    if (!contact.emailOptIn) {
      await logAttempt("email", contact.email, "skipped", "email opt-out");
      results.push({ channel: "email", status: "skipped", reason: "opt-out" });
    } else if (!contact.email) {
      await logAttempt("email", null, "skipped", "no email on file");
      results.push({ channel: "email", status: "skipped", reason: "no-contact" });
    } else {
      const noteLine = message ? `${message}\n\n` : "";
      const res = await sendCustomerEmail({
        to: contact.email,
        subject: `Photos from your lawn service — ${jobName}`,
        body: `${noteLine}View your photos: ${photoLink}`,
        orgName,
      });
      if (res.data) {
        results.push({ channel: "email", status: "sent" });
        await logAttempt("email", contact.email, "sent", null);
      } else {
        const err = res.error?.message ?? "email send failed";
        results.push({ channel: "email", status: "failed", reason: err });
        await logAttempt("email", contact.email, "failed", err);
      }
    }
  }

  if (wantSms) {
    if (!contact.smsOptIn) {
      await logAttempt("sms", contact.phone, "skipped", "sms opt-out");
      results.push({ channel: "sms", status: "skipped", reason: "opt-out" });
    } else if (!contact.phone) {
      await logAttempt("sms", null, "skipped", "no phone on file");
      results.push({ channel: "sms", status: "skipped", reason: "no-contact" });
    } else {
      const noteLine = message ? `${message} ` : "";
      const res = await sendCustomerSms({
        to: contact.phone,
        body: `${orgName}: ${noteLine}Photos: ${photoLink}`,
      });
      if (res.data) {
        results.push({ channel: "sms", status: "sent" });
        await logAttempt("sms", contact.phone, "sent", null);
      } else {
        const err = res.error?.message ?? "sms send failed";
        results.push({ channel: "sms", status: "failed", reason: err });
        await logAttempt("sms", contact.phone, "failed", err);
      }
    }
  }

  const sentVia = results
    .filter((r) => r.status === "sent")
    .map((r) => r.channel);

  return NextResponse.json({
    ok: sentVia.length > 0,
    sentVia,
    results,
  });
}
