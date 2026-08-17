// Transactional email via Resend. Server-only — the API key is a server secret
// and must never reach the browser. Used today to deliver estimates to customers
// (office hits Send → branded email with a frictionless /q/{token} link).
//
// Setup (user): create a Resend account, verify a sending domain, and set
// RESEND_API_KEY + RESEND_FROM in Vercel + .env.local. The Resend onboarding
// address (onboarding@resend.com) only delivers to the account owner's email —
// fine for testing, not production.

import { Resend } from "resend";
import { BRAND } from "@/lib/brand";

function fromAddress(): string {
  // RESEND_FROM holds the verified sending address (shared across both variant
  // deploys — e.g. noreply@terravistaconstructionmanagement.com — because both
  // apps use one Resend account and only that domain is verified). To keep the
  // sender identity on-brand per variant, we strip any display name already in
  // RESEND_FROM and re-wrap the bare address with THIS variant's brand name:
  //   construction → "Terra Vista Construction Management <noreply@…>"
  //   lawn         → "Terra Verde Lawn Management <noreply@…>"
  // The underlying address stays the verified one, so delivery is unchanged;
  // only the display name the recipient sees flips with the variant.
  const raw = process.env.RESEND_FROM;
  if (!raw) return `${BRAND.company} <onboarding@resend.com>`;
  const match = raw.match(/<([^>]+)>/);
  const addr = (match?.[1] ?? raw).trim();
  return `${BRAND.company} <${addr}>`;
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
export async function sendEstimateEmail(
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
        <tr><td style="padding:24px 28px;background:${BRAND.themeColorDark};">
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
              <a href="${input.estimateUrl}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Review &amp; Approve Estimate</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This link is private — anyone with it can view and act on this estimate.
            If you weren't expecting an estimate from ${org}, you can safely ignore
            this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${org} via ${BRAND.company}.</p>
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
export async function sendVerificationEmail(
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
        <tr><td style="padding:24px 28px;background:${BRAND.themeColorDark};">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${BRAND.shortName}</p>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Verify your email</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${name},</p>
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            Thanks for creating your business workspace. Please confirm your
            email address to finish setting up your account and sign in.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${href}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Verify email</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            If you didn't create an account, you can safely ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return resend.emails.send({
    from: fromAddress(),
    to: input.to,
    subject: `Verify your email — ${BRAND.shortName}`,
    html,
  });
}

export type SendPasswordResetEmailInput = {
  to: string;
  resetLink: string; // https://<origin>/reset-password?token=<raw token>
};

// Sends the "reset your password" email. The link points at our OWN
// /reset-password?token=... route (NOT Supabase's PKCE recovery link), so the
// proof lives entirely in the link — the user can click it on any device /
// browser / the installed PWA and it just works. Unlike the old
// resetPasswordForEmail flow there is NO Supabase fallback: Supabase's built-in
// sender can only carry its own (same-device, PKCE) link, not our custom token
// link, so a verified RESEND_FROM sending domain is REQUIRED for delivery to
// non-owner inboxes. Throws if RESEND_API_KEY is unset; returns Resend's
// { data, error } otherwise (the caller treats an error as a hard failure,
// since a reset email that never arrives is worse than a clear error).
export async function sendPasswordResetEmail(
  input: SendPasswordResetEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set — add it in Vercel (Project Settings → Environment Variables) and redploy."
    );
  }

  const resend = new Resend(apiKey);
  const href = input.resetLink; // our /reset-password?token=... URL — left intact

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:${BRAND.themeColorDark};">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${BRAND.shortName}</p>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Reset your password</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            We received a request to reset the password for your ${BRAND.company}
            account. Click the button below to choose a new one.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${href}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Reset password</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This link expires in 15 minutes and can only be used once. You can
            open it on any device. If you didn't request a password reset, you
            can safely ignore this email — your password won't change.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return resend.emails.send({
    from: fromAddress(),
    to: input.to,
    subject: `Reset your password — ${BRAND.shortName}`,
    html,
  });
}

// ── Lawn visit emails ──────────────────────────────────────────────────────
//
// Two short transactional emails for the lawn visit flow. Both follow the
// NON-FATAL pattern: if RESEND_API_KEY / RESEND_FROM is missing, they return
// { error } WITHOUT throwing, so a route can treat an unconfigured Resend as a
// soft skip (toast "Email not configured") rather than a 500. A transient
// Resend failure also returns { error } — the caller stamps notified_at
// regardless so a one-shot notice isn't retried on every action.
//
// NOTE: these still hardcode "Terra Vista" in the header/footer. That is a
// multi-tenancy branding gap — a tenant's customer sees the platform name, not
// the tenant's org. Fix: thread orgName into these (like sendEstimateEmail) and
// render "Sent by ${org} via ${BRAND.company}". Tracked as a follow-up.

