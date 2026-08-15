// Transactional email via Resend. Server-only — the API key is a server secret
// and must never reach the browser. Used today to deliver estimates to customers
// (office hits Send → branded email with a frictionless /q/{token} link).
//
// Setup (user): create a Resend account, verify a sending domain, and set
// RESEND_API_KEY + RESEND_FROM in Vercel + .env.local. The Resend onboarding
// address (onboarding@resend.com) only delivers to the account owner's email —
// fine for testing, not production.

import { Resend } from "resend";

function fromAddress(): string {
  return (
    process.env.RESEND_FROM ||
    "Terra Vista Construction <onboarding@resend.com>"
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type SendEstimateEmailInput = {
  to: string;
  customerName: string;
  orgName: string;
  jobName: string;
  estimateNumber?: string | null; // e.g. "EST-0007"
  total: string; // pre-formatted money, e.g. "$1,234.50"
  validUntil: string | null; // pre-formatted date or null
  estimateUrl: string; // public /q/{token} link
  message?: string | null; // optional personal note from the office, shown up top
};

// Sends the "you have an estimate to review" email. Returns Resend's result
// ({ data, error }); the caller decides how to surface a failure. Throws if
// RESEND_API_KEY is unset so the route returns a clear 500 instead of a silent
// no-op.
export function sendEstimateEmail(
  input: SendEstimateEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set — add it in Vercel (Project Settings → Environment Variables) and redploy."
    );
  }

  const resend = new Resend(apiKey);
  const org = escapeHtml(input.orgName);
  const job = escapeHtml(input.jobName);
  const customer = escapeHtml(input.customerName || "there");
  const total = escapeHtml(input.total);
  const numberLine = input.estimateNumber
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Estimate #${escapeHtml(
        input.estimateNumber
      )}</p>`
    : "";
  const validLine = input.validUntil
    ? `<p style="margin:0;color:#6b7280;font-size:14px;">This estimate is valid until <strong style="color:#374151;">${escapeHtml(
        input.validUntil
      )}</strong>.</p>`
    : "";
  const messageLine = input.message && input.message.trim()
    ? `<p style="margin:0 0 20px;color:#111827;font-size:15px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
        input.message.trim()
      )}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:#1e3a8a;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${org}</p>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Estimate for your review</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${customer},</p>
          ${messageLine}
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            You have an estimate from <strong>${org}</strong> for
            <strong>${job}</strong> ready for your review. Please open it below
            to see the details and approve or decline.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              ${numberLine}
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Project</p>
              <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">${job}</p>
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Estimate total</p>
              <p style="margin:0;color:#111827;font-size:28px;font-weight:700;">${total}</p>
            </td></tr>
          </table>
          ${validLine}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${input.estimateUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Review &amp; Approve Estimate</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This link is private — anyone with it can view and act on this estimate.
            If you weren't expecting an estimate from ${org}, you can safely ignore
            this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${org} via Terra Vista Construction Management.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return resend.emails.send({
    from: fromAddress(),
    to: input.to,
    subject: input.estimateNumber
      ? `Estimate #${input.estimateNumber} from ${input.orgName} — ${input.jobName}`
      : `Estimate from ${input.orgName} — ${input.jobName}`,
    html,
  });
}

export type SendVerificationEmailInput = {
  to: string;
  name: string;
  verifyLink: string; // the action_link returned by admin.generateLink({type:'signup'})
};

// Sends the "verify your email" email to a new self-serve signup. The link is
// generated server-side via admin.auth.admin.generateLink({type:'signup',...})
// in /api/signup and delivered here through Resend (NOT Supabase's built-in
// sender), so it depends on the Resend sending domain being verified for
// delivery to non-owner inboxes. Returns Resend's { data, error }; the caller
// (signup route) treats a failed send as non-fatal (workspace is already
// created) and surfaces an emailSent:false flag to the client.
export function sendVerificationEmail(
  input: SendVerificationEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set — add it in Vercel (Project Settings → Environment Variables) and redploy."
    );
  }

  const resend = new Resend(apiKey);
  const name = escapeHtml(input.name || "there");
  const href = input.verifyLink; // Supabase-generated verify URL — left intact

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:#1e3a8a;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">Terra Vista</p>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Verify your email</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${name},</p>
`;

  return resend.emails.send({
    from: fromAddress(),
    to: input.to,
    subject: `Verify your email — Terra Vista`,
    html,
  });
}
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            Thanks for creating your business workspace. Please confirm your
            email address to finish setting up your account and sign in.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${href}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Verify email</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            If you didn't create an account, you can safely ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by Terra Vista Construction Management.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return resend.emails.send({
    from: fromAddress(),
    to: input.to,
    subject: "Verify your email — Terra Vista",
    html,
  });
}