// Transactional SMS via Twilio. Server-only — the auth token is a server
// secret and must never reach the browser. Used today to deliver estimates to
// customers (office hits Send → a short SMS with a frictionless /q/{token}
// link). No `twilio` npm dependency: a raw fetch to the REST API with HTTP
// Basic auth (AccountSID:AuthToken).
//
// Setup (user): create a Twilio account, verify/buy a phone number, and set
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Vercel +
// .env.local. For US production volume, carriers require A2P 10DLC brand
// registration so texts aren't filtered as spam. Until the env vars are set,
// sendEstimateSms returns a clear "not configured" error (non-fatal) so the
// email channel keeps working independently.

// Best-effort US-centric normalization to E.164. Returns null when the input
// can't be safely turned into a +1… number (the caller surfaces a 400).
export function normalizePhoneToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return "+" + digits;
  }
  if (digits.length === 10) {
    return "+1" + digits;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("+") && /^\+\d+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export type SendEstimateSmsInput = {
  to: string; // E.164, e.g. +15551234567
  orgName: string;
  jobName: string;
  total: string; // pre-formatted money, e.g. "$1,234.50"
  estimateUrl: string; // public /q/{token} link
};

// Sends the "you have an estimate to review" text. Returns { data, error };
// never throws on missing config (returns an error object so the caller can
// treat unconfigured SMS as a soft skip rather than a 500). A transient
// Twilio/network failure also returns { error }.
export async function sendEstimateSms(
  input: SendEstimateSmsInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !fromNumber) {
    return {
      data: null,
      error: {
        message:
          "Text messaging isn't configured yet — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Vercel to enable SMS.",
      },
    };
  }

  // Allow up to two SMS segments (~306 chars) so the full job name comes
  // through; only truncate if the whole body genuinely overflows. The
  // /q/<uuid> URL is ~50 chars, so this is plenty for normal job names.
  let message = `${input.orgName}: Estimate for ${input.jobName} — ${input.total}. Review & approve: ${input.estimateUrl}`;
  if (message.length > 306) {
    const overflow = message.length - 306;
    const cutJob = input.jobName.slice(0, Math.max(0, input.jobName.length - overflow - 1));
    message = `${input.orgName}: Estimate for ${cutJob}… — ${input.total}. Review & approve: ${input.estimateUrl}`;
    if (message.length > 306) message = message.slice(0, 303) + "…";
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        sid
      )}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: fromNumber,
          To: input.to,
          Body: message,
        }).toString(),
      }
    );

    // Parse once — Twilio returns { sid } on success or { message, ... } on
    // error, and a 4xx/5xx can still carry a JSON body.
    let body: { sid?: string; message?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.ok && body?.sid) {
      return { data: { id: body.sid }, error: null };
    }
    return {
      data: null,
      error: {
        message: body?.message || `Twilio SMS failed (${res.status})`,
      },
    };
  } catch (err) {
    return {
      data: null,
      error: {
        message: err instanceof Error ? err.message : "SMS send failed",
      },
    };
  }
}

export type SendInvoiceSmsInput = {
  to: string; // E.164, e.g. +15551234567
  orgName: string;
  jobName: string;
  balanceDue: string; // pre-formatted money, e.g. "$1,234.50"
  invoiceUrl: string; // public /invoices/view/{token} link
};

// Sends the "you have an invoice to view" text. Mirrors sendEstimateSms: same
// env gate (non-fatal "not configured" error when TWILIO_* unset), same
// raw-fetch Twilio call with HTTP Basic auth, same parse-body-once pattern, and
// the same ≤2-segment (~306 char) truncation. Never throws.
export async function sendInvoiceSms(
  input: SendInvoiceSmsInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !fromNumber) {
    return {
      data: null,
      error: {
        message:
          "Text messaging isn't configured yet — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Vercel to enable SMS.",
      },
    };
  }

  let message = `${input.orgName}: Invoice for ${input.jobName} — ${input.balanceDue} due. View: ${input.invoiceUrl}`;
  if (message.length > 306) {
    const overflow = message.length - 306;
    const cutJob = input.jobName.slice(0, Math.max(0, input.jobName.length - overflow - 1));
    message = `${input.orgName}: Invoice for ${cutJob}… — ${input.balanceDue} due. View: ${input.invoiceUrl}`;
    if (message.length > 306) message = message.slice(0, 303) + "…";
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        sid
      )}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: fromNumber,
          To: input.to,
          Body: message,
        }).toString(),
      }
    );

    let body: { sid?: string; message?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.ok && body?.sid) {
      return { data: { id: body.sid }, error: null };
    }
    return {
      data: null,
      error: {
        message: body?.message || `Twilio SMS failed (${res.status})`,
      },
    };
  } catch (err) {
    return {
      data: null,
      error: {
        message: err instanceof Error ? err.message : "SMS send failed",
      },
    };
  }
}