export type SendOnMyWayEmailInput = {
  to: string;
  customerName: string;
  jobName: string;
  address: string | null;
};

// "Your lawn crew is on the way" — one-tap heads-up sent from the visit page.
export async function sendOnMyWayEmail(
  input: SendOnMyWayEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }
  const resend = new Resend(apiKey);
  const customer = escapeHtml(input.customerName || "there");
  const job = escapeHtml(input.jobName);
  const address = input.address ? escapeHtml(input.address) : null;
  const addressLine = address
    ? `<p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;"><strong>${address}</strong></p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:#15803d;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${BRAND.shortName}</p>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Your crew is on the way</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${customer},</p>
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            Your lawn crew is heading out to service
            <strong>${job}</strong>. They should arrive shortly.
          </p>
          ${addressLine}
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This is an automated heads-up from ${BRAND.company}.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: `Your lawn crew is on the way — ${input.jobName}`,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

export type SendLawnVisitEmailInput = {
  to: string;
  customerName: string;
  jobName: string;
  address: string | null;
  subject: string;
  lines: string[]; // pre-formatted body lines (plain text, rendered as paragraphs)
};

// Generic lawn-visit notice (visit completed / skipped / rescheduled). The
// caller picks the subject + body lines so this stays a thin, reusable wrapper.
export async function sendLawnVisitEmail(
  input: SendLawnVisitEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }
  const resend = new Resend(apiKey);
  const customer = escapeHtml(input.customerName || "there");
  const job = escapeHtml(input.jobName);
  const address = input.address ? escapeHtml(input.address) : null;
  const addressLine = address
    ? `<p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;"><strong>${address}</strong></p>`
    : "";
  const bodyLines = input.lines
    .map(
      (l) =>
        `<p style="margin:0 0 12px;color:#111827;font-size:16px;line-height:1.5;">${escapeHtml(
          l
        )}</p>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:#15803d;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${BRAND.shortName}</p>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Lawn service update</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${customer},</p>
          <p style="margin:0 0 12px;color:#111827;font-size:16px;line-height:1.5;">
            A service update for <strong>${job}</strong>:
          </p>
          ${bodyLines}
          ${addressLine}
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This is an automated notice from ${BRAND.company}.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

// ── Generic customer email (notification suite) ────────────────────────────
//
// Used by src/lib/customerNotifications.ts for the templated visit-milestone
// sends (reminder / on-my-way / service-complete / review request). Unlike the
// fixed lawn-visit emails above, the caller supplies the full subject + body
// (plain text, {{tokens}} already substituted, \n separates paragraphs) so the
// office-managed templates drive the copy. Threads the tenant's orgName for the
// customer-facing header/footer (organizations.name) so a customer sees the
// lawn company's name, not the platform brand — closing the branding gap noted
// on sendLawnVisitEmail. Non-fatal: returns an error object when RESEND_API_KEY
// is unset instead of throwing.

function linkify(s: string): string {
  // escapeHtml() has already run; turn bare URLs into clickable anchors. URL
  // characters (:/._-~) are not altered by escaping, so this is safe to apply
  // after escaping.
  return s.replace(
    /(https?:\/\/[^\s<]+)/g,
    (u) => `<a href="${u}" style="color:#15803d;font-weight:600;text-decoration:none;">${u}</a>`
  );
}

export type SendCustomerEmailInput = {
  to: string;
  subject: string;
  body: string; // plain text; \n separates paragraphs; tokens already substituted
  orgName?: string | null; // tenant org name (falls back to BRAND.company)
  // Optional Google Static Maps property image (built from the job's lawn_jobs
  // pin via buildStaticMapUrl). Rendered as a real <img> in the template — NOT
  // through the escaped plain-text body (which would escape the tag). Omitted
  // when null/empty (no pin or GOOGLE_MAPS_STATIC_KEY unset).
  mapImageUrl?: string | null;
};

export async function sendCustomerEmail(
  input: SendCustomerEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }
  const resend = new Resend(apiKey);
  const orgName = input.orgName?.trim() || BRAND.company;
  const bodyParas = input.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(
      (l) =>
        `<p style="margin:0 0 12px;color:#111827;font-size:16px;line-height:1.5;">${linkify(
          escapeHtml(l)
        )}</p>`
    )
    .join("");

  // Optional Static Maps property image. Rendered as a real <img> (NOT through
  // the escaped body). URL is built server-side by buildStaticMapUrl from our
  // own key — trusted, so it goes into src unescaped.
  const mapImg = input.mapImageUrl
    ? `<img src="${input.mapImageUrl}" width="300" height="160" alt="Property map" style="display:block;width:100%;max-width:300px;height:auto;border-radius:8px;margin:16px 0;border:1px solid #e5e7eb;" />`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:#15803d;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${escapeHtml(
            orgName
          )}</p>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Lawn service</p>
        </td></tr>
        <tr><td style="padding:28px;">
          ${bodyParas}
          ${mapImg}
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This is an automated message from ${escapeHtml(orgName)}.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${escapeHtml(orgName)}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

// ── Invoice email ───────────────────────────────────────────────────────────
//
// "You have an invoice to view" — sent when an invoice is delivered to a
// customer (auto on construction approval + lawn cycle billing, or manually
// from the invoice detail page). NON-FATAL like the lawn emails: returns
// { data: null, error } (never throws) when RESEND_API_KEY is unset, so the
// auto-send flow treats an unconfigured Resend as a soft skip rather than a
// 500. Mirrors sendEstimateEmail's template style (same header/footer tables).

export type SendInvoiceEmailInput = {
  to: string;
  customerName: string;
  orgName: string;
  jobName: string;
  total: string; // pre-formatted money, e.g. "$1,234.50"
  balanceDue: string; // pre-formatted money
  dueDate?: string | null; // pre-formatted date or null
  invoiceUrl: string; // public /invoices/view/{token} link
  message?: string | null; // optional personal note, shown up top
};

export async function sendInvoiceEmail(
  input: SendInvoiceEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }

  const resend = new Resend(apiKey);
  const org = escapeHtml(input.orgName);
  const job = escapeHtml(input.jobName);
  const customer = escapeHtml(input.customerName || "there");
  const balanceDue = escapeHtml(input.balanceDue);
  const dueLine = input.dueDate
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Due ${escapeHtml(
        input.dueDate
      )}</p>`
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
        <tr><td style="padding:24px 28px;background:${BRAND.themeColorDark};">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${org}</p>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Invoice</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${customer},</p>
          ${messageLine}
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            You have an invoice from <strong>${org}</strong> for
            <strong>${job}</strong>.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Project</p>
              <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">${job}</p>
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Amount due</p>
              <p style="margin:0;color:#111827;font-size:28px;font-weight:700;">${balanceDue}</p>
              ${dueLine}
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${input.invoiceUrl}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">View Invoice</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This link is private — anyone with it can view this invoice.
            If you weren't expecting an invoice from ${org}, you can safely ignore
            this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${org} via ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: `Invoice from ${input.orgName} — ${input.jobName}`,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

// ── Invoice receipt email (manual, offline payments) ────────────────────────
//
// "Payment receipt" — emailed to the customer when the office hits Send receipt
// on a PAID invoice (the manual path for cash/check payments the office recorded
// by marking the invoice paid). Online (Stripe) payments get Stripe's own
// receipt, so this is NOT auto-fired from the webhook — only the office (or the
// owning customer) triggers it via /api/invoices/[id]/receipt. NON-FATAL like
// the other invoice emails: returns { data: null, error } (never throws) when
// RESEND_API_KEY is unset, so the route surfaces a clear warning instead of a
// 500. A paid invoice is paid in full, so the caller always passes amountPaid =
// the invoice total and balanceDue = "$0.00" (this email renders a "Paid in
// full" badge when balanceDue is "$0.00"). Mirrors sendInvoiceEmail's template
// style (same 560-max responsive table) so it renders correctly on desktop +
// mobile.

export type SendInvoiceReceiptEmailInput = {
  to: string;
  customerName: string;
  orgName: string;
  jobName: string;
  amountPaid: string; // pre-formatted money, e.g. "$1,234.50"
  balanceDue: string; // pre-formatted money, e.g. "$0.00"
  paidAt: string | null; // pre-formatted date or null
  invoiceUrl: string; // public /invoices/view/{token} link
};

export async function sendInvoiceReceiptEmail(
  input: SendInvoiceReceiptEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }
  const resend = new Resend(apiKey);
  const org = escapeHtml(input.orgName);
  const customer = escapeHtml(input.customerName || "there");
  const job = escapeHtml(input.jobName);
  const amountPaid = escapeHtml(input.amountPaid);
  const balanceDue = escapeHtml(input.balanceDue);
  const paidFull = input.balanceDue.trim() === "$0.00";
  const badge = paidFull
    ? '<span style="display:inline-block;margin-left:8px;background:#dcfce7;color:#15803d;padding:3px 10px;border-radius:9999px;font-size:11px;font-weight:700;letter-spacing:.02em;">Paid in full</span>'
    : "";
  const dateRow = input.paidAt
    ? `<p style="margin:12px 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Date paid</p><p style="margin:0;color:#111827;font-size:15px;font-weight:600;">${escapeHtml(
        input.paidAt
      )}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:${BRAND.themeColorDark};">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${org}</p>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Payment receipt</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${customer},</p>
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            We received your payment of <strong>${amountPaid}</strong> for
            <strong>${job}</strong>. Thank you!
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Amount paid</p>
              <p style="margin:0;color:#111827;font-size:28px;font-weight:700;">${amountPaid}</p>
              <p style="margin:12px 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Balance due</p>
              <p style="margin:0;color:#111827;font-size:15px;font-weight:600;">${balanceDue}${badge}</p>
              ${dateRow}
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${input.invoiceUrl}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">View invoice</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This is your payment receipt from ${org}. If you have any questions,
            please contact ${org} directly.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${org} via ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: `Payment receipt from ${input.orgName} — ${input.jobName}`,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

// ── Estimate decision notification (internal, to the office) ────────────────
//
// Fired when a customer approves or declines an estimate on the public view
// (/api/estimates/by-token/[token]/decide). Unlike the customer-facing emails
// above, this goes to the BUSINESS (org.email) so the office learns a customer
// just acted — no polling needed. NON-FATAL like the invoice/lawn emails:
// returns { data: null, error } (never throws) when RESEND_API_KEY is unset, so
// an unconfigured Resend never breaks the approval flow. The estimateUrl is the
// logged-in office detail link (/estimates/<id>), not the public /q/{token} link.

export type SendEstimateDecisionEmailInput = {
  to: string; // the org/office email to notify
  orgName: string;
  customerName: string;
  jobName: string;
  estimateNumber?: string | null; // e.g. "EST-0007"
  decision: "approved" | "rejected";
  estimateUrl: string; // logged-in office link to open the estimate
};

export async function sendEstimateDecisionEmail(
  input: SendEstimateDecisionEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }

  const resend = new Resend(apiKey);
  const org = escapeHtml(input.orgName);
  const customer = escapeHtml(input.customerName || "your customer");
  const job = escapeHtml(input.jobName);
  const approved = input.decision === "approved";
  const headerBackground = approved ? "#15803d" : "#b91c1c";
  const headerSubtitle = approved ? "Estimate approved" : "Estimate declined";
  const headerSubtitleColor = approved ? "#bbf7d0" : "#fecaca";
  const numberLine = input.estimateNumber
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Estimate #${escapeHtml(
        input.estimateNumber
      )}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:${headerBackground};">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${org}</p>
          <p style="margin:4px 0 0;color:${headerSubtitleColor};font-size:12px;text-transform:uppercase;letter-spacing:.08em;">${headerSubtitle}</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi team,</p>
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            Your customer <strong>${customer}</strong> has <strong>${input.decision}</strong> the estimate for
            <strong>${job}</strong>.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              ${numberLine}
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Project</p>
              <p style="margin:0;color:#111827;font-size:15px;font-weight:600;">${job}</p>
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${input.estimateUrl}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Open estimate</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This is an automated notification from ${BRAND.company}.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.estimateNumber
        ? `Estimate #${input.estimateNumber} ${input.decision} by ${input.customerName} — ${input.jobName}`
        : `Estimate ${input.decision} by ${input.customerName} — ${input.jobName}`,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

// ── Change order email (to the customer/owner) ──────────────────────────────
//
// "You have a change order to review" — sent when the office hits Send on a
// change order (mints a share_token → /co/{token} portal). NON-FATAL like the
// invoice/lawn emails: returns { data: null, error } (never throws) when
// RESEND_API_KEY is unset, so the send route treats an unconfigured Resend as a
// hard failure to deliver (it won't mark the CO sent) without a 500 crash.
// Mirrors sendEstimateEmail's template style.

export type SendChangeOrderEmailInput = {
  to: string;
  customerName: string;
  orgName: string;
  jobName: string;
  coNumber?: string | null; // e.g. "CO-0003"
  title: string;
  amount: string; // pre-formatted money, e.g. "$1,234.50"
  isCredit: boolean;
  changeOrderUrl: string; // public /co/{token} link
  message?: string | null;
};

export async function sendChangeOrderEmail(
  input: SendChangeOrderEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }

  const resend = new Resend(apiKey);
  const org = escapeHtml(input.orgName);
  const job = escapeHtml(input.jobName);
  const customer = escapeHtml(input.customerName || "there");
  const title = escapeHtml(input.title);
  const amount = escapeHtml(input.amount);
  const numberLine = input.coNumber
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Change Order #${escapeHtml(
        input.coNumber
      )}</p>`
    : "";
  const messageLine = input.message && input.message.trim()
    ? `<p style="margin:0 0 20px;color:#111827;font-size:15px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
        input.message.trim()
      )}</p>`
    : "";
  const kind = input.isCredit ? "credit" : "change order";
  const kindLabel = input.isCredit ? "Credit to review" : "Change order for your review";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="padding:24px 28px;background:#7c2d12;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${org}</p>
          <p style="margin:4px 0 0;color:#fed7aa;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">${kindLabel}</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:14px;">Hi ${customer},</p>
          ${messageLine}
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            You have a ${kind} from <strong>${org}</strong> for
            <strong>${job}</strong> ready for your review. Please open it below
            to see the details and approve or decline.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              ${numberLine}
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Project</p>
              <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">${job}</p>
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">${input.isCredit ? "Credit" : "Amount"}</p>
              <p style="margin:0;color:#111827;font-size:28px;font-weight:700;">${amount}</p>
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${input.changeOrderUrl}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Review &amp; Approve Change Order</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This link is private — anyone with it can view and act on this change order.
            If you weren't expecting a change order from ${org}, you can safely ignore
            this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${org} via ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.coNumber
        ? `Change Order #${input.coNumber} from ${input.orgName} — ${input.jobName}`
        : `Change Order from ${input.orgName} — ${input.jobName}`,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}

