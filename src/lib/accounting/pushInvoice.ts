// Shared server-side "push a local invoice to the org's connected accounting
// provider(s)", extracted from /api/accounting/sync so the proposal e-sign
// route can auto-sync the signed-proposal invoice without going through the
// HTTP route (which is office-gated + session-auth). The manual sync route
// reuses the same helpers (non-regression).
//
// Payments pivot (2026-08-17): the platform never touches customer money. The
// app AUTHORS the invoice and syncs it ONE-WAY to the org's own provider
// (QuickBooks / Xero / FreshBooks); the provider receives it, the office sends
// it from the provider, the customer pays on the provider's pay page, and
// paid status flows back. No Stripe/pay-here on the customer side.
//
// Server-only. SQL/RLS/auth/financial stay Claude-direct (see
// [[lowvoltage-local-model-delegation]]). The caller passes the service-role
// admin client (invoice/customer writes bypass RLS); token lifecycle + refresh
// is owned by ./connections (getUsableTokens).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AccountingProviderId,
  type TokenSet,
  type AccountingProvider,
  getProvider,
} from "./provider";
import { getConnections, getUsableTokens } from "./connections";

type Admin = SupabaseClient;

export type PushResult = {
  provider: AccountingProviderId;
  // The provider's stable id for the synced invoice (so a re-sync UPDATES
  // instead of duplicating). null on failure.
  externalId: string | null;
  // The provider's doc number / reference (e.g. QBO DocNumber) for display.
  externalNumber?: string | null;
  error?: string;
};

// ── org-scoped loaders (defense-in-depth: service role bypasses RLS `with
// check`, so every read is filtered by org + every entity is double-checked) ──

export async function loadCustomer(
  admin: Admin,
  orgId: string,
  id: string
) {
  const { data, error } = await admin
    .from("customers")
    .select("id, organization_id, name, contact_email, phone, address, accounting_external_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== orgId) return null;
  return data as {
    id: string;
    organization_id: string;
    name: string;
    contact_email: string | null;
    phone: string | null;
    address: string | null;
    accounting_external_id: string | null;
  };
}

export async function loadInvoice(admin: Admin, orgId: string, id: string) {
  const { data, error } = await admin
    .from("invoices")
    .select("id, organization_id, customer_id, status, due_date, accounting_external_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== orgId) return null;
  const inv = data as {
    id: string;
    organization_id: string;
    customer_id: string;
    status: string;
    due_date: string | null;
    accounting_external_id: string | null;
  };
  const { data: lines } = await admin
    .from("invoice_line_items")
    .select("description, quantity, unit_price")
    .eq("invoice_id", inv.id);
  return {
    inv,
    lines: (lines ?? []) as Array<{
      description: string;
      quantity: number;
      unit_price: number;
    }>,
  };
}

export async function persistExtId(
  admin: Admin,
  table: "customers" | "invoices" | "estimates",
  id: string,
  externalId: string,
  orgId: string
) {
  // Defense-in-depth: the service role bypasses RLS `with check`, so scope the
  // update to the caller's org too (not just the id). The entity was already
  // org-verified before this call, but a double filter guarantees a cross-org
  // id can never be stamped here even if the verification ordering changes.
  await admin
    .from(table)
    .update({ accounting_external_id: externalId })
    .eq("id", id)
    .eq("organization_id", orgId);
}

// Push a customer (org contact) to the provider. Idempotent: if
// `existingExternalId` is set, update; else create. Chains the customer sync
// before invoice/payment sync (the doc needs a provider CustomerRef).
export async function syncCustomer(
  admin: Admin,
  tokens: TokenSet,
  provider: AccountingProvider,
  orgId: string,
  id: string
) {
  const c = await loadCustomer(admin, orgId, id);
  if (!c) return { externalId: null, error: "Customer not found in your organization" };
  const res = await provider.syncCustomer({
    supabase: admin,
    tokens,
    organizationId: orgId,
    existingExternalId: c.accounting_external_id,
    name: c.name,
    email: c.contact_email,
    phone: c.phone,
    billingAddress: c.address ? { line1: c.address } : null,
  });
  if (res.externalId) await persistExtId(admin, "customers", c.id, res.externalId, orgId);
  return res;
}

/**
 * Push one local invoice to a specific connected provider. Best-effort: never
 * throws — a token/refresh/adapter failure is captured into `error` with
 * `externalId: null` so a multi-provider loop keeps going. Resolves the usable
 * token set (refreshing if near expiry) + the adapter, loads the invoice
 * (org-scoped), chains a customer sync for the CustomerRef, calls
 * `provider.syncInvoice`, and persists the provider's external id back to
 * `invoices.accounting_external_id` (so a re-sync UPDATES instead of dup).
 */
export async function pushInvoiceToProvider(
  admin: Admin,
  orgId: string,
  invoiceId: string,
  providerId: AccountingProviderId
): Promise<PushResult> {
  try {
    const tokens = await getUsableTokens(orgId, providerId);
    const provider = getProvider(providerId);

    const loaded = await loadInvoice(admin, orgId, invoiceId);
    if (!loaded) {
      return { provider: providerId, externalId: null, error: "Invoice not found in your organization" };
    }
    const { inv, lines } = loaded;
    if (!inv.customer_id) {
      return { provider: providerId, externalId: null, error: "Invoice has no customer" };
    }

    // Chain a customer sync first so we have a provider CustomerRef.
    const custRes = await syncCustomer(admin, tokens, provider, orgId, inv.customer_id);
    if (!custRes.externalId) {
      return { provider: providerId, externalId: null, error: `Customer sync failed: ${custRes.error}` };
    }

    const res = await provider.syncInvoice({
      supabase: admin,
      tokens,
      organizationId: orgId,
      existingExternalId: inv.accounting_external_id,
      customerExternalId: custRes.externalId,
      docNumber: inv.id.slice(0, 8).toUpperCase(),
      dueDate: inv.due_date,
      lineItems: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
      })),
    });
    if (res.externalId) {
      await persistExtId(admin, "invoices", inv.id, res.externalId, orgId);
    }
    return {
      provider: providerId,
      externalId: res.externalId,
      externalNumber: res.externalNumber ?? null,
      error: res.error,
    };
  } catch (err) {
    return {
      provider: providerId,
      externalId: null,
      error: err instanceof Error ? err.message : "Sync failed",
    };
  }
}

/**
 * Push a local invoice to EVERY active accounting provider the org has
 * connected (most orgs have one; the menu allows several). Each provider is
 * independent + best-effort — one provider's failure (e.g. expired token) is
 * captured into that result's `error`, never rejects the whole call. Returns
 * one result per active provider; empty array if none connected.
 */
export async function pushInvoiceToAllConnectedProviders(
  admin: Admin,
  orgId: string,
  invoiceId: string
): Promise<PushResult[]> {
  // Never throws — a connection-read failure (rare DB error) just means no
  // providers are tried, surfaced as an empty result. The per-provider loop
  // below is also individually guarded.
  let conns;
  try {
    conns = await getConnections(orgId);
  } catch {
    return [];
  }
  const active = conns.filter((c) => c.status === "active");
  const results: PushResult[] = [];
  for (const c of active) {
    // pushInvoiceToProvider never throws, but guard anyway in case getUsableTokens
    // surfaces a non-Error rejection from an adapter.
    try {
      results.push(await pushInvoiceToProvider(admin, orgId, invoiceId, c.provider));
    } catch (err) {
      results.push({
        provider: c.provider,
        externalId: null,
        error: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }
  return results;
}