import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { assertNotFreePlan } from "@/lib/planGate";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableTokens } from "@/lib/accounting/connections";
import { getProvider } from "@/lib/accounting/provider";
import type { AccountingProviderId, TokenSet, AccountingProvider } from "@/lib/accounting/provider";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  pushInvoiceToProvider,
  syncCustomer,
  loadInvoice,
  persistExtId,
} from "@/lib/accounting/pushInvoice";
import { captureException } from "@/lib/sentry";

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
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can sync to bookkeeping" },
      { status: 403 }
    );
  }

  // Accounting sync is a paid feature — free (lawn) orgs are blocked here.
  const freeGate = assertNotFreePlan(tenant);
  if (freeGate) return freeGate;

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
    if (entity === "invoice") return NextResponse.json(await pushInvoiceToProvider(admin, orgId, id, providerId));
    if (entity === "estimate") return NextResponse.json(await syncEstimate(admin, tokens, provider, orgId, id));
    if (entity === "payment") return NextResponse.json(await recordPayment(admin, tokens, provider, orgId, id, body));
    return NextResponse.json({ error: "Unknown entity" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    // Covers getUsableTokens (token refresh) failures for every entity type,
    // including "customer" — the one entity with no dedicated helper below.
    captureException(err instanceof Error ? err : new Error(message), {
      extra: { organizationId: orgId, provider: providerId, entity, id },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
// customer/invoice push + the org-scoped loaders + persistExtId live in the
// shared @/lib/accounting/pushInvoice module (reused by the proposal e-sign
// route's auto-sync). Only estimate + payment sync remain here.

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
  if (res.externalId) {
    await persistExtId(admin, "estimates", est.id, res.externalId, orgId);
  } else if (res.error) {
    captureException(new Error(`accounting syncEstimate failed: ${res.error}`), {
      extra: { organizationId: orgId, estimateId: est.id, provider: provider.id },
    });
  }
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
  if (!res.externalId && res.error) {
    captureException(new Error(`accounting recordPayment failed: ${res.error}`), {
      extra: { organizationId: orgId, invoiceId: id, provider: provider.id },
    });
  }
  return res;
}