// ── Submittal email (to the architect/owner reviewer) ───────────────────────
//
// "You have a submittal to review" — sent when the office hits Send on a
// submittal (mints a share_token → /s/{token} portal). The reviewer (architect
// or owner) returns a disposition at the portal. NON-FATAL: returns
// { data: null, error } (never throws) when RESEND_API_KEY is unset.

export type SendSubmittalEmailInput = {
  to: string; // the reviewer's email (entered by the office)
  orgName: string;
  jobName: string;
  submittalNumber?: string | null; // e.g. "SUB-0012"
  title: string;
  csiSection?: string | null;
  submittalUrl: string; // public /s/{token} link
  message?: string | null;
};

export async function sendSubmittalEmail(
  input: SendSubmittalEmailInput
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { data: null, error: { message: "email not configured" } };
  }

  const resend = new Resend(apiKey);
  const org = escapeHtml(input.orgName);
  const job = escapeHtml(input.jobName);
  const title = escapeHtml(input.title);
  const csi = input.csiSection ? escapeHtml(input.csiSection) : null;
  const numberLine = input.submittalNumber
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Submittal #${escapeHtml(
        input.submittalNumber
      )}</p>`
    : "";
  const csiLine = csi
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">CSI Section</p><p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">${csi}</p>`
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
        <tr><td style="padding:24px 28px;background:#4338ca;">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${org}</p>
          <p style="margin:4px 0 0;color:#c7d2fe;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Submittal for your review</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 20px;color:#111827;font-size:16px;line-height:1.5;">
            You have a submittal from <strong>${org}</strong> for
            <strong>${job}</strong> ready for your review.
          </p>
          ${messageLine}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;">
              ${numberLine}
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Project</p>
              <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">${job}</p>
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Submittal</p>
              <p style="margin:0;color:#111827;font-size:18px;font-weight:600;">${title}</p>
              ${csiLine}
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
            <tr><td align="center">
              <a href="${input.submittalUrl}" style="display:inline-block;background:${BRAND.themeColor};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:10px;">Review Submittal</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
            This link is private — anyone with it can view and return this submittal.
            If you weren't expecting a submittal from ${org}, you can safely ignore
            this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by ${org} via ${BRAND.company}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    return await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.submittalNumber
        ? `Submittal #${input.submittalNumber} from ${input.orgName} — ${input.jobName}`
        : `Submittal from ${input.orgName} — ${input.jobName}`,
      html,
    });
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "email send failed" },
    };
  }
}