// Server-only. Builds immutable send-time snapshots archived in the
// `estimate_sends` / `change_order_sends` tables (see the `send_snapshots`
// migration). A snapshot is the liability source of truth: it records EXACTLY
// what the customer received at send time — the same column set the public
// /q/{token} (estimate) and /co/{token} (change order) pages render — so even
// if the office later edits the live row, there is a permanent record of the
// original terms the customer saw/approved.
//
// Pure reads: the caller passes the service-role admin client (snapshot reads
// bypass customer RLS and must see office-only columns safely — only
// customer-safe columns are selected into the snapshot, matching the public
// portal pages exactly). The send routes do the 1-line `insert` inline so the
// archive write stays visible at the call site (matches changeOrderInvoice.ts).
//
// The exported TS types are the single shape shared by the send routes, the
// send-history components, and the snapshot view pages (drift-proof, like
// emailLoaders.ts). Do not hand-roll a snapshot shape elsewhere — import these.

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Estimate snapshot (mirrors /q/[token]) ───────────────────────────────────
// Customer-safe only: NO cost_code_id, NO internal_cost, NO note, NO viewed_at.
export type EstimateSnapshotItem = {
  description: string | null;
  quantity: number;
  unit_price: number;
  position: number;
  section: string | null;
  schedule_frequency: string | null;
  schedule_days_of_week: number[];
  schedule_day_of_month: number | null;
  schedule_start_date: string | null;
  schedule_end_date: string | null;
};

export type EstimateSnapshot = {
  estimate: {
    title: string | null;
    customer_notes: string | null;
    valid_until: string | null;
    sent_at: string | null;
    approved_at: string | null;
    rejected_at: string | null;
    estimate_number: string | null;
    markup_pct: number;
    contingency_pct: number;
    tax_pct: number;
    deposit_pct: number;
    deposit_amount: number;
    exclusions: string | null;
    terms: string | null;
    payment_schedule: string | null;
    show_itemized: boolean;
  };
  items: EstimateSnapshotItem[];
  org: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    logo_path: string | null;
  };
  job: { name: string | null; address: string | null } | null;
  customer: { name: string | null; address: string | null } | null;
};

// ── Change-order snapshot (mirrors /co/[token]) ─────────────────────────────
export type CoSnapshotLine = {
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  position: number;
  cost_code: { code: string | null; name: string | null } | null;
};

export type CoSnapshot = {
  change_order: {
    title: string;
    description: string | null;
    reason: string | null;
    amount: number;
    is_credit: boolean;
    co_number: string | null;
    sent_at: string | null;
  };
  lines: CoSnapshotLine[];
  org: { name: string; email: string | null };
  job: { name: string | null } | null;
};

// ── Builders ───────────────────────────────────────────────────────────────
// Both return null on a not-found / unreadable row so the send route can 500
// (snapshot-first: a send that can't be archived must not be marked sent).

