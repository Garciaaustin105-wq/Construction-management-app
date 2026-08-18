import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableTokens } from "@/lib/accounting/connections";
import { getProvider } from "@/lib/accounting/provider";
import type { AccountingProviderId, TokenSet, AccountingProvider } from "@/lib/accounting/provider";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Push a local entity to the org's connected accounting provider (QuickBooks
// first). Office/admin only. Sync is org-bound: even though the service client
// bypasses RLS, every read filters by the caller's org + every entity is
// double-checked against it (service-role writes bypass RLS `with check`).
//
// Customer sync is auto-chained before invoice/estimate sync (the doc needs a
// QBO CustomerRef) and before payment recording (needs CustomerRef too). The
// provider's external id is persisted back to accounting_external_id so a
// re-sync UPDATES instead of duplicating.

type Entity = "customer" | "invoice" | "estimate" | "payment";
type Admin = ReturnType<typeof createAdminClient>;

const VALID_PROVIDERS: AccountingProviderId[] = ["quickbooks", "xero", "freshbooks", "wave", "stripe_byo"];

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const tenant = await getMyOrg(supabase);
  if (!tenant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can sync to bookkeeping" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
    entity?: Entity;
    id?: string;
    amount?: number;
    method?: "cash" | "check" | "card" | "other";
    reference?: string;
    paidAt?: string;
  };
  const providerId = (body.provider ?? "quickbooks") as AccountingProviderId;
  const entity = body.entity;
  const id = body.id;
  if (!VALID_PROVIDERS.includes(providerId)) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  if (!entity || !id) return NextResponse.json({ error: "Missing entity or id" }, { status: 400 });

  const orgId = tenant.orgId;
  const admin = createAdminClient();

  try {
    const tokens = await getUsableTokens(orgId, providerId);
    const provider = getProvider(providerId);
    if (entity === "customer") return NextResponse.json(await syncCustomer(admin, tokens, provider, orgId, id));
    if (entity === "invoice") return NextResponse.json(await syncInvoice(admin, tokens, provider, orgId, id));
    if (entity === "estimate") return NextResponse.json(await syncEstimate(admin, tokens, provider, orgId, id));
    if (entity === "payment") return NextResponse.json(await recordPayment(admin, tokens, provider, orgId, id, body));
    return NextResponse.json({ error: "Unknown entity" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 502 }
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadCustomer(admin: Admin, orgId: string, id: string) {
  const { data, error } = await admin
    .from("customers")
    .select("id, organization_id, name, contact_email, phone, address, accounting_external_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== orgId) return null;
  return data as {
    id: string; organization_id: string; name: string;
    contact_email: string | null; phone: string | null; address: string | null;
    accounting_external_id: string | null;
  };
}

async function persistExtId(admin: Admin, table: "customers" | "invoices" | "estimates", id: string, externalId: string) {
  await admin.from(table).update({ accounting_external_id: externalId }).eq("id", id);
}

async function syncCustomer(admin: Admin, tokens: TokenSet, provider: AccountingProvider, orgId: string, id: string) {
  const c = await loadCustomer(admin, orgId, id);
  if (!c) return { externalId: null, error: "Customer not found in your organization" };
  const res = await provider.syncCustomer({
    supabase: admin as SupabaseClient, tokens, organizationId: orgId,
    existingExternalId: c.accounting_external_id,
    name: c.name, email: c.contact_email, phone: c.phone,
    billingAddress: c.address ? { line1: c.address } : null,
  });
  if (res.externalId) await persistExtId(admin, "customers", c.id, res.externalId);
  return res;
}

async function loadInvoice(admin: Admin, orgId: string, id: string) {
  const { data, error } = await admin
    .from("invoices")
    .select("id, organization_id, customer_id, status, due_date, accounting_external_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== orgId) return null;
  const inv = data as {
    id: string; organization_id: string; customer_id: string;
    status: string; due_date: string | null; accounting_external_id: string | null;
  };
  const { data: lines } = await admin
    .from("invoice_line_items")
    .select("description, quantity, unit_price")
    .eq("invoice_id", inv.id);
  return { inv, lines: (lines ?? []) as Array<{ description: string; quantity: number; unit_price: number }> };
}

async function syncInvoice(admin: Admin, tokens: TokenSet, provider: AccountingProvider, orgId: string, id: string) {
  const loaded = await loadInvoice(admin, orgId, id);
  if (!loaded) return { externalId: null, error: "Invoice not found in your organization" };
  const { inv, lines } = loaded;
  if (!inv.customer_id) return { externalId: null, error: "Invoice has no customer" };

  // Chain a customer sync first so we have a QBO CustomerRef.
  const custRes = await syncCustomer(admin, tokens, provider, orgId, inv.customer_id);
  if (!custRes.externalId) return { externalId: null, error: `Customer sync failed: ${custRes.error}` };

  const res = await provider.syncInvoice({
    supabase: admin as SupabaseClient, tokens, organizationId: orgId,
    existingExternalId: inv.accounting_external_id,
    customerExternalId: custRes.externalId,
    docNumber: inv.id.slice(0, 8).toUpperCase(),
    dueDate: inv.due_date,
    lineItems: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price })),
  });
  if (res.externalId) await persistExtId(admin, "invoices", inv.id, res.externalId);
  return res;
}

async function syncEstimate(admin: Admin, tokens: TokenSet, provider: AccountingProvider, orgId: string, id: string) {
  const { data, error } = await admin
    .from("estimates")
    .select("id, organization_id, customer_id, accounting_external_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const est = data as { id: string; organization_id: string; customer_id: string; accounting_external_id: string | null } | null;
  if (!est || est.organization_id !== orgId) return { externalId: null, error: "Estimate not found in your organization" };
  if (!est.customer_id) return { externalId: null, error: "Estimate has no customer" };

  const custRes = await syncCustomer(admin, tokens, provider, orgId, est.customer_id);
  if (!custRes.externalId) return { externalId: null, error: `Customer sync failed: ${custRes.error}` };

  const { data: lines } = await admin
    .from("estimate_line_items")
    .select("description, quantity, unit_price")
    .eq("estimate_id", est.id);
  const res = await provider.syncEstimate({
    supabase: admin as SupabaseClient, tokens, organizationId: orgId,
    existingExternalId: est.accounting_external_id,
    customerExternalId: custRes.externalId,
    docNumber: est.id.slice(0, 8).toUpperCase(),
    lineItems: (lines ?? []).map((l: { description: string; quantity: number; unit_price: number }) => ({
      description: l.description, quantity: l.quantity, unitPrice: l.unit_price,
    })),
  });
  if (res.externalId) await persistExtId(admin, "estimates", est.id, res.externalId);
  return res;
}

async function recordPayment(
  admin: Admin, tokens: TokenSet, provider: AccountingProvider, orgId: string, id: string,
  body: { amount?: number; method?: "cash" | "check" | "card" | "other"; reference?: string; paidAt?: string }
) {
  const loaded = await loadInvoice(admin, orgId, id);
  if (!loaded) return { externalId: null, error: "Invoice not found in your organization" };
  if (!loaded.inv.accounting_external_id) return { externalId: null, error: "Invoice not synced to the provider yet" };
  if (!body.amount || body.amount <= 0) return { externalId: null, error: "A positive amount is required" };
  const res = await provider.recordPayment({
    supabase: admin as SupabaseClient, tokens, organizationId: orgId,
    invoiceExternalId: loaded.inv.accounting_external_id,
    amount: body.amount, method: body.method ?? "other",
    reference: body.reference ?? null, paidAt: body.paidAt ?? null,
  });
  return res;
}