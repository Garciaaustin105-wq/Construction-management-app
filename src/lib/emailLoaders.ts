// Server-only. Shared row-load + field-map for every customer-facing email that
// has a real business record, called by BOTH the live send paths AND the
// /admin/email-preview "preview with real data" feature. Single source of
// truth: because the preview and the send path call the SAME loader, the
// preview is guaranteed to match what ships — no drift.
//
// Each loader returns the render-input fields + shareToken + to (contact email)
// + organizationId + orgName + status, but NOT the portal URL. The caller
// builds the URL:
//   - send path: mints/rotates/persists a fresh token, uses the request host;
//   - preview: uses the EXISTING shareToken only (NEVER mints, so it can't
//     burn/rotate a real link) with publicBaseUrl(), and a clear placeholder
//     when no token exists yet.
//
// Loaders are client-agnostic: the send path passes whichever client it uses
// (RLS session for estimate/change-order/submittal; service-role for
// invoice/receipt); the preview passes the RLS session client so a preview is
// always org-scoped and can never leak another tenant's record.
//
// VALIDATION STAYS IN THE CALLER. Loaders are pure load+map — no status checks,
// no "customer has no email" guards, no side effects. The send routes keep
// their own validation; the preview doesn't want those gates.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeEstimateTotals, computeTotal, formatMoney } from "@/lib/money";
import {
  buildPhotoLink,
  buildReviewLink,
} from "@/lib/customerNotifications";

// ── helpers ─────────────────────────────────────────────────────────────────

async function loadOrgName(
  client: SupabaseClient,
  orgId: string | null
): Promise<string> {
  if (!orgId) return "";
  const { data: org } = await client
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();
  return (org as unknown as { name: string | null } | null)?.name ?? "";
}

function fmtDate(value: string | null): string | null {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : null;
}

// ── estimate ────────────────────────────────────────────────────────────────
// Mirrors src/app/api/estimates/[id]/send/route.ts:78-84,132-148,167-169,188-198.

export type LoadedEstimate = {
  organizationId: string | null;
  orgName: string;
  status: string;
  shareToken: string | null;
  customerId: string | null;
  to: string | null; // customer contact_email
  customerPhone: string | null;
  customerName: string;
  jobName: string;
  estimateNumber: string | null;
  total: string;
  validUntil: string | null;
};

export async function loadEstimateForEmail(
  client: SupabaseClient,
  id: string
): Promise<LoadedEstimate | null> {
  const { data: estimate } = await client
    .from("estimates")
    .select(
      "id, status, customer_id, organization_id, valid_until, estimate_number, title, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, share_token, jobs(name, address), customers(name, contact_email, phone)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!estimate) return null;

  const customer = estimate.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const jobName =
    (estimate.jobs as unknown as { name: string } | null)?.name ??
    (estimate.title as string | null) ??
    "your project";

  const { data: lineItems } = await client
    .from("estimate_line_items")
    .select("quantity, unit_price")
    .eq("estimate_id", id);
  const totals = computeEstimateTotals(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    })),
    {
      markupPct: Number(estimate.markup_pct) || 0,
      contingencyPct: Number(estimate.contingency_pct) || 0,
      taxPct: Number(estimate.tax_pct) || 0,
      depositPct: Number(estimate.deposit_pct) || 0,
      depositAmount: Number(estimate.deposit_amount) || 0,
    }
  );
  const hasPricing =
    totals.markupAmount > 0 ||
    totals.contingencyAmount > 0 ||
    totals.taxAmount > 0 ||
    totals.depositAmount > 0;
  const total = formatMoney(hasPricing ? totals.grandTotal : totals.subtotal);

  return {
    organizationId: (estimate.organization_id as string | null) ?? null,
    orgName: await loadOrgName(
      client,
      (estimate.organization_id as string | null) ?? null
    ),
    status: estimate.status as string,
    shareToken: (estimate.share_token as string | null) ?? null,
    customerId: (estimate.customer_id as string | null) ?? null,
    to: customer?.contact_email?.trim() || null,
    customerPhone: customer?.phone?.trim() || null,
    customerName: customer?.name ?? "",
    jobName,
    estimateNumber: (estimate.estimate_number as string | null) ?? null,
    total,
    validUntil: fmtDate((estimate.valid_until as string | null) ?? null),
  };
}

// ── invoice ─────────────────────────────────────────────────────────────────
// Mirrors src/lib/invoiceSend.ts:62-68,101-117,153-162.

