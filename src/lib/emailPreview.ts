// Server-only registry of every customer-facing email the platform can send,
// for the /admin/email-preview console.
//
// Two categories:
//  - TEMPLATED (editable): the 5 lawn visit-lifecycle events. Wording lives in
//    the org's notification_templates rows (managed at /lawn/notifications).
//    The preview renders the SAVED template (or the live-edited body the office
//    is typing) with sample tokens, wrapped in renderCustomerEmailHtml — exactly
//    what sendCustomerEmail ships. "Send test to yourself" re-runs that same
//    render + sendCustomerEmail to the signed-in user's own inbox.
//  - FIXED COPY (preview + test only): estimate + invoice. Wording is code-owned
//    (legal/accounting copy), so the editor is intentionally NOT offered here —
//    the office sees exactly what ships, and can send a test to themselves. The
//    render fns (renderEstimateEmail / renderInvoiceEmail) are the single source
//    of truth shared with the real send fns.
//
// Design rule: a preview MUST match what ships. Templated kinds share
// renderCustomerEmailHtml + renderTemplate + notification_templates with
// sendCustomerNotification; fixed kinds share the factored renderXEmail fns with
// sendXEmail. No duplicate templates live here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { publicBaseUrl } from "@/lib/invoiceSend";
import {
  renderCustomerEmailHtml,
  renderEstimateEmail,
  renderInvoiceEmail,
  renderInvoiceReceiptEmail,
  renderChangeOrderEmail,
  renderSubmittalEmail,
  renderClientPortalMagicLink,
  renderPasswordResetEmail,
  renderVerificationEmail,
  sendCustomerEmail,
  sendEstimateEmail,
  sendInvoiceEmail,
  sendInvoiceReceiptEmail,
  sendChangeOrderEmail,
  sendSubmittalEmail,
  sendClientPortalMagicLink,
  sendPasswordResetEmail,
  sendVerificationEmail,
  type SendEstimateEmailInput,
  type SendInvoiceEmailInput,
  type SendInvoiceReceiptEmailInput,
  type SendChangeOrderEmailInput,
  type SendSubmittalEmailInput,
  type SendClientPortalMagicLinkInput,
  type SendPasswordResetEmailInput,
  type SendVerificationEmailInput,
} from "@/lib/email";
import { renderTemplate, type NotificationEvent } from "@/lib/customerNotifications";
import {
  EMAIL_KIND_META,
  EVENT_LABEL,
  type EmailKindMeta,
  type EmailVariant,
} from "@/lib/emailPreviewKinds";
import {
  loadEstimateForEmail,
  loadInvoiceForEmail,
  loadInvoiceReceiptForEmail,
  loadChangeOrderForEmail,
  loadSubmittalForEmail,
  loadCustomerForMagicLink,
  loadVisitForTemplated,
  listRecordsForKind,
  type PickerRecord,
  type LoadedEstimate,
  type LoadedInvoice,
  type LoadedInvoiceReceipt,
  type LoadedChangeOrder,
  type LoadedSubmittal,
  type LoadedCustomerMagicLink,
  type LoadedVisitTemplated,
} from "@/lib/emailLoaders";

export type { EmailVariant } from "@/lib/emailPreviewKinds";
export type { PickerRecord } from "@/lib/emailLoaders";

export type RenderCtx = {
  supabase: SupabaseClient;
  organizationId: string;
  orgName: string;
  // TEMPLATED kinds only: the live-edited subject/body the office is typing in
  // the editor (preview-as-you-type). When undefined, the org's SAVED
  // notification_templates row is loaded and rendered. Fixed kinds ignore these.
  editedSubject?: string;
  editedBody?: string;
  // When set, the render/sendTest loads the matching business record (via the
  // emailLoaders) and builds the render input from its real fields instead of
  // SAMPLE. The preview NEVER mints or persists a token — it uses the record's
  // existing shareToken, or a "(link generates on send)" placeholder when none.
  // If the loader returns null (deleted/missing record), falls back to SAMPLE.
  recordId?: string;
};

