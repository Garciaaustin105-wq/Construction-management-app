// Templated, opt-in customer notifications for the lawn visit lifecycle.
//
// Central sender for the four milestone events (visit_reminder, on_my_way,
// service_complete, review_request). Each event has an org-managed email + SMS
// template (notification_templates) with {{token}} bodies; this module renders
// the tokens, applies the gate chain (global enable → per-customer channel
// opt-in → template active), sends via the generic sendCustomerEmail /
// sendCustomerSms helpers, and writes one notification_log row per channel
// (sent | failed | skipped) so the office has a full audit.
//
// Auth/tenant notes:
// - The `supabase` client is passed in by the caller. The status / on-my-way
//   routes pass the RLS SESSION client (office/PM auth) — the notification_log
//   INSERT policy admits office_or_pm, so logging works WITHOUT the service
//   role key there. The morning remind cron passes the ADMIN client, which
//   bypasses RLS for both reads and log writes. Either way the same code path.
// - templates/settings are org-scoped root tables (app supplies
//   organization_id); the caller resolves org from the visit's job.
// - Never throws on a send failure — a Resend/Twilio outage logs status=failed
//   and returns; the caller decides whether that blocks (status route stamps
//   notified_at regardless, preserving the one-shot UX).

import type { SupabaseClient } from "@supabase/supabase-js";
import { publicBaseUrl } from "@/lib/invoiceSend";
import { sendCustomerEmail } from "@/lib/email";
import { sendCustomerSms, normalizePhoneToE164 } from "@/lib/sms";

export type NotificationEvent =
  | "visit_reminder"
  | "on_my_way"
  | "service_complete"
  | "review_request";

export type NotificationChannel = "email" | "sms";

const CHANNELS: NotificationChannel[] = ["email", "sms"];

// Matches {{token}}, {{ token }}, {{token_1}}. Unknown keys resolve to "" so a
// missing value never leaks the raw placeholder into a customer-facing message.
const TOKEN_RE = /\{\{\s*([a-z_0-9]+)\s*\}\}/g;

export function renderTemplate(
  body: string,
  vars: Record<string, string>
): string {
  return body.replace(TOKEN_RE, (_, key: string) => vars[key] ?? "");
}

// Active template for an event×channel, or null when inactive/missing. The
// seeded defaults ARE the fallback — there is no hard-coded body here, so the
// office fully owns wording. A null return means "skip this channel".
export async function getTemplate(
  supabase: SupabaseClient,
  organizationId: string,
  event: NotificationEvent,
  channel: NotificationChannel
): Promise<{ subject: string | null; body: string } | null> {
  const { data } = await supabase
    .from("notification_templates")
    .select("subject, body, active")
    .eq("organization_id", organizationId)
    .eq("event", event)
    .eq("channel", channel)
    .maybeSingle();
  const t = data as
    | { subject: string | null; body: string; active: boolean }
    | null;
  if (!t || !t.active) return null;
  return { subject: t.subject ?? null, body: t.body };
}

// Per-org notification_settings row (or null when none yet — treated as
// disabled, since enabled defaults false).
async function getSettings(
  supabase: SupabaseClient,
  organizationId: string
): Promise<{ enabled: boolean; google_review_url: string | null } | null> {
  const { data } = await supabase
    .from("notification_settings")
    .select("enabled, google_review_url")
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as
    | { enabled: boolean; google_review_url: string | null }
    | null) ?? null;
}

export type ResolvedContact = {
  email: string | null;
  phone: string | null; // E.164, or null when unnormalizable
  name: string | null;
  emailOptIn: boolean;
  smsOptIn: boolean;
};

// customer.contact_email → portal profiles.email fallback (mirrors the status
// route's resolution). Phone normalized to E.164 here. Opt-in flags included
// so the gate is evaluated in one place.
export async function resolveContact(
  supabase: SupabaseClient,
  customerId: string
): Promise<ResolvedContact> {
  const { data } = await supabase
    .from("customers")
    .select("contact_email, phone, name, email_opt_in, sms_opt_in")
    .eq("id", customerId)
    .maybeSingle();
  const c = data as
    | {
        contact_email: string | null;
        phone: string | null;
        name: string | null;
        email_opt_in: boolean | null;
        sms_opt_in: boolean | null;
      }
    | null;

  const name = c?.name ?? null;
  const emailOptIn = c?.email_opt_in ?? true; // default ON per SQL
  const smsOptIn = c?.sms_opt_in ?? false; // default OFF per SQL
  let email = c?.contact_email?.trim() || null;

  if (!email) {
    const { data: portal } = await supabase
      .from("profiles")
      .select("email")
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    const p = portal as { email: string | null } | null;
    email = p?.email?.trim() || null;
  }

  const phone = c?.phone ? normalizePhoneToE164(c.phone) : null;

  return { email, phone, name, emailOptIn, smsOptIn };
}

export function buildPhotoLink(shareToken: string | null): string {
  if (!shareToken) return "";
  return `${publicBaseUrl()}/v/${shareToken}`;
}

// review_request links to the org's configured Google review URL; returns null
// when none is set (the template's {{review_link}} token then renders empty).
export async function buildReviewLink(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const settings = await getSettings(supabase, organizationId);
  return settings?.google_review_url?.trim() || null;
}

