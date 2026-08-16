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

import { createClient as createAdminClient } from "@supabase/supabase-js";
import { computeTotal, formatMoney } from "@/lib/money";
import { sendInvoiceEmail } from "@/lib/email";
import { sendInvoiceSms, normalizePhoneToE164 } from "@/lib/sms";

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

  const { data: invoice } = await admin
    .from("invoices")
    .select(
      "id, status, customer_id, job_id, organization_id, amount_paid, due_date, share_token, jobs(name), customers(name, contact_email, phone)"
    )
    .eq("id", invoiceId)
    .maybeSingle();

  if (!invoice) {
    return {
      delivered: false,
      sentVia: [],
      sentTo: {},
      warnings: [{ channel: "email", message: "Invoice not found" }],
    };
  }

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const jobName =
    (invoice.jobs as unknown as { name: string } | null)?.name ?? "your project";
  const customerEmail = customer?.contact_email?.trim() || null;
  const customerPhone = customer?.phone?.trim() || null;
  const customerName = customer?.name ?? "";

  // Org name for branding.
  let orgName = "";
  if (invoice.organization_id) {
    const { data: org } = await admin
      .from("organizations")
      .select("name")
      .eq("id", invoice.organization_id)
      .maybeSingle();
    if (org?.name) orgName = org.name;
  }

  // Total + balance from the invoice's own line items (markup/contingency/tax
  // are already baked in as lines, so a plain sum is the invoice total).
  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", invoiceId);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );
  const amountPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - amountPaid);
  const totalStr = formatMoney(total);
  const balanceStr = formatMoney(balanceDue);
  const dueDateStr = invoice.due_date
    ? new Date(`${invoice.due_date}T00:00:00`).toLocaleDateString()
    : null;

  // Mint a share_token only if none exists (re-sends keep the same link —
  // unlike estimates, an invoice link should stay valid once shared).
  const token = invoice.share_token ?? crypto.randomUUID();
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
          customerName,
          orgName,
          jobName,
          total: totalStr,
          balanceDue: balanceStr,
          dueDate: dueDateStr,
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
            orgName,
            jobName,
            balanceDue: balanceStr,
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
  if (sentVia.length > 0) {
    const update: { sent_at: string; share_token?: string } = {
      sent_at: new Date().toISOString(),
    };
    if (!invoice.share_token) {
      update.share_token = token;
    }
    await admin.from("invoices").update(update).eq("id", invoiceId);
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