export type LoadedInvoice = {
  organizationId: string | null;
  orgName: string;
  status: string;
  shareToken: string | null;
  to: string | null;
  customerPhone: string | null;
  customerName: string;
  jobName: string;
  total: string;
  balanceDue: string;
  dueDate: string | null;
};

export async function loadInvoiceForEmail(
  client: SupabaseClient,
  id: string
): Promise<LoadedInvoice | null> {
  const { data: invoice } = await client
    .from("invoices")
    .select(
      "id, status, customer_id, job_id, organization_id, amount_paid, due_date, share_token, jobs(name), customers(name, contact_email, phone)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return null;

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const jobName =
    (invoice.jobs as unknown as { name: string } | null)?.name ?? "your project";

  const { data: lineItems } = await client
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", id);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );
  const amountPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - amountPaid);

  return {
    organizationId: (invoice.organization_id as string | null) ?? null,
    orgName: await loadOrgName(
      client,
      (invoice.organization_id as string | null) ?? null
    ),
    status: invoice.status as string,
    shareToken: (invoice.share_token as string | null) ?? null,
    to: customer?.contact_email?.trim() || null,
    customerPhone: customer?.phone?.trim() || null,
    customerName: customer?.name ?? "",
    jobName,
    total: formatMoney(total),
    balanceDue: formatMoney(balanceDue),
    dueDate: fmtDate((invoice.due_date as string | null) ?? null),
  };
}

// ── invoice receipt ─────────────────────────────────────────────────────────
// Mirrors src/app/api/invoices/[id]/receipt/route.ts:92-98,123-132,151-164. A
// paid invoice is paid in full → amountPaid = total, balanceDue = $0.

export type LoadedInvoiceReceipt = {
  organizationId: string | null;
  orgName: string;
  status: string;
  shareToken: string | null;
  to: string | null;
  customerName: string;
  jobName: string;
  amountPaid: string;
  balanceDue: string;
  paidAt: string | null;
};

export async function loadInvoiceReceiptForEmail(
  client: SupabaseClient,
  id: string
): Promise<LoadedInvoiceReceipt | null> {
  const { data: invoice } = await client
    .from("invoices")
    .select(
      "id, status, organization_id, paid_at, share_token, jobs(name), customers(name, contact_email)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return null;

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null }
    | null;
  const jobName =
    (invoice.jobs as unknown as { name: string } | null)?.name ?? "your project";

  const { data: lineItems } = await client
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", id);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );

  return {
    organizationId: (invoice.organization_id as string | null) ?? null,
    orgName: await loadOrgName(
      client,
      (invoice.organization_id as string | null) ?? null
    ),
    status: invoice.status as string,
    shareToken: (invoice.share_token as string | null) ?? null,
    to: customer?.contact_email?.trim() || null,
    customerName: customer?.name ?? "",
    jobName,
    amountPaid: formatMoney(total),
    balanceDue: formatMoney(0),
    paidAt: invoice.paid_at
      ? new Date(invoice.paid_at as string).toLocaleDateString()
      : null,
  };
}

// ── change order ────────────────────────────────────────────────────────────
// Mirrors src/app/api/change-orders/[id]/send/route.ts:67-73,86-91,115-126.
// Customer reached THROUGH the job (change_orders has no customer_id).

export type LoadedChangeOrder = {
  organizationId: string | null;
  orgName: string;
  status: string;
  shareToken: string | null;
  to: string | null;
  customerName: string;
  jobName: string;
  coNumber: string | null;
  title: string;
  amount: string;
  isCredit: boolean;
};

export async function loadChangeOrderForEmail(
  client: SupabaseClient,
  id: string
): Promise<LoadedChangeOrder | null> {
  const { data: co } = await client
    .from("change_orders")
    .select(
      "id, status, organization_id, co_number, title, amount, is_credit, share_token, jobs(name, customers(name, contact_email))"
    )
    .eq("id", id)
    .maybeSingle();
  if (!co) return null;

  const jobRow = co.jobs as unknown as
    | {
        name: string | null;
        customers: {
          name: string | null;
          contact_email: string | null;
        } | null;
      }
    | null;
  const jobName = jobRow?.name ?? (co.title as string | null) ?? "your project";
  const customer = jobRow?.customers ?? null;

  return {
    organizationId: (co.organization_id as string | null) ?? null,
    orgName: await loadOrgName(
      client,
      (co.organization_id as string | null) ?? null
    ),
    status: co.status as string,
    shareToken: (co.share_token as string | null) ?? null,
    to: customer?.contact_email?.trim() || null,
    customerName: customer?.name ?? "",
    jobName,
    coNumber: (co.co_number as string | null) ?? null,
    title: co.title as string,
    amount: formatMoney(Number(co.amount) || 0),
    isCredit: !!co.is_credit,
  };
}