export type SendResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

export type EmailKind = {
  id: string;
  label: string;
  variant: EmailVariant;
  audience: "customer" | "office";
  // true => the editor (subject/body textareas) is shown. Templated kinds only.
  editable: boolean;
  // Token names this template supports — shown as hints in the editor.
  tokens?: string[];
  // When set, the preview UI offers a Sample | Real toggle + record picker.
  realData?: EmailKindMeta["realData"];
  // Render the email to { subject, html } for the preview pane. For editable
  // (templated) kinds, rawSubject/rawBody are the UN-substituted saved (or
  // live-edited) copy so the editor can populate with {{tokens}} intact — the
  // office edits the raw template here, just like /lawn/notifications, and sees
  // the substituted result render in the preview pane. Fixed kinds omit them.
  render: (ctx: RenderCtx) => Promise<{
    subject: string;
    html: string;
    rawSubject?: string;
    rawBody?: string;
  }>;
  // Render + send a test to the signed-in user's OWN email (never a customer).
  sendTest: (toEmail: string, ctx: RenderCtx) => Promise<SendResult>;
};

// ── Sample data ─────────────────────────────────────────────────────────────
// Realistic but obviously-sample values so the office can see how tokens,
// money, dates, and links render. URLs use publicBaseUrl() so they reflect the
// real deploy domain (and obviously-fake token segments so a stray click goes
// nowhere).

const SAMPLE = {
  customerName: "Jordan Riley",
  jobName: "Maple St. Renovation",
  lawnJobName: "Maple St. Lawn Service",
  address: "142 Maple Street, Springfield, IL 62704",
  serviceDate: "Aug 21, 2026",
  total: "$12,450.00",
  balanceDue: "$12,450.00",
  dueDate: "Sep 15, 2026",
  estimateNumber: "EST-0007",
  validUntil: "Aug 28, 2026",
  estimateMessage:
    "Thanks for the opportunity, Jordan — here's the detailed estimate for the Maple St. project. Let me know if you have any questions.",
  invoiceMessage:
    "Your invoice is ready for review. Payment is due by the date shown above.",
  amountPaid: "$12,450.00",
  paidAt: "Aug 20, 2026",
  coNumber: "CO-0003",
  coTitle: "Kitchen tile upgrade",
  coAmount: "$1,250.00",
  coMessage:
    "Jordan, here's the change order for the upgraded tile we discussed. Let me know if you have any questions.",
  submittalNumber: "SUB-0012",
  submittalTitle: "Tile specification sheet",
  csiSection: "09 30 00 — Tiling",
  submittalMessage:
    "Please review and return this submittal at your earliest convenience.",
};

function sampleEstimateUrl(): string {
  return `${publicBaseUrl()}/q/sample-estimate-token`;
}
function sampleInvoiceUrl(): string {
  return `${publicBaseUrl()}/invoices/view/sample-invoice-token`;
}
function sampleChangeOrderUrl(): string {
  return `${publicBaseUrl()}/co/sample-co-token`;
}
function sampleSubmittalUrl(): string {
  return `${publicBaseUrl()}/s/sample-submittal-token`;
}
function sampleResetLink(): string {
  return `${publicBaseUrl()}/reset-password?token=sample-reset-token`;
}
function sampleVerifyLink(): string {
  return `${publicBaseUrl()}/auth/callback?token=sample-verify-token&type=signup`;
}
function sampleSignInLink(): string {
  return `${publicBaseUrl()}/auth/callback?flow=client&token=sample-magic-link-token`;
}

// ── Real-data preview URL ───────────────────────────────────────────────────
// THE DRIFT-PROOF SEAM: the preview NEVER mints or persists a token. It uses
// the record's EXISTING shareToken, or a clearly-marked "(link generates on
// send)" placeholder when no token exists yet (the send path is what creates
// it). signInLink for client_portal_magic_link is never stored (Supabase
// generateLink at send time) → always a placeholder.