async function logAttempt(
  supabase: SupabaseClient,
  organizationId: string,
  event: NotificationEvent,
  channel: NotificationChannel,
  toContact: string | null,
  visitId: string,
  status: "sent" | "failed" | "skipped",
  error: string | null
): Promise<void> {
  // Non-throwing — a log write failure must never break the send path.
  try {
    await supabase.from("notification_log").insert({
      organization_id: organizationId,
      event,
      channel,
      to_contact: toContact ?? null,
      entity_type: "visit",
      entity_id: visitId,
      status,
      error,
    });
  } catch {
    // Swallow.
  }
}

export type ChannelResult = {
  channel: NotificationChannel;
  status: "sent" | "failed" | "skipped";
  reason?: string;
};

export type SendCustomerNotificationInput = {
  supabase: SupabaseClient;
  event: NotificationEvent;
  organizationId: string;
  visitId: string;
  customerId: string;
  // Token-substitution context. All optional; missing values render empty.
  customerName?: string | null;
  jobName?: string | null;
  address?: string | null;
  serviceDate?: string | null;
  orgName?: string | null;
  // service_complete links the customer to the before/after photo portal.
  photoLink?: string | null;
  // review_request links to the Google review URL (resolved here when omitted).
  reviewLink?: string | null;
  // Optional Google Static Maps property image for the EMAIL (built by the
  // caller from the job's lawn_jobs pin via buildStaticMapUrl). Email-only —
  // SMS has no image. Omitted when null (no pin / GOOGLE_MAPS_STATIC_KEY unset).
  mapImageUrl?: string | null;
};

// Send one event to the visit's customer across both channels, gated + logged.
// Returns the per-channel outcomes. Never throws.
export async function sendCustomerNotification(
  input: SendCustomerNotificationInput
): Promise<ChannelResult[]> {
  const { supabase, event, organizationId, visitId, customerId } = input;
  const results: ChannelResult[] = [];

  const settings = await getSettings(supabase, organizationId);
  if (!settings || !settings.enabled) {
    // Globally disabled — log both channels as skipped so the office sees the
    // event was considered. (Only fires on real triggers: done / on-my-way /
    // once-daily cron — low volume.)
    for (const channel of CHANNELS) {
      await logAttempt(
        supabase,
        organizationId,
        event,
        channel,
        null,
        visitId,
        "skipped",
        "notifications disabled"
      );
      results.push({ channel, status: "skipped", reason: "disabled" });
    }
    return results;
  }

  const contact = await resolveContact(supabase, customerId);

  // review_link resolved from settings when the caller didn't supply one
  // (review_request is the only event that uses it; others pass nothing).
  const reviewLink =
    input.reviewLink !== undefined
      ? input.reviewLink
      : await buildReviewLink(supabase, organizationId);

  const vars: Record<string, string> = {
    customer_name: input.customerName ?? contact.name ?? "",
    job_name: input.jobName ?? "",
    address: input.address ?? "",
    service_date: input.serviceDate ?? "",
    org_name: input.orgName ?? "",
    photo_link: input.photoLink ?? "",
    review_link: reviewLink ?? "",
  };

  for (const channel of CHANNELS) {
    // ── Gate chain (any failure → skip + log, continue to next channel) ──
    const optIn = channel === "email" ? contact.emailOptIn : contact.smsOptIn;
    if (!optIn) {
      await logAttempt(
        supabase,
        organizationId,
        event,
        channel,
        channel === "email" ? contact.email : contact.phone,
        visitId,
        "skipped",
        `${channel} opt-out`
      );
      results.push({ channel, status: "skipped", reason: "opt-out" });
      continue;
    }

    const dest = channel === "email" ? contact.email : contact.phone;
    if (!dest) {
      await logAttempt(
        supabase,
        organizationId,
        event,
        channel,
        null,
        visitId,
        "skipped",
        `no ${channel} contact`
      );
      results.push({ channel, status: "skipped", reason: "no-contact" });
      continue;
    }

    const template = await getTemplate(supabase, organizationId, event, channel);
    if (!template) {
      await logAttempt(
        supabase,
        organizationId,
        event,
        channel,
        dest,
        visitId,
        "skipped",
        "no active template"
      );
      results.push({ channel, status: "skipped", reason: "no-template" });
      continue;
    }

    const body = renderTemplate(template.body, vars);

    // ── Send (non-fatal: env gates return {error} for unconfigured channels) ──
    let status: "sent" | "failed" = "failed";
    let errMsg: string | null = null;
    if (channel === "email") {
      const res = await sendCustomerEmail({
        to: dest,
        subject: template.subject ?? `${event}`,
        body,
        orgName: input.orgName,
        mapImageUrl: input.mapImageUrl,
      });
      if (res.data) status = "sent";
      else errMsg = res.error?.message ?? "email send failed";
    } else {
      const res = await sendCustomerSms({ to: dest, body });
      if (res.data) status = "sent";
      else errMsg = res.error?.message ?? "sms send failed";
    }

    await logAttempt(
      supabase,
      organizationId,
      event,
      channel,
      dest,
      visitId,
      status,
      errMsg
    );
    results.push({
      channel,
      status,
      reason: status === "failed" ? errMsg ?? undefined : undefined,
    });
  }

  return results;
}

// Convenience: did at least one channel actually deliver (used by routes to
// decide the notified flag)? Skipped/failed-only counts as not notified.
export function anySent(results: ChannelResult[]): boolean {
  return results.some((r) => r.status === "sent");
}