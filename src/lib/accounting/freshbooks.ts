// FreshBooks accounting provider adapter.
// ----------------------------------------------------------------------------
// Pure HTTP I/O over FreshBooks' OAuth2 + accounting REST API. Implements the
// AccountingProvider interface from ./provider.ts. Adapters are stateless: the
// caller owns token lifecycle (decrypt/refresh/persist — see
// accounting_connections.sql) and hands a DECRYPTED TokenSet to each call. This
// module does NOT touch the DB, RLS, or encryption. SQL/RLS/auth/security stay
// Claude-direct per [[lowvoltage-local-model-delegation]].
//
// FreshBooks OAuth2 / API notes:
//  - Authorize: https://auth.freshbooks.com/oauth/authorize
//  - Token:     https://api.freshbooks.com/auth/oauth/token (form-encoded body
//               carrying client_id + client_secret; NOT Basic auth)
//  - scopes:    user:<object>:<read|write> — profile, clients, invoices,
//               estimates, payments (we request read+write for all five)
//  - access ~1h; refresh tokens are single-use + ROTATED (persist the new one)
//  - account_id (the FreshBooks account used in accounting URLs) is NOT in the
//    token body. It is discovered via GET /auth/api/v1/users/me
//    (business_memberships[].business.account_id). exchangeCodeForTokens
//    populates TokenSet.realmId with it; the generic OAuth callback only
//    overwrites realmId when the callback query carries one, so a self-
//    discovering provider stays generic (same trick as Xero's tenantId).
//  - Accounting URLs are https://api.freshbooks.com/accounting/account/{account_id}/<resource>.
//    Bodies wrap the entity ({client:{…}}, {invoice:{…}}); responses wrap under
//    response.result.<entity>.
// Sync methods never throw — on failure they return { externalId: null, error }.

import {
  type AccountingProvider,
  type AccountingProviderId,
  type InvoicePaymentStatus,
  type RecordPaymentInput,
  type SyncCustomerInput,
  type SyncEstimateInput,
  type SyncInvoiceInput,
  type SyncResult,
  type TokenSet,
  type WebhookResult,
  registerAccountingProvider,
} from "./provider";

const CLIENT_ID = process.env.FRESHBOOKS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.FRESHBOOKS_CLIENT_SECRET ?? "";

const AUTH_URL = "https://auth.freshbooks.com/oauth/authorize";
const TOKEN_URL = "https://api.freshbooks.com/auth/oauth/token";
const API_BASE = "https://api.freshbooks.com";
const SCOPE = [
  "user:profile:read",
  "user:clients:read",
  "user:clients:write",
  "user:invoices:read",
  "user:invoices:write",
  "user:estimates:read",
  "user:estimates:write",
  "user:payments:read",
  "user:payments:write",
].join(" ");

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** Extract a readable error message from a FreshBooks error response. */
async function fbError(res: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return `FreshBooks HTTP ${res.status}`;
  }
  const b = body as Record<string, unknown>;
  // Error responses look like { response: { errors: [{ message }] } }.
  const resp = b.response as { errors?: Array<{ message?: string }> } | undefined;
  const ve = resp?.errors?.[0]?.message;
  if (ve) return ve;
  if (typeof b.error === "string") return (b.error_description as string) ?? (b.error as string);
  return `FreshBooks HTTP ${res.status}`;
}

/** Account-scoped accounting URL. */
function accountUrl(accountId: string, path: string): string {
  return `${API_BASE}/accounting/account/${accountId}/${path}`;
}

/** Standard headers for an accounting call. */
function apiHeaders(tokens: TokenSet): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * POST a wrapped entity body; return the created entity object under
 * response.result.<resultKey>.
 */
async function postBody(
  tokens: TokenSet,
  path: string,
  wrapperKey: string,
  body: Record<string, unknown>,
  resultKey: string
): Promise<Record<string, unknown>> {
  const accountId = tokens.realmId ?? "";
  const res = await fetch(accountUrl(accountId, path), {
    method: "POST",
    headers: apiHeaders(tokens),
    body: JSON.stringify({ [wrapperKey]: body }),
  });
  if (!res.ok) throw new Error(await fbError(res));
  const json = (await res.json()) as {
    response?: { result?: Record<string, unknown> | null };
  };
  const result = json.response?.result ?? null;
  if (!result) return {};
  // result is either the entity directly ({client:{…}}) or wrapped under resultKey.
  if (resultKey in result) return (result[resultKey] as Record<string, unknown>) ?? {};
  return result;
}

/** GET an entity by id; return response.result.<resultKey>. */
async function getEntity(
  tokens: TokenSet,
  path: string,
  resultKey: string
): Promise<Record<string, unknown>> {
  const accountId = tokens.realmId ?? "";
  const res = await fetch(accountUrl(accountId, path), { headers: apiHeaders(tokens) });
  if (!res.ok) throw new Error(await fbError(res));
  const json = (await res.json()) as { response?: { result?: Record<string, unknown> | null } };
  const result = json.response?.result ?? null;
  if (!result) return {};
  if (resultKey in result) return (result[resultKey] as Record<string, unknown>) ?? {};
  return result;
}

/** Discover the account_id from the user's first business membership. */
async function discoverAccountId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      business_memberships?: Array<{ business?: { account_id?: string } }>;
      response?: {
        business_memberships?: Array<{ business?: { account_id?: string } }>;
      };
    };
    const memberships = json.business_memberships ?? json.response?.business_memberships ?? [];
    for (const m of memberships) {
      const id = m.business?.account_id;
      if (id) return id;
    }
    return null;
  } catch {
    return null;
  }
}

