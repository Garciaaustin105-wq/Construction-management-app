// Provider-agnostic accounting integration layer.
//
// Payments/bookkeeping pivot (2026-08-17): the platform never touches customer
// money. Each org connects its OWN bookkeeping provider (QuickBooks Online
// first, then Xero / FreshBooks / Wave / Stripe-BYO) via OAuth2. This module
// defines the normalized adapter interface every provider implements + the
// registry that maps a provider id to its adapter, so the app code stays
// provider-agnostic (the org admin picks; the app calls `getProvider(id)`).
//
// Auth/tenant notes:
// - Tokens live encrypted-at-rest in `accounting_connections` (see
//   accounting_connections.sql). Adapters receive a DECRYPTED token set on each
//   call (the caller decrypts + refreshes as needed before invoking), so an
//   adapter never touches the DB or the encryption key directly. This keeps
//   adapters pure I/O over the provider's HTTP API and testable in isolation.
// - The connection row is org-scoped; RLS is tier_office. The OAuth callback +
//   sync routes run as the service role to insert/refresh connection rows.
//
// SQL/RLS/auth stay Claude-direct (see [[lowvoltage-local-model-delegation]]).

import type { SupabaseClient } from "@supabase/supabase-js";

export type AccountingProviderId =
  | "quickbooks"
  | "xero"
  | "freshbooks"
  | "wave"
  | "stripe_byo";

// A decrypted, ready-to-use token set handed to an adapter for one call. The
// caller (sync route) is responsible for refreshing before expiry + persisting
// the new tokens back to the encrypted connection row.
export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string | null; // ISO
  refreshTokenExpiresAt: string | null; // ISO
  // Provider-specific extras the adapter may need (e.g. QBO realm_id).
  realmId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type SyncResult = {
  // The provider's stable id for the synced entity (so we can later read it
  // back / update it). null on failure.
  externalId: string | null;
  // The provider's doc number / reference (e.g. QBO DocNumber) for display.
  externalNumber?: string | null;
  error?: string;
};

// Push a customer (org contact) to the provider. Idempotent: if
// `existingExternalId` is set, update; else create.
export type SyncCustomerInput = {
  supabase: SupabaseClient;
  tokens: TokenSet;
  organizationId: string;
  existingExternalId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  billingAddress?: {
    line1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
};

export type SyncInvoiceInput = {
  supabase: SupabaseClient;
  tokens: TokenSet;
  organizationId: string;
  existingExternalId?: string | null;
  customerExternalId: string;
  docNumber?: string | null; // our invoice number
  dueDate?: string | null;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number; // money in major units (USD)
  }>;
};

export type SyncEstimateInput = {
  supabase: SupabaseClient;
  tokens: TokenSet;
  organizationId: string;
  existingExternalId?: string | null;
  customerExternalId: string;
  docNumber?: string | null;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>;
};

export type RecordPaymentInput = {
  supabase: SupabaseClient;
  tokens: TokenSet;
  organizationId: string;
  invoiceExternalId: string;
  amount: number; // major units
  method?: "cash" | "check" | "card" | "other" | null;
  reference?: string | null; // check number / txn id
  paidAt?: string | null;
};

export type InvoicePaymentStatus = {
  paid: boolean;
  balance: number | null; // major units remaining, null if unknown
  paidAmount: number | null;
  error?: string;
};

export type WebhookResult = {
  handled: boolean;
  // Map of our internal entity ids that changed (so the caller can refresh them).
  invoiceIds?: string[];
  error?: string;
};

// Every accounting provider implements this. Adapters are stateless I/O over
// the provider's HTTP API; the caller owns token lifecycle + persistence.
export interface AccountingProvider {
  readonly id: AccountingProviderId;
  readonly label: string;

  // ── OAuth2 ──────────────────────────────────────────────────────────────
  // Build the provider authorization URL. `state` carries our org id + a
  // nonce (verified in the callback to prevent CSRF).
  getAuthUrl(redirectUri: string, state: string): string;
  exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenSet>;
  refreshTokens(refreshToken: string): Promise<TokenSet>;

  // ── sync (push app → provider) ───────────────────────────────────────────
  syncCustomer(input: SyncCustomerInput): Promise<SyncResult>;
  syncInvoice(input: SyncInvoiceInput): Promise<SyncResult>;
  syncEstimate(input: SyncEstimateInput): Promise<SyncResult>;
  recordPayment(input: RecordPaymentInput): Promise<SyncResult>;

  // ── read-back (provider → app) ───────────────────────────────────────────
  getInvoicePaymentStatus(
    tokens: TokenSet,
    invoiceExternalId: string
  ): Promise<InvoicePaymentStatus>;
  handleWebhook(payload: unknown, headers: Record<string, string>): Promise<WebhookResult>;
}

// ── Registry ───────────────────────────────────────────────────────────────
// Adapters register themselves at module load. `getProvider` resolves one by
// id; throws if unconfigured (so a missing-provider bug fails loud, never
// silently no-ops a sync).
const registry = new Map<AccountingProviderId, AccountingProvider>();

export function registerAccountingProvider(p: AccountingProvider): void {
  registry.set(p.id, p);
}

export function getProvider(id: AccountingProviderId): AccountingProvider {
  const p = registry.get(id);
  if (!p) throw new Error(`No accounting provider registered for "${id}"`);
  return p;
}

export function listAvailableProviders(): AccountingProviderId[] {
  return Array.from(registry.keys());
}

/** Each registered provider's id + display label, for the billing-page menu. */
export function listProviderOptions(): { id: AccountingProviderId; label: string }[] {
  return Array.from(registry.values()).map((p) => ({ id: p.id, label: p.label }));
}