function previewUrlForKind(
  kindId: string,
  shareToken: string | null
): string {
  const base = publicBaseUrl();
  switch (kindId) {
    case "estimate":
      return shareToken
        ? `${base}/q/${shareToken}`
        : `${base}/q/(link generates on send)`;
    case "invoice":
    case "invoice_receipt":
      return shareToken
        ? `${base}/invoices/view/${shareToken}`
        : `${base}/invoices/view/(link generates on send)`;
    case "change_order":
      return shareToken
        ? `${base}/co/${shareToken}`
        : `${base}/co/(link generates on send)`;
    case "submittal":
      return shareToken
        ? `${base}/s/${shareToken}`
        : `${base}/s/(link generates on send)`;
    case "client_portal_magic_link":
      return `${base}/auth/callback?flow=client&token=(generates on send)`;
    default:
      return base;
  }
}

// Placeholder copy for fields with no stored real equivalent. The office fills
// these at send time (estimate/invoice/change_order/submittal message) or they
// are generated at send time (signInLink). Marked clearly so a preview reader
// knows the real send will differ.
const PLACEHOLDER_MESSAGE =
  "(Personal note appears here when the office adds one at send time.)";
const PLACEHOLDER_SIGN_IN_LINK = `${publicBaseUrl()}/auth/callback?flow=client&token=(generates on send)`;

// ── Real-data input builders ────────────────────────────────────────────────
// Map a loaded record → the render-input shape, using the preview URL above and
// placeholder strings for non-stored fields. Mirror the sampleXInput shapes so
// the render fn sees the same contract either way.

function realEstimateInput(
  loaded: LoadedEstimate
): SendEstimateEmailInput {
  return {
    to: "",
    customerName: loaded.customerName || SAMPLE.customerName,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    estimateNumber: loaded.estimateNumber ?? null,
    total: loaded.total,
    validUntil: loaded.validUntil,
    estimateUrl: previewUrlForKind("estimate", loaded.shareToken),
    message: PLACEHOLDER_MESSAGE,
  };
}

function realInvoiceInput(loaded: LoadedInvoice): SendInvoiceEmailInput {
  return {
    to: "",
    customerName: loaded.customerName || SAMPLE.customerName,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    total: loaded.total,
    balanceDue: loaded.balanceDue,
    dueDate: loaded.dueDate,
    invoiceUrl: previewUrlForKind("invoice", loaded.shareToken),
    message: PLACEHOLDER_MESSAGE,
  };
}

function realInvoiceReceiptInput(
  loaded: LoadedInvoiceReceipt
): SendInvoiceReceiptEmailInput {
  return {
    to: "",
    customerName: loaded.customerName || SAMPLE.customerName,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    amountPaid: loaded.amountPaid,
    balanceDue: loaded.balanceDue,
    paidAt: loaded.paidAt,
    invoiceUrl: previewUrlForKind("invoice_receipt", loaded.shareToken),
  };
}

function realChangeOrderInput(
  loaded: LoadedChangeOrder
): SendChangeOrderEmailInput {
  return {
    to: "",
    customerName: loaded.customerName || SAMPLE.customerName,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    coNumber: loaded.coNumber ?? null,
    title: loaded.title,
    amount: loaded.amount,
    isCredit: loaded.isCredit,
    changeOrderUrl: previewUrlForKind("change_order", loaded.shareToken),
    message: PLACEHOLDER_MESSAGE,
  };
}

function realSubmittalInput(loaded: LoadedSubmittal): SendSubmittalEmailInput {
  return {
    to: "",
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    submittalNumber: loaded.submittalNumber ?? null,
    title: loaded.title,
    csiSection: loaded.csiSection ?? null,
    submittalUrl: previewUrlForKind("submittal", loaded.shareToken),
    message: PLACEHOLDER_MESSAGE,
  };
}

function realClientPortalMagicLinkInput(
  loaded: LoadedCustomerMagicLink
): SendClientPortalMagicLinkInput {
  return {
    to: "",
    clientName: loaded.clientName || SAMPLE.customerName,
    orgName: loaded.orgName,
    signInLink: PLACEHOLDER_SIGN_IN_LINK,
  };
}

