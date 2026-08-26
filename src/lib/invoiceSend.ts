// Invoice delivery (email + SMS) — server-only. The service role is used so
// this works identically from an HTTP route (office/customer) and from a
// server-only caller with no request (the lawn cycle-billing cron). Mirrors the
// estimate send flow but for invoices: mints a share_token (only if none) so the
// customer gets a frictionless /invoices/view/{token} link, delivers via
// whichever channel the customer has on file (or the channel the caller chose),
// and stamps sent_at + persists the token IFF at least one channel delivered
// (preserving "sent means delivered" — same semantics as estimates.sent_at).
//
// Non-fatal by design: a missing Resend key / Twilio config / no contact on file
// records a warning and returns delivered:false WITHOUT throwing, so an
// unconfigured channel never breaks approval or cycle billing — the invoice is
// still created and re-sendable manually once the provider is configured.
//
// Row load + field mapping live in src/lib/emailLoaders.ts (loadInvoiceForEmail)
// and are SHARED with the /admin/email-preview "preview with real data" feature
// so a preview matches what ships. This helper keeps the channel resolution,
// delivery, and token mint/persist.

import { createClient as createAdminClient } from "@supabase/supabase-js";
import { sendInvoiceEmail } from "@/lib/email";
import { sendInvoiceSms, normalizePhoneToE164 } from "@/lib/sms";
import { loadInvoiceForEmail } from "@/lib/emailLoaders";

// Public base URL for links generated outside an HTTP request (cron / cycle
// billing). NEXT_PUBLIC_SITE_URL is optional — the prod URL is hardcoded as a
// fallback so auto-send links are correct even before the env var is set.
export function publicBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://terravistaconstructionmanagement.com"
  );
}

export type InvoiceChannel = "email" | "sms" | "both";

export type DeliverInvoiceOptions = {
  // Full origin (scheme + host), e.g. "https://terravista...". When omitted,
  // publicBaseUrl() is used (correct for cron / server-only callers).
  origin?: string;
  // Force a channel; when omitted, "whichever on file" (email if email, SMS if
  // phone, both if both) — the auto-send behavior for approval + cycle billing.
  via?: InvoiceChannel;
  // Skip overwriting invoices.sent_at. The overdue-reminder cron sets this so
  // a re-send preserves the FIRST delivery date (the aging clock must not
  // reset on every nudge). A first send of an invoice that was never delivered
  // passes false, so sent_at gets stamped as normal.
  skipSentAtStamp?: boolean;
};

export type DeliverInvoiceResult = {
  delivered: boolean;
  sentVia: ("email" | "sms")[];
  sentTo: { email?: string; phone?: string };
  warnings: { channel: "email" | "sms"; message: string }[];
};

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function deliverInvoice(
  invoiceId: string,
  options: DeliverInvoiceOptions = {}
): Promise<DeliverInvoiceResult> {
  const admin = adminClient();

  const loaded = await loadInvoiceForEmail(admin, invoiceId);
  if (!loaded) {
    return {
      delivered: false,
      sentVia: [],
      sentTo: {},
      warnings: [{ channel: "email", message: "Invoice not found" }],
    };
  }

  const customerEmail = loaded.to;
  const customerPhone = loaded.customerPhone;

  // Mint a share_token only if none exists (re-sends keep the same link —
  // unlike estimates, an invoice link should stay valid once shared).
  const token = loaded.shareToken ?? crypto.randomUUID();
  const origin = options.origin ?? publicBaseUrl();
  const invoiceUrl = `${origin}/invoices/view/${token}`;

  // Resolve channels: caller's choice, else whichever the customer has on file.
  const force = options.via;
  const wantEmail = force
    ? force === "email" || force === "both"
    : !!customerEmail;
  const wantSms = force
    ? force === "sms" || force === "both"
    : !!customerPhone;

  const sentVia: ("email" | "sms")[] = [];
  const warnings: { channel: "email" | "sms"; message: string }[] = [];

  if (!wantEmail && !wantSms) {
    warnings.push({
      channel: "email",
      message:
        "Customer has no email or phone on file — add one in Customers, then resend.",
    });
  }

  if (wantEmail) {
    if (!customerEmail) {
      warnings.push({
        channel: "email",
        message: "Customer has no email on file — skipped email.",
      });
    } else {
      try {
        const { error } = await sendInvoiceEmail({
          to: customerEmail,
          customerName: loaded.customerName,
          orgName: loaded.orgName,
          jobName: loaded.jobName,
          total: loaded.total,
          balanceDue: loaded.balanceDue,
          dueDate: loaded.dueDate,
          invoiceUrl,
        });
        if (error) {
          warnings.push({ channel: "email", message: `Email failed: ${error.message}` });
        } else {
          sentVia.push("email");
        }
      } catch (err) {
        warnings.push({
          channel: "email",
          message: err instanceof Error ? err.message : "Email failed to send.",
        });
      }
    }
  }

  if (wantSms) {
    if (!customerPhone) {
      warnings.push({
        channel: "sms",
        message: "Customer has no phone on file — skipped text.",
      });
    } else {
      const e164 = normalizePhoneToE164(customerPhone);
      if (!e164) {
        warnings.push({
          channel: "sms",
          message: "Text failed: the customer's phone isn't a valid US mobile number.",
        });
      } else {
        try {
          const { error } = await sendInvoiceSms({
            to: e164,
            orgName: loaded.orgName,
            jobName: loaded.jobName,
            balanceDue: loaded.balanceDue,
            invoiceUrl,
          });
          if (error) {
            warnings.push({ channel: "sms", message: `Text failed: ${error.message}` });
          } else {
            sentVia.push("sms");
          }
        } catch (err) {
          warnings.push({
            channel: "sms",
            message: err instanceof Error ? err.message : "Text failed to send.",
          });
        }
      }
    }
  }

  // Persist sent_at + the token iff at least one channel delivered. Keep the
  // token even if it was newly minted but nothing delivered? No — only stamp
  // when delivered, so a not-yet-configured send doesn't burn a token. The
  // token is minted fresh again on the next successful send.
  //
  // skipSentAtStamp (overdue reminders): preserve the original sent_at instead
  // of moving it to the reminder date, so aging/overdue math stays anchored to
  // the first send. The share_token is still persisted if newly minted.
  if (sentVia.length > 0) {
    const update: { sent_at?: string; share_token?: string } = {};
    if (!options.skipSentAtStamp) {
      update.sent_at = new Date().toISOString();
    }
    if (!loaded.shareToken) {
      update.share_token = token;
    }
    if (update.sent_at || update.share_token) {
      await admin.from("invoices").update(update).eq("id", invoiceId);
    }
  }

  return {
    delivered: sentVia.length > 0,
    sentVia,
    sentTo: {
      email: sentVia.includes("email") ? customerEmail ?? undefined : undefined,
      phone: sentVia.includes("sms") ? customerPhone ?? undefined : undefined,
    },
    warnings,
  };
}