// ── submittal ───────────────────────────────────────────────────────────────
// Mirrors src/app/api/submittals/[id]/send/route.ts:72-78,91-94,111-120.
// No customer/reviewer column — the reviewer email is supplied by the caller at
// send time, so there is no `to` here.

export type LoadedSubmittal = {
  organizationId: string | null;
  orgName: string;
  status: string;
  shareToken: string | null;
  jobName: string;
  submittalNumber: string | null;
  title: string;
  csiSection: string | null;
};

export async function loadSubmittalForEmail(
  client: SupabaseClient,
  id: string
): Promise<LoadedSubmittal | null> {
  const { data: submittal } = await client
    .from("submittals")
    .select(
      "id, status, organization_id, submittal_number, title, csi_section, share_token, jobs(name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!submittal) return null;

  const jobName =
    (submittal.jobs as unknown as { name: string } | null)?.name ??
    (submittal.title as string | null) ??
    "the project";

  return {
    organizationId: (submittal.organization_id as string | null) ?? null,
    orgName: await loadOrgName(
      client,
      (submittal.organization_id as string | null) ?? null
    ),
    status: submittal.status as string,
    shareToken: (submittal.share_token as string | null) ?? null,
    jobName,
    submittalNumber: (submittal.submittal_number as string | null) ?? null,
    title: submittal.title as string,
    csiSection: (submittal.csi_section as string | null) ?? null,
  };
}

// ── client portal magic link ────────────────────────────────────────────────
// The customer IS a real record (clientName + orgName + to come from
// `customers`). signInLink is NOT a stored column — it's a Supabase
// generateLink action_link created at send time (has side effects), so the
// preview uses a placeholder link. Only the customer-facing fields are loaded
// here; the caller builds signInLink (send) or a placeholder (preview).

export type LoadedCustomerMagicLink = {
  organizationId: string | null;
  orgName: string;
  to: string | null;
  clientName: string;
};

export async function loadCustomerForMagicLink(
  client: SupabaseClient,
  customerId: string
): Promise<LoadedCustomerMagicLink | null> {
  const { data: c } = await client
    .from("customers")
    .select("id, name, contact_email, organization_id")
    .eq("id", customerId)
    .maybeSingle();
  if (!c) return null;

  const organizationId = (c.organization_id as string | null) ?? null;
  return {
    organizationId,
    orgName: await loadOrgName(client, organizationId),
    to: (c.contact_email as string | null)?.trim() || null,
    clientName: (c.name as string | null) ?? "",
  };
}

// ── templated (lawn visit-lifecycle) ────────────────────────────────────────
// Mirrors the visit→token mapping in
// src/app/api/lawn/visits/[id]/status/route.ts:170-216,248-256. service_date is
// the RAW lawn_visits.due_date (the real send passes it raw, so the preview
// does too — drift-proof). photo_link from buildPhotoLink(share_token);
// review_link from buildReviewLink (org's google_review_url, or "").

export type LoadedVisitTemplated = {
  organizationId: string | null;
  orgName: string;
  shareToken: string | null;
  to: string | null; // customer contact_email (test-send override only)
  vars: Record<string, string>;
};

export async function loadVisitForTemplated(
  client: SupabaseClient,
  visitId: string
): Promise<LoadedVisitTemplated | null> {
  const { data: visit } = await client
    .from("lawn_visits")
    .select("id, due_date, share_token, organization_id, job_id")
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) return null;

  const organizationId = (visit.organization_id as string | null) ?? null;

  const { data: job } = await client
    .from("jobs")
    .select("customer_id, name, address, organization_id")
    .eq("id", visit.job_id as string)
    .maybeSingle();
  const jobRow = job as unknown as
    | {
        customer_id: string | null;
        name: string | null;
        address: string | null;
        organization_id: string | null;
      }
    | null;

  const customerId = jobRow?.customer_id ?? null;
  let customerName = "";
  let to: string | null = null;
  if (customerId) {
    const { data: cust } = await client
      .from("customers")
      .select("name, contact_email")
      .eq("id", customerId)
      .maybeSingle();
    const c = cust as unknown as
      | { name: string | null; contact_email: string | null }
      | null;
    customerName = c?.name ?? "";
    to = c?.contact_email?.trim() || null;
  }

  const orgId = organizationId ?? jobRow?.organization_id ?? null;
  const orgName = await loadOrgName(client, orgId);
  const photoLink = buildPhotoLink(
    (visit.share_token as string | null) ?? null
  );
  const reviewLink = orgId ? await buildReviewLink(client, orgId) : null;

  return {
    organizationId: orgId,
    orgName,
    shareToken: (visit.share_token as string | null) ?? null,
    to,
    vars: {
      customer_name: customerName,
      job_name: jobRow?.name ?? "",
      address: jobRow?.address ?? "",
      service_date: (visit.due_date as string | null) ?? "",
      org_name: orgName,
      photo_link: photoLink,
      review_link: reviewLink ?? "",
    },
  };
}