// Templated-event token set (mirrors SendCustomerEmailInput in
// customerNotifications.ts). Unknown keys render empty (renderTemplate).
function sampleTemplateVars(orgName: string): Record<string, string> {
  return {
    customer_name: SAMPLE.customerName,
    job_name: SAMPLE.lawnJobName,
    address: SAMPLE.address,
    service_date: SAMPLE.serviceDate,
    org_name: orgName,
    photo_link: `${publicBaseUrl()}/v/sample-photo-token`,
    review_link: "https://g.page/r/sample-review/edit",
  };
}

// Load the org's saved EMAIL template for an event — ACTIVE OR NOT. The preview
// tool is for seeing what's configured, so we intentionally do NOT filter on
// active (unlike customerNotifications.getTemplate, which skips inactive rows
// at send time). Returns null when no row exists yet.
async function loadSavedTemplate(
  supabase: SupabaseClient,
  organizationId: string,
  event: NotificationEvent
): Promise<{ subject: string | null; body: string } | null> {
  const { data } = await supabase
    .from("notification_templates")
    .select("subject, body")
    .eq("organization_id", organizationId)
    .eq("event", event)
    .eq("channel", "email")
    .maybeSingle();
  const t = data as { subject: string | null; body: string } | null;
  return t ?? null;
}

// Resolve the (subject, plain-text body) for a templated event. Returns BOTH
// the raw (un-substituted) copy — so the editor can show {{tokens}} intact —
// and the token-substituted copy that wraps into the HTML envelope. Uses the
// live-edited copy when provided (preview-as-you-type), else the saved
// template, else a clear placeholder so an unconfigured event still renders
// something useful instead of a blank pane.
async function resolveTemplated(
  ctx: RenderCtx,
  event: NotificationEvent,
  vars: Record<string, string>,
  orgName: string
): Promise<{
  rawSubject: string;
  rawBody: string;
  subject: string;
  body: string;
}> {
  const editing = ctx.editedBody !== undefined;
  // rawSubject/rawBody are the EDITOR values — the exact saved copy (empty
  // string when the DB subject is null), so saving the editor content never
  // writes the fallback label as if it were a real subject. The EVENT_LABEL
  // fallback is applied only to the rendered display subject below.
  let rawSubject: string;
  let rawBody: string;
  if (editing) {
    rawBody = ctx.editedBody ?? "";
    rawSubject = ctx.editedSubject ?? "";
  } else {
    const saved = await loadSavedTemplate(ctx.supabase, ctx.organizationId, event);
    if (saved) {
      rawBody = saved.body;
      rawSubject = saved.subject ?? "";
    } else {
      rawSubject = "";
      rawBody = `(No ${EVENT_LABEL[event].toLowerCase()} email template is saved yet — create one at Lawn → Notifications, then it will preview here.)`;
    }
  }
  return {
    rawSubject,
    rawBody,
    subject: renderTemplate(rawSubject || EVENT_LABEL[event], vars),
    body: renderTemplate(rawBody, vars),
  };
}

// Resolve the vars + orgName for a templated kind. When ctx.recordId is set,
// load the real visit and use its vars dict + orgName; otherwise (or when the
// visit is missing) fall back to the SAMPLE vars + ctx.orgName. The saved-vs-
// edited resolution inside resolveTemplated is unaffected — only the vars dict
// and orgName swap to real.
async function resolveTemplatedVars(
  ctx: RenderCtx
): Promise<{ vars: Record<string, string>; orgName: string }> {
  if (ctx.recordId) {
    const loaded = await loadVisitForTemplated(ctx.supabase, ctx.recordId);
    if (loaded) {
      return { vars: loaded.vars, orgName: loaded.orgName || ctx.orgName };
    }
  }
  return { vars: sampleTemplateVars(ctx.orgName), orgName: ctx.orgName };
}

