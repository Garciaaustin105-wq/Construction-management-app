// Client-safe metadata for the customer-facing email kinds.
//
// This file has NO server-only imports (no Resend, no Supabase) so the
// /admin/email-preview client UI can import it to render the left-hand kind
// list + token hints without pulling server code into the client bundle. The
// server registry (emailPreview.ts) imports this too and attaches the
// render/sendTest functions to build the full EMAIL_KINDS.
//
// Keep this list in sync with EMAIL_KINDS in emailPreview.ts — the registry
// attaches fns by id, so an id here with no matching builder is a bug.

export type EmailVariant = "construction" | "lawn" | "both";

export type EmailKindMeta = {
  id: string;
  label: string;
  variant: EmailVariant;
  audience: "customer" | "office";
  // true => the editor (subject/body textareas) is shown. Templated kinds only.
  editable: boolean;
  // Token names this template supports — shown as hints in the editor.
  tokens?: string[];
  // When set, the preview UI offers a Sample | Real toggle and a record picker
  // so the office can preview the email against a real business record instead
  // of sample data. Absent for auth-flow emails (password_reset / verification)
  // which have no business record to pick.
  realData?: {
    entityType:
      | "estimate"
      | "invoice"
      | "change_order"
      | "submittal"
      | "customer"
      | "visit";
    pickerLabel: string;
  };
};

// The 5 templated lawn visit-lifecycle events (ids match NotificationEvent in
// customerNotifications.ts). Duplicated as a plain string union here so this
// file stays free of the server-only customerNotifications import.
export type NotificationEventId =
  | "visit_reminder"
  | "on_my_way"
  | "service_complete"
  | "service_skipped"
  | "review_request"
  | "schedule_confirmed";

// Token set the templated events support (mirrors SendCustomerEmailInput in
// customerNotifications.ts). Shown as copy-paste hints in the editor. Note
// {{service_date}} already embeds the arrival window when one is set (the remind
// route builds "Aug 23, 2026 between 9:00 AM - 11:00 AM"), so {{arrival_window}}
// is only needed if you want the window separate from the date. {{reason}} is
// service_skipped-only (defaults to "N/A" when no reason was recorded).
export const TEMPLATE_TOKENS = [
  "customer_name",
  "job_name",
  "address",
  "service_date",
  "arrival_window",
  "org_name",
  "photo_link",
  "review_link",
  "reason",
  // schedule_confirmed only — one line per active recurring schedule on the
  // job (e.g. "Mow & edge: Weekly · Mon · from Sep 15"). Renders empty on
  // every other event, same as any unused token.
  "schedule_summary",
];

// Human label for a templated event when no saved subject exists.
export const EVENT_LABEL: Record<NotificationEventId, string> = {
  visit_reminder: "Visit reminder",
  on_my_way: "On my way",
  service_complete: "Service complete",
  service_skipped: "Visit skipped",
  review_request: "Review request",
  schedule_confirmed: "Schedule confirmed",
};

export const EMAIL_KIND_META: EmailKindMeta[] = [
  // Templated (lawn-only, editable)
  {
    id: "visit_reminder",
    label: "Visit Reminder",
    variant: "lawn",
    audience: "customer",
    editable: true,
    tokens: TEMPLATE_TOKENS,
    realData: { entityType: "visit", pickerLabel: "Pick a visit" },
  },
  {
    id: "on_my_way",
    label: "On My Way",
    variant: "lawn",
    audience: "customer",
    editable: true,
    tokens: TEMPLATE_TOKENS,
    realData: { entityType: "visit", pickerLabel: "Pick a visit" },
  },
  {
    id: "service_complete",
    label: "Service Complete",
    variant: "lawn",
    audience: "customer",
    editable: true,
    tokens: TEMPLATE_TOKENS,
    realData: { entityType: "visit", pickerLabel: "Pick a visit" },
  },
  {
    id: "service_skipped",
    label: "Visit Skipped",
    variant: "lawn",
    audience: "customer",
    editable: true,
    tokens: TEMPLATE_TOKENS,
    realData: { entityType: "visit", pickerLabel: "Pick a visit" },
  },
  {
    id: "review_request",
    label: "Review Request",
    variant: "lawn",
    audience: "customer",
    editable: true,
    tokens: TEMPLATE_TOKENS,
    realData: { entityType: "visit", pickerLabel: "Pick a visit" },
  },
  {
    id: "schedule_confirmed",
    label: "Schedule Confirmed",
    variant: "lawn",
    audience: "customer",
    editable: true,
    tokens: TEMPLATE_TOKENS,
    // No realData: this fires off a recurring_schedules row, not a visit, and
    // there's no "real record" loader for schedules (sample preview only —
    // same pattern the auth-flow kinds already use).
  },
  // Fixed copy (preview + test only; available on both variants — construction
  // sends estimate/invoice emails, lawn sends invoice emails via cycle billing)
  {
    id: "estimate",
    label: "Estimate",
    variant: "both",
    audience: "customer",
    editable: false,
    realData: { entityType: "estimate", pickerLabel: "Pick an estimate" },
  },
  {
    id: "invoice",
    label: "Invoice",
    variant: "both",
    audience: "customer",
    editable: false,
    realData: { entityType: "invoice", pickerLabel: "Pick an invoice" },
  },
  {
    id: "invoice_receipt",
    label: "Invoice Receipt",
    variant: "both",
    audience: "customer",
    editable: false,
    realData: { entityType: "invoice", pickerLabel: "Pick a paid invoice" },
  },
  {
    id: "change_order",
    label: "Change Order",
    variant: "construction",
    audience: "customer",
    editable: false,
    realData: { entityType: "change_order", pickerLabel: "Pick a change order" },
  },
  {
    id: "submittal",
    label: "Submittal",
    variant: "construction",
    audience: "customer",
    editable: false,
    realData: { entityType: "submittal", pickerLabel: "Pick a submittal" },
  },
  {
    id: "client_portal_magic_link",
    label: "Client Portal Invite",
    variant: "construction",
    audience: "customer",
    editable: false,
    realData: { entityType: "customer", pickerLabel: "Pick a client" },
  },
  {
    id: "password_reset",
    label: "Password Reset",
    variant: "both",
    audience: "customer",
    editable: false,
  },
  {
    id: "verification",
    label: "Verify Email",
    variant: "both",
    audience: "customer",
    editable: false,
  },
  // NOTE: sendOnMyWayEmail + sendLawnVisitEmail (email.ts) are DEAD CODE — no
  // call sites; the live "on my way" / "service complete" customer emails are
  // the TEMPLATED on_my_way / service_complete events above (fired by
  // sendCustomerNotification from the visit status routes). They are intentionally
  // NOT registered here: registering them would duplicate the templated kinds
  // (and "on_my_way" would collide with the templated id, breaking its preview).
];