// ── record pickers (for the Sample/Real dropdown) ───────────────────────────
// Org-scoped lists (caller passes the RLS session client + orgId). Recent 50.

export type PickerRecord = { id: string; label: string };

export async function listEstimates(
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  const { data } = await client
    .from("estimates")
    .select("id, estimate_number, title, jobs(name)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((r) => {
    const jobName = (r.jobs as unknown as { name: string | null } | null)?.name;
    return {
      id: r.id as string,
      label: [r.estimate_number || r.title || "Estimate", jobName]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

export async function listInvoices(
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  const { data } = await client
    .from("invoices")
    .select("id, status, due_date, jobs(name)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((r) => {
    const jobName = (r.jobs as unknown as { name: string | null } | null)?.name;
    return {
      id: r.id as string,
      label: [
        r.status,
        jobName,
        r.due_date ? fmtDate(r.due_date as string) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

export async function listChangeOrders(
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  const { data } = await client
    .from("change_orders")
    .select("id, co_number, title, jobs(name)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((r) => {
    const jobName = (r.jobs as unknown as { name: string | null } | null)?.name;
    return {
      id: r.id as string,
      label: [r.co_number || r.title || "Change order", jobName]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

export async function listSubmittals(
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  const { data } = await client
    .from("submittals")
    .select("id, submittal_number, title, jobs(name)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((r) => {
    const jobName = (r.jobs as unknown as { name: string | null } | null)?.name;
    return {
      id: r.id as string,
      label: [r.submittal_number || r.title || "Submittal", jobName]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

export async function listCustomers(
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  const { data } = await client
    .from("customers")
    .select("id, name, contact_email")
    .eq("organization_id", orgId)
    .order("name", { ascending: true })
    .limit(50);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    label: [r.name || "Customer", r.contact_email].filter(Boolean).join(" · "),
  }));
}

export async function listVisits(
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  const { data } = await client
    .from("lawn_visits")
    .select("id, due_date, jobs(name)")
    .eq("organization_id", orgId)
    .order("due_date", { ascending: false })
    .limit(50);
  return (data ?? []).map((r) => {
    const jobName = (r.jobs as unknown as { name: string | null } | null)?.name;
    return {
      id: r.id as string,
      label: [r.due_date ? fmtDate(r.due_date as string) : "Visit", jobName]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

// Dispatch: which list fn + which loader applies to a given email kind id.
// password_reset + verification have NO real record (auth-flow emails) → null.

export type RealDataKind =
  | "estimate"
  | "invoice"
  | "invoice_receipt"
  | "change_order"
  | "submittal"
  | "client_portal_magic_link"
  | "visit_reminder"
  | "on_my_way"
  | "service_complete"
  | "service_skipped"
  | "review_request";

export async function listRecordsForKind(
  kindId: string,
  client: SupabaseClient,
  orgId: string
): Promise<PickerRecord[]> {
  switch (kindId) {
    case "estimate":
      return listEstimates(client, orgId);
    case "invoice":
    case "invoice_receipt":
      return listInvoices(client, orgId);
    case "change_order":
      return listChangeOrders(client, orgId);
    case "submittal":
      return listSubmittals(client, orgId);
    case "client_portal_magic_link":
      return listCustomers(client, orgId);
    case "visit_reminder":
    case "on_my_way":
    case "service_complete":
    case "service_skipped":
    case "review_request":
      return listVisits(client, orgId);
    default:
      return []; // password_reset, verification — no real record
  }
}