function makeTemplatedKind(meta: EmailKindMeta): EmailKind {
  const event = meta.id as NotificationEvent;
  return {
    ...meta,
    render: async (ctx) => {
      const { vars, orgName } = await resolveTemplatedVars(ctx);
      const { rawSubject, rawBody, subject, body } = await resolveTemplated(
        ctx,
        event,
        vars,
        orgName
      );
      const { html } = renderCustomerEmailHtml({
        to: "",
        subject,
        body,
        orgName,
      });
      return { subject, html, rawSubject, rawBody };
    },
    sendTest: async (toEmail, ctx) => {
      const { vars, orgName } = await resolveTemplatedVars(ctx);
      const { subject, body } = await resolveTemplated(ctx, event, vars, orgName);
      return sendCustomerEmail({
        to: toEmail,
        subject,
        body,
        orgName,
      });
    },
  };
}

function sampleEstimateInput(
  orgName: string
): SendEstimateEmailInput {
  return {
    to: "",
    customerName: SAMPLE.customerName,
    orgName,
    jobName: SAMPLE.jobName,
    estimateNumber: SAMPLE.estimateNumber,
    total: SAMPLE.total,
    validUntil: SAMPLE.validUntil,
    estimateUrl: sampleEstimateUrl(),
    message: SAMPLE.estimateMessage,
  };
}

function sampleInvoiceInput(
  orgName: string
): SendInvoiceEmailInput {
  return {
    to: "",
    customerName: SAMPLE.customerName,
    orgName,
    jobName: SAMPLE.jobName,
    total: SAMPLE.total,
    balanceDue: SAMPLE.balanceDue,
    dueDate: SAMPLE.dueDate,
    invoiceUrl: sampleInvoiceUrl(),
    message: SAMPLE.invoiceMessage,
  };
}

function sampleInvoiceReceiptInput(
  orgName: string
): SendInvoiceReceiptEmailInput {
  return {
    to: "",
    customerName: SAMPLE.customerName,
    orgName,
    jobName: SAMPLE.jobName,
    amountPaid: SAMPLE.amountPaid,
    balanceDue: "$0.00",
    paidAt: SAMPLE.paidAt,
    invoiceUrl: sampleInvoiceUrl(),
  };
}

function sampleChangeOrderInput(
  orgName: string
): SendChangeOrderEmailInput {
  return {
    to: "",
    customerName: SAMPLE.customerName,
    orgName,
    jobName: SAMPLE.jobName,
    coNumber: SAMPLE.coNumber,
    title: SAMPLE.coTitle,
    amount: SAMPLE.coAmount,
    isCredit: false,
    changeOrderUrl: sampleChangeOrderUrl(),
    message: SAMPLE.coMessage,
  };
}

function sampleSubmittalInput(
  orgName: string
): SendSubmittalEmailInput {
  return {
    to: "",
    orgName,
    jobName: SAMPLE.jobName,
    submittalNumber: SAMPLE.submittalNumber,
    title: SAMPLE.submittalTitle,
    csiSection: SAMPLE.csiSection,
    submittalUrl: sampleSubmittalUrl(),
    message: SAMPLE.submittalMessage,
  };
}

function sampleClientPortalMagicLinkInput(
  orgName: string
): SendClientPortalMagicLinkInput {
  return {
    to: "",
    clientName: SAMPLE.customerName,
    orgName,
    signInLink: sampleSignInLink(),
  };
}

function samplePasswordResetInput(
  _orgName: string
): SendPasswordResetEmailInput {
  return {
    to: "",
    resetLink: sampleResetLink(),
  };
}

function sampleVerificationInput(
  _orgName: string
): SendVerificationEmailInput {
  return {
    to: "",
    name: SAMPLE.customerName,
    verifyLink: sampleVerifyLink(),
  };
}

// ── The registry ────────────────────────────────────────────────────────────
// Built from the client-safe EMAIL_KIND_META (single source for the list +
// metadata) with the server-only render/sendTest fns attached by id.

