import type { SupabaseClient } from "@supabase/supabase-js";

// CRM lead pipeline — shared contract.
// ----------------------------------------------------------------------------
// Single source of truth for the lead stage/source vocab, the Lead row shape,
// and the cap-enforced lead→customer conversion. Both the office board
// (LeadsBoard / LeadDetailDrawer, built by Opus) and the public capture form
// (LeadCaptureForm, built by local AI) build against this. The server
// `/api/leads` POST and the `/admin/leads` shell also read LEAD_STAGES /
// LEAD_SOURCES from here so the form <select> options, the board columns, and
// the DB check constraint (leads.sql) never drift apart.
//
// Schema lives in leads.sql (status ∈ new|contacted|quoted|won|lost,
// source ∈ website|referral|google|other|manual). Mirror those literals here
// exactly — the DB rejects anything else.

export type LeadStatus = "new" | "contacted" | "quoted" | "won" | "lost";
export type LeadSource = "website" | "referral" | "google" | "other" | "manual";

/** Ordered pipeline stages the board renders as columns. `won`/`lost` are
 * terminal (no drag-out). Order is the column order, left→right. */
export const LEAD_STAGES: { value: LeadStatus; label: string; terminal: boolean }[] = [
  { value: "new", label: "New", terminal: false },
  { value: "contacted", label: "Contacted", terminal: false },
  { value: "quoted", label: "Quoted", terminal: false },
  { value: "won", label: "Won", terminal: true },
  { value: "lost", label: "Lost", terminal: true },
];

export const LEAD_SOURCES: { value: LeadSource; label: string }[] = [
  { value: "website", label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "google", label: "Google" },
  { value: "other", label: "Other" },
  { value: "manual", label: "Manual entry" },
];

export const LEAD_STATUS_VALUES = LEAD_STAGES.map((s) => s.value);
export const LEAD_SOURCE_VALUES = LEAD_SOURCES.map((s) => s.value);

/** Row shape the office board + drawer operate on. Matches the server select
 * in /admin/leads (keep the two in sync — both select these columns). */
export interface Lead {
  id: string;
  organization_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  service_interest: string | null;
  source: LeadSource;
  referral_detail: string | null;
  referred_by_customer_id: string | null;
  status: LeadStatus;
  assigned_to: string | null;
  notes: string | null;
  converted_customer_id: string | null;
  converted_at: string | null;
  created_at: string;
  created_by: string | null;
}

/** Public lead-form URL. The token is the only credential a logged-out
 * prospect presents (mirrors lawn_visits.share_token / the /v portal). Client
 * only — callers are in client components where window exists. */
export function leadFormUrl(token: string): string {
  return `${window.location.origin}/lead/${token}`;
}

/** Convert a lead into a customer. Two client operations through RLS — the
 * existing `guard_customer_create` trigger enforces the plan's customer cap at
 * the customer insert, so a free org converting lead #26 throws there (the
 * upgrade nudge; see the convert-at-wall decision). NOT atomic by design
 * (launch scope): if the lead status update fails after a successful customer
 * insert, you have a won customer with an un-marked lead — trivially fixable.
 * An atomic convert_lead() RPC is a noted optional refinement.
 *
 * @returns the new customer id on success, or an error message on failure. */
export async function convertLeadToCustomer(
  client: SupabaseClient,
  params: {
    leadId: string;
    orgId: string;
    /** Customer row, prefilled from the lead by the drawer. */
    name: string;
    contact_name?: string | null;
    contact_email?: string | null;
    phone?: string | null;
    address?: string | null;
    service_plan?: string | null;
    notes?: string | null;
  },
): Promise<{ customerId: string | null; error: string | null }> {
  // 1) Insert the customer. guard_customer_create throws on cap exceeded —
  //    PostgREST surfaces the raise_exception as an error here.
  const { data: inserted, error: insertError } = await client
    .from("customers")
    .insert({
      name: params.name,
      contact_name: params.contact_name ?? null,
      contact_email: params.contact_email ?? null,
      phone: params.phone ?? null,
      address: params.address ?? null,
      service_plan: params.service_plan ?? null,
      organization_id: params.orgId,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    // The cap trigger's message ("Customer limit reached") is the upgrade nudge
    // — surface it verbatim so the drawer can point the office at billing.
    return { customerId: null, error: insertError?.message ?? "Failed to create customer" };
  }

  // 2) Mark the lead won. Best-effort — the customer already exists; a failure
  //    here is a bookkeeping gap, not data loss. (See non-atomic note above.)
  const { error: updateError } = await client
    .from("leads")
    .update({
      status: "won",
      converted_customer_id: inserted.id,
      converted_at: new Date().toISOString(),
    })
    .eq("id", params.leadId);

  if (updateError) {
    // Don't roll back the customer — conversion succeeded, the lead just isn't
    // flagged. Return success with the gap noted.
    return { customerId: inserted.id, error: `Customer created but lead not marked won: ${updateError.message}` };
  }

  return { customerId: inserted.id, error: null };
}