export async function buildEstimateSnapshot(
  admin: SupabaseClient,
  estimateId: string
): Promise<EstimateSnapshot | null> {
  const { data: est } = await admin
    .from("estimates")
    .select(
      "id, title, customer_notes, valid_until, sent_at, approved_at, rejected_at, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, exclusions, terms, payment_schedule, show_itemized, organization_id, jobs(name, address), customers(name, address)"
    )
    .eq("id", estimateId)
    .maybeSingle();
  if (!est) return null;

  const { data: lineRows } = await admin
    .from("estimate_line_items")
    .select(
      "id, description, quantity, unit_price, position, section, schedule_frequency, schedule_days_of_week, schedule_day_of_month, schedule_start_date, schedule_end_date"
    )
    .eq("estimate_id", estimateId)
    .order("position");

  const orgId = (est.organization_id as string | null) ?? null;
  let org: EstimateSnapshot["org"] = {
    name: "",
    address: null,
    phone: null,
    email: null,
    logo_path: null,
  };
  if (orgId) {
    const { data: o } = await admin
      .from("organizations")
      .select("name, address, phone, email, logo_path")
      .eq("id", orgId)
      .maybeSingle();
    if (o) {
      org = {
        name: (o.name as string) ?? "",
        address: (o.address as string | null) ?? null,
        phone: (o.phone as string | null) ?? null,
        email: (o.email as string | null) ?? null,
        logo_path: (o.logo_path as string | null) ?? null,
      };
    }
  }

  const jobRow = est.jobs as unknown as
    | { name: string | null; address: string | null }
    | null;
  const custRow = est.customers as unknown as
    | { name: string | null; address: string | null }
    | null;

  const items: EstimateSnapshotItem[] = (
    (lineRows ?? []) as {
      description: string | null;
      quantity: string | number;
      unit_price: string | number;
      position: number;
      section: string | null;
      schedule_frequency: string | null;
      schedule_days_of_week: number[] | null;
      schedule_day_of_month: number | null;
      schedule_start_date: string | null;
      schedule_end_date: string | null;
    }[]
  ).map((r) => ({
    description: r.description ?? null,
    quantity: Number(r.quantity) || 0,
    unit_price: Number(r.unit_price) || 0,
    position: r.position,
    section: r.section ?? null,
    schedule_frequency: r.schedule_frequency ?? null,
    schedule_days_of_week: r.schedule_days_of_week ?? [],
    schedule_day_of_month: r.schedule_day_of_month ?? null,
    schedule_start_date: r.schedule_start_date ?? null,
    schedule_end_date: r.schedule_end_date ?? null,
  }));

  return {
    estimate: {
      title: (est.title as string | null) ?? null,
      customer_notes: (est.customer_notes as string | null) ?? null,
      valid_until: (est.valid_until as string | null) ?? null,
      sent_at: (est.sent_at as string | null) ?? null,
      approved_at: (est.approved_at as string | null) ?? null,
      rejected_at: (est.rejected_at as string | null) ?? null,
      estimate_number: (est.estimate_number as string | null) ?? null,
      markup_pct: Number(est.markup_pct) || 0,
      contingency_pct: Number(est.contingency_pct) || 0,
      tax_pct: Number(est.tax_pct) || 0,
      deposit_pct: Number(est.deposit_pct) || 0,
      deposit_amount: Number(est.deposit_amount) || 0,
      exclusions: (est.exclusions as string | null) ?? null,
      terms: (est.terms as string | null) ?? null,
      payment_schedule: (est.payment_schedule as string | null) ?? null,
      show_itemized: (est.show_itemized as boolean | null) ?? true,
    },
    items,
    org,
    job: jobRow ? { name: jobRow.name, address: jobRow.address } : null,
    customer: custRow ? { name: custRow.name, address: custRow.address } : null,
  };
}

export async function buildChangeOrderSnapshot(
  admin: SupabaseClient,
  coId: string
): Promise<CoSnapshot | null> {
  const { data: co } = await admin
    .from("change_orders")
    .select(
      "id, title, description, reason, amount, is_credit, co_number, sent_at, organization_id, jobs(name)"
    )
    .eq("id", coId)
    .maybeSingle();
  if (!co) return null;

  const { data: lineRows } = await admin
    .from("change_order_lines")
    .select(
      "id, description, quantity, unit, unit_price, position, cost_codes(code, name)"
    )
    .eq("change_order_id", coId)
    .order("position");

  const orgId = (co.organization_id as string | null) ?? null;
  let org: CoSnapshot["org"] = { name: "", email: null };
  if (orgId) {
    const { data: o } = await admin
      .from("organizations")
      .select("name, email")
      .eq("id", orgId)
      .maybeSingle();
    if (o) {
      org = {
        name: (o.name as string) ?? "",
        email: (o.email as string | null)?.trim() || null,
      };
    }
  }

  const jobRow = co.jobs as unknown as { name: string | null } | null;

  // PostgREST embeds `cost_codes(...)` as an ARRAY (one row per match); the
  // snapshot stores the single joined cost code (or null) for a line.
  const lines: CoSnapshotLine[] = (
    (lineRows ?? []) as unknown as {
      description: string | null;
      quantity: string | number;
      unit: string | null;
      unit_price: string | number;
      position: number;
      cost_codes: { code: string | null; name: string | null }[] | null;
    }[]
  ).map((l) => ({
    description: l.description ?? null,
    quantity: Number(l.quantity) || 0,
    unit: l.unit ?? null,
    unit_price: Number(l.unit_price) || 0,
    position: l.position,
    cost_code: l.cost_codes && l.cost_codes.length > 0 ? l.cost_codes[0] : null,
  }));

  return {
    change_order: {
      title: (co.title as string) ?? "",
      description: (co.description as string | null) ?? null,
      reason: (co.reason as string | null) ?? null,
      amount: Number(co.amount) || 0,
      is_credit: !!co.is_credit,
      co_number: (co.co_number as string | null) ?? null,
      sent_at: (co.sent_at as string | null) ?? null,
    },
    lines,
    org,
    job: jobRow ? { name: jobRow.name } : null,
  };
}