// Per-kind real-data loaders: when ctx.recordId is set, load the matching
// record and build the render input from its real fields; return null when
// recordId is unset OR the loader found nothing (deleted/missing) so the caller
// falls back to the SAMPLE path.
async function maybeRealEstimateInput(
  ctx: RenderCtx
): Promise<SendEstimateEmailInput | null> {
  if (!ctx.recordId) return null;
  const loaded = await loadEstimateForEmail(ctx.supabase, ctx.recordId);
  return loaded ? realEstimateInput(loaded) : null;
}
async function maybeRealInvoiceInput(
  ctx: RenderCtx
): Promise<SendInvoiceEmailInput | null> {
  if (!ctx.recordId) return null;
  const loaded = await loadInvoiceForEmail(ctx.supabase, ctx.recordId);
  return loaded ? realInvoiceInput(loaded) : null;
}
async function maybeRealInvoiceReceiptInput(
  ctx: RenderCtx
): Promise<SendInvoiceReceiptEmailInput | null> {
  if (!ctx.recordId) return null;
  const loaded = await loadInvoiceReceiptForEmail(ctx.supabase, ctx.recordId);
  return loaded ? realInvoiceReceiptInput(loaded) : null;
}
async function maybeRealChangeOrderInput(
  ctx: RenderCtx
): Promise<SendChangeOrderEmailInput | null> {
  if (!ctx.recordId) return null;
  const loaded = await loadChangeOrderForEmail(ctx.supabase, ctx.recordId);
  return loaded ? realChangeOrderInput(loaded) : null;
}
async function maybeRealSubmittalInput(
  ctx: RenderCtx
): Promise<SendSubmittalEmailInput | null> {
  if (!ctx.recordId) return null;
  const loaded = await loadSubmittalForEmail(ctx.supabase, ctx.recordId);
  return loaded ? realSubmittalInput(loaded) : null;
}
async function maybeRealClientPortalMagicLinkInput(
  ctx: RenderCtx
): Promise<SendClientPortalMagicLinkInput | null> {
  if (!ctx.recordId) return null;
  const loaded = await loadCustomerForMagicLink(ctx.supabase, ctx.recordId);
  return loaded ? realClientPortalMagicLinkInput(loaded) : null;
}

function buildKind(meta: EmailKindMeta): EmailKind {
  switch (meta.id) {
    case "estimate":
      return {
        ...meta,
        render: async (ctx) => {
          const real = await maybeRealEstimateInput(ctx);
          return renderEstimateEmail(real ?? sampleEstimateInput(ctx.orgName));
        },
        sendTest: async (toEmail, ctx) => {
          // sendEstimateEmail THROWS on missing RESEND_API_KEY (by design — the
          // estimate route wants a hard 500). For a test-send we surface that as
          // a normal { error } so the preview UI can toast it instead of throwing.
          // `to` is ALWAYS the signed-in user's own email (test-send never goes
          // to the real customer's loaded.to).
          try {
            const real = await maybeRealEstimateInput(ctx);
            return await sendEstimateEmail({
              ...(real ?? sampleEstimateInput(ctx.orgName)),
              to: toEmail,
            });
          } catch (err) {
            return {
              data: null,
              error: {
                message: err instanceof Error ? err.message : "email send failed",
              },
            };
          }
        },
      };
    case "invoice":
      return {
        ...meta,
        render: async (ctx) => {
          const real = await maybeRealInvoiceInput(ctx);
          return renderInvoiceEmail(real ?? sampleInvoiceInput(ctx.orgName));
        },
        sendTest: async (toEmail, ctx) => {
          const real = await maybeRealInvoiceInput(ctx);
          return sendInvoiceEmail({
            ...(real ?? sampleInvoiceInput(ctx.orgName)),
            to: toEmail,
          });
        },
      };
    case "invoice_receipt":
      return {
        ...meta,
        render: async (ctx) => {
          const real = await maybeRealInvoiceReceiptInput(ctx);
          return renderInvoiceReceiptEmail(
            real ?? sampleInvoiceReceiptInput(ctx.orgName)
          );
        },
        sendTest: async (toEmail, ctx) => {
          const real = await maybeRealInvoiceReceiptInput(ctx);
          return sendInvoiceReceiptEmail({
            ...(real ?? sampleInvoiceReceiptInput(ctx.orgName)),
            to: toEmail,
          });
        },
      };
    case "change_order":
      return {
        ...meta,
        render: async (ctx) => {
          const real = await maybeRealChangeOrderInput(ctx);
          return renderChangeOrderEmail(
            real ?? sampleChangeOrderInput(ctx.orgName)
          );
        },
        sendTest: async (toEmail, ctx) => {
          const real = await maybeRealChangeOrderInput(ctx);
          return sendChangeOrderEmail({
            ...(real ?? sampleChangeOrderInput(ctx.orgName)),
            to: toEmail,
          });
        },
      };
    case "submittal":
      return {
        ...meta,
        render: async (ctx) => {
          const real = await maybeRealSubmittalInput(ctx);
          return renderSubmittalEmail(real ?? sampleSubmittalInput(ctx.orgName));
        },
        sendTest: async (toEmail, ctx) => {
          const real = await maybeRealSubmittalInput(ctx);
          return sendSubmittalEmail({
            ...(real ?? sampleSubmittalInput(ctx.orgName)),
            to: toEmail,
          });
        },
      };
    case "client_portal_magic_link":
      return {
        ...meta,
        render: async (ctx) => {
          const real = await maybeRealClientPortalMagicLinkInput(ctx);
          return renderClientPortalMagicLink(
            real ?? sampleClientPortalMagicLinkInput(ctx.orgName)
          );
        },
        sendTest: async (toEmail, ctx) => {
          const real = await maybeRealClientPortalMagicLinkInput(ctx);
          return sendClientPortalMagicLink({
            ...(real ?? sampleClientPortalMagicLinkInput(ctx.orgName)),
            to: toEmail,
          });
        },
      };
    case "password_reset":
      return {
        ...meta,
        render: async (ctx) =>
          renderPasswordResetEmail(samplePasswordResetInput(ctx.orgName)),
        sendTest: async (toEmail, ctx) => {
          // sendPasswordResetEmail THROWS on missing RESEND_API_KEY (by design
          // — a reset email that never arrives is worse than a clear error).
          // For a test-send we surface that as a normal { error } so the
          // preview UI can toast it instead of throwing.
          try {
            return await sendPasswordResetEmail({
              ...samplePasswordResetInput(ctx.orgName),
              to: toEmail,
            });
          } catch (err) {
            return {
              data: null,
              error: {
                message: err instanceof Error ? err.message : "email send failed",
              },
            };
          }
        },
      };
    case "verification":
      return {
        ...meta,
        render: async (ctx) =>
          renderVerificationEmail(sampleVerificationInput(ctx.orgName)),
        sendTest: async (toEmail, ctx) => {
          // sendVerificationEmail THROWS on missing RESEND_API_KEY (by design
          // — the signup route treats a failed send as non-fatal). For a
          // test-send we surface that as a normal { error } so the preview UI
          // can toast it instead of throwing.
          try {
            return await sendVerificationEmail({
              ...sampleVerificationInput(ctx.orgName),
              to: toEmail,
            });
          } catch (err) {
            return {
              data: null,
              error: {
                message: err instanceof Error ? err.message : "email send failed",
              },
            };
          }
        },
      };
    default:
      // The 5 templated lawn visit-lifecycle events.
      return makeTemplatedKind(meta);
  }
}

export const EMAIL_KINDS: EmailKind[] = EMAIL_KIND_META.map(buildKind);

export function getKind(id: string): EmailKind | undefined {
  return EMAIL_KINDS.find((k) => k.id === id);
}

// List the real business records available for the Sample/Real picker for a
// given kind. Delegates to listRecordsForKind (emailLoaders) which is org-scoped
// (RLS session client) and returns the 50 most-recent rows. Returns [] for
// kinds with no real record (password_reset / verification) — the caller checks
// kind.realData before calling.
export async function listRecords(
  supabase: SupabaseClient,
  orgId: string,
  kindId: string
): Promise<PickerRecord[]> {
  return listRecordsForKind(kindId, supabase, orgId);
}