export class FreshBooksProvider implements AccountingProvider {
  readonly id: AccountingProviderId = "freshbooks";
  readonly label = "FreshBooks";

  // ── OAuth2 ────────────────────────────────────────────────────────────────
  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenSet> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(await fbError(res));
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const now = Date.now();
    const realmId = await discoverAccountId(b.access_token);
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessTokenExpiresAt: new Date(now + (b.expires_in ?? 3600) * 1000).toISOString(),
      // FreshBooks refresh tokens are long-lived (~10 years) but single-use.
      refreshTokenExpiresAt: new Date(now + 3650 * 24 * 60 * 60 * 1000).toISOString(),
      realmId,
    };
  }

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) throw new Error(await fbError(res));
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const now = Date.now();
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessTokenExpiresAt: new Date(now + (b.expires_in ?? 3600) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + 3650 * 24 * 60 * 60 * 1000).toISOString(),
      realmId: null,
    };
  }

  // ── sync (push app → FreshBooks) ────────────────────────────────────────────
  async syncCustomer(input: SyncCustomerInput): Promise<SyncResult> {
    try {
      const { tokens, name, email, phone, existingExternalId } = input;
      const client: Record<string, unknown> = { organization: name };
      if (email) client.email = email;
      if (phone) client.phones = [{ phone: phone, type: "Cell" }];
      if (existingExternalId) client.id = Number(existingExternalId);
      const created = await postBody(tokens, "users/clients", "client", client, "client");
      return {
        externalId: String(created.id ?? "") || null,
        externalNumber: (created.organization as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async syncInvoice(input: SyncInvoiceInput): Promise<SyncResult> {
    try {
      const { tokens, customerExternalId, docNumber, dueDate, lineItems, existingExternalId } = input;
      const invoice: Record<string, unknown> = {
        customerid: Number(customerExternalId),
        create_date: todayISO(),
        lines: lineItems.map((li) => ({
          type: 0, // 0 = line (description-based), not an item reference
          description: li.description,
          unitcost: li.unitPrice.toFixed(2),
          quantity: String(li.quantity),
        })),
      };
      if (docNumber) invoice.invoice_number = docNumber;
      if (dueDate) invoice.due_date = dueDate.slice(0, 10);
      if (existingExternalId) invoice.id = Number(existingExternalId);
      const created = await postBody(tokens, "invoices/invoices", "invoice", invoice, "invoice");
      return {
        externalId: String(created.id ?? "") || null,
        externalNumber: (created.invoice_number as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async syncEstimate(input: SyncEstimateInput): Promise<SyncResult> {
    try {
      const { tokens, customerExternalId, docNumber, lineItems, existingExternalId } = input;
      const estimate: Record<string, unknown> = {
        customerid: Number(customerExternalId),
        create_date: todayISO(),
        lines: lineItems.map((li) => ({
          type: 0,
          description: li.description,
          unitcost: li.unitPrice.toFixed(2),
          quantity: String(li.quantity),
        })),
      };
      if (docNumber) estimate.estnumber = docNumber;
      if (existingExternalId) estimate.id = Number(existingExternalId);
      const created = await postBody(tokens, "estimates/estimates", "estimate", estimate, "estimate");
      return {
        externalId: String(created.id ?? "") || null,
        externalNumber: (created.estnumber as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async recordPayment(input: RecordPaymentInput): Promise<SyncResult> {
    try {
      const { tokens, invoiceExternalId, amount, reference, paidAt } = input;
      const payment: Record<string, unknown> = {
        invoiceid: Number(invoiceExternalId),
        date: paidAt ? paidAt.slice(0, 10) : todayISO(),
        amount: { amount: amount.toFixed(2), code: "USD" },
      };
      if (reference) payment.note = reference;
      const created = await postBody(tokens, "payments/payments", "payment", payment, "payment");
      return { externalId: String(created.id ?? "") || null };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  // ── read-back (FreshBooks → app) ────────────────────────────────────────────
  async getInvoicePaymentStatus(
    tokens: TokenSet,
    invoiceExternalId: string
  ): Promise<InvoicePaymentStatus> {
    try {
      const inv = await getEntity(tokens, `invoices/invoices/${invoiceExternalId}`, "invoice");
      const status = (inv.status as string) ?? "";
      const outstanding = Number((inv.outstanding as { amount?: string })?.amount ?? 0);
      const paidAmount = Number((inv.paid as { amount?: string })?.amount ?? 0);
      return {
        paid: inv.paid === true || status === "paid",
        balance: outstanding,
        paidAmount,
      };
    } catch (e) {
      return { paid: false, balance: null, paidAmount: null, error: (e as Error).message };
    }
  }

  async handleWebhook(payload: unknown): Promise<WebhookResult> {
    // FreshBooks webhooks POST { name, object_id, … }; name like "invoice.payment"
    // or "invoice.create". We surface the changed invoice id so the caller can
    // read back payment status. Signature verification is the route's job.
    try {
      const p = payload as { name?: string; object_id?: string };
      const name = p.name ?? "";
      if (!name.startsWith("invoice.")) return { handled: true, invoiceIds: [] };
      return { handled: true, invoiceIds: p.object_id ? [p.object_id] : [] };
    } catch {
      return { handled: false, error: "Malformed FreshBooks webhook payload" };
    }
  }
}

registerAccountingProvider(new FreshBooksProvider());