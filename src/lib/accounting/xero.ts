// Xero accounting provider adapter.
// ----------------------------------------------------------------------------
// Pure HTTP I/O over Xero's OAuth2 + accounting REST API. Implements the
// AccountingProvider interface from ./provider.ts. Adapters are stateless: the
// caller owns token lifecycle (decrypt/refresh/persist — see
// accounting_connections.sql) and hands a DECRYPTED TokenSet to each call. This
// module does NOT touch the DB, RLS, or encryption. SQL/RLS/auth/security stay
// Claude-direct per [[lowvoltage-local-model-delegation]].
//
// Xero OAuth2 notes:
//  - Authorize: https://login.xero.com/identity/connect/authorize
//  - Token:     https://identity.xero.com/connect/token (form-encoded, Basic auth)
//  - scope:     accounting.transactions accounting.settings accounting.contacts offline_access
//  - access ~30min (expires_in 1800); refresh tokens are single-use + ROTATED
//    (every refresh returns a NEW refresh_token — persist it).
//  - tenantId (the Xero org) is NOT in the token body. It is discovered via
//    GET https://api.xero.com/connections (Bearer access) → [{ tenantId, … }].
//    The OAuth callback route does this and stores it on TokenSet.realmId
//    (reused as "provider-specific extras" — see provider.ts). So
//    exchangeCodeForTokens / refreshTokens return realmId:null.
//  - Accounting calls need an Xero-tenant-id header (from tokens.realmId).
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

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID ?? "";
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET ?? "";

const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const API_BASE = "https://api.xero.com/api.xro/2.0/";
const SCOPE =
  "accounting.transactions accounting.settings accounting.contacts offline_access";

/** Money → decimal string (Xero wants UnitAmount/Amount as decimals, not cents). */
const money = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "0.00");

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** Extract a readable error message from a Xero error response. */
async function xeroError(res: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return `Xero HTTP ${res.status}`;
  }
  const b = body as Record<string, unknown>;
  const err = b.Error as { Message?: string } | undefined;
  if (err?.Message) return err.Message;
  // Validation errors come back nested under Elements[].ValidationErrors[].
  const elements = b.Elements as Array<{ ValidationErrors?: Array<{ Message?: string }> }> | undefined;
  const ve = elements?.[0]?.ValidationErrors?.[0]?.Message;
  if (ve) return ve;
  if (typeof b.error === "string") return (b.error_description as string) ?? (b.error as string);
  return `Xero HTTP ${res.status}`;
}

function authBasic(): string {
  return `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64")}`;
}

/** Standard headers for a Xero accounting call (bearer + tenant id). */
function apiHeaders(tokens: TokenSet): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Xero-tenant-id": tokens.realmId ?? "",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/** POST a wrapped collection to Xero; return the first element of body[collection]. */
async function postEntity(
  tokens: TokenSet,
  collection: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${collection}?summarizeErrors=false`, {
    method: "POST",
    headers: apiHeaders(tokens),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await xeroError(res));
  const json = (await res.json()) as Record<string, unknown>;
  const arr = (json[collection] as Array<Record<string, unknown>> | undefined) ?? [];
  return arr[0] ?? {};
}

/** GET a single entity by id; return the first element of body[collection]. */
async function getEntity(
  tokens: TokenSet,
  collection: string,
  id: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${collection}/${id}`, { headers: apiHeaders(tokens) });
  if (!res.ok) throw new Error(await xeroError(res));
  const json = (await res.json()) as Record<string, unknown>;
  const arr = (json[collection] as Array<Record<string, unknown>> | undefined) ?? [];
  return arr[0] ?? {};
}

/** Discover the org's Xero tenantId via GET /connections (first ORGANISATION). */
async function discoverTenantId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const conns = (await res.json()) as Array<{ tenantId: string; tenantType: string }>;
    if (!Array.isArray(conns) || conns.length === 0) return null;
    // Prefer a real org tenant over a practice/non-org connection.
    return (conns.find((c) => c.tenantType === "ORGANISATION") ?? conns[0]).tenantId ?? null;
  } catch {
    return null;
  }
}

export class XeroProvider implements AccountingProvider {
  readonly id: AccountingProviderId = "xero";
  readonly label = "Xero";

  // ── OAuth2 ────────────────────────────────────────────────────────────────
  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: XERO_CLIENT_ID,
      scope: SCOPE,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenSet> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: authBasic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    if (!res.ok) throw new Error(await xeroError(res));
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const now = Date.now();
    // Xero's tenantId is NOT in the token body or the callback query — it is
    // discovered via GET /connections with the access token. Populate realmId
    // here (unlike QBO, whose realmId arrives in the callback query). The
    // callback route only overwrites realmId when the query carries one, so a
    // provider that self-discovers stays generic.
    const realmId = await discoverTenantId(b.access_token);
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessTokenExpiresAt: new Date(now + (b.expires_in ?? 1800) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(), // Xero refresh ~60d
      realmId,
    };
  }

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: authBasic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!res.ok) throw new Error(await xeroError(res));
    // Xero ROTATES refresh tokens — the response carries a new refresh_token.
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const now = Date.now();
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessTokenExpiresAt: new Date(now + (b.expires_in ?? 1800) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(),
      realmId: null,
    };
  }

  // ── sync (push app → Xero) ──────────────────────────────────────────────────
  async syncCustomer(input: SyncCustomerInput): Promise<SyncResult> {
    try {
      const { tokens, name, email, phone, billingAddress, existingExternalId } = input;
      const contact: Record<string, unknown> = { Name: name };
      if (email) contact.EmailAddress = email;
      if (phone) contact.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: phone }];
      if (billingAddress?.line1) {
        contact.Addresses = [{ AddressType: "POBOX", AttentionTo: billingAddress.line1 }];
      }
      if (existingExternalId) contact.ContactID = existingExternalId;
      const created = await postEntity(tokens, "Contacts", { Contacts: [contact] });
      return {
        externalId: (created.ContactID as string) ?? null,
        externalNumber: (created.Name as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async syncInvoice(input: SyncInvoiceInput): Promise<SyncResult> {
    try {
      const { tokens, customerExternalId, docNumber, dueDate, lineItems, existingExternalId } = input;
      const invoice: Record<string, unknown> = {
        Type: "ACCREC",
        Contact: { ContactID: customerExternalId },
        Date: todayISO(),
        LineItems: lineItems.map((li) => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: money(li.unitPrice),
        })),
      };
      if (docNumber) invoice.InvoiceNumber = docNumber;
      if (dueDate) invoice.DueDate = dueDate;
      if (existingExternalId) invoice.InvoiceID = existingExternalId;
      const created = await postEntity(tokens, "Invoices", { Invoices: [invoice] });
      return {
        externalId: (created.InvoiceID as string) ?? null,
        externalNumber: (created.InvoiceNumber as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async syncEstimate(input: SyncEstimateInput): Promise<SyncResult> {
    try {
      // Xero has no native Estimate entity — model as a DRAFT ACCREC invoice.
      const { tokens, customerExternalId, docNumber, lineItems, existingExternalId } = input;
      const invoice: Record<string, unknown> = {
        Type: "ACCREC",
        Status: "DRAFT",
        Contact: { ContactID: customerExternalId },
        LineItems: lineItems.map((li) => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: money(li.unitPrice),
        })),
      };
      if (docNumber) invoice.InvoiceNumber = docNumber;
      if (existingExternalId) invoice.InvoiceID = existingExternalId;
      const created = await postEntity(tokens, "Invoices", { Invoices: [invoice] });
      return {
        externalId: (created.InvoiceID as string) ?? null,
        externalNumber: (created.InvoiceNumber as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async recordPayment(input: RecordPaymentInput): Promise<SyncResult> {
    try {
      const { tokens, invoiceExternalId, amount, reference, paidAt } = input;
      const payment: Record<string, unknown> = {
        Invoice: { InvoiceID: invoiceExternalId },
        // Account.Code "090" = the default Xero bank account; the org can map
        // its real clearing account in the Xero UI later. Using a fixed code
        // avoids needing a separate account-config step to record a payment.
        Account: { Code: "090" },
        Amount: money(amount),
        Date: paidAt ? paidAt.slice(0, 10) : todayISO(),
      };
      if (reference) payment.Reference = reference;
      const created = await postEntity(tokens, "Payments", { Payments: [payment] });
      return { externalId: (created.PaymentID as string) ?? null };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  // ── read-back (Xero → app) ───────────────────────────────────────────────────
  async getInvoicePaymentStatus(
    tokens: TokenSet,
    invoiceExternalId: string
  ): Promise<InvoicePaymentStatus> {
    try {
      const inv = await getEntity(tokens, "Invoices", invoiceExternalId);
      const balance = Number(inv.AmountDue ?? 0);
      const paidAmount = Number(inv.AmountPaid ?? 0);
      const status = (inv.Status as string) ?? "";
      return {
        paid: balance <= 0 || status === "PAID",
        balance,
        paidAmount,
      };
    } catch (e) {
      return { paid: false, balance: null, paidAmount: null, error: (e as Error).message };
    }
  }

  async handleWebhook(payload: unknown): Promise<WebhookResult> {
    // Xero sends { events: [{ resourceUrl, … }] }. Signature verification
    // (base64 HMAC-SHA256 of the raw body keyed by the webhook key) is the
    // route's job. Here we surface the invoice ids that changed so the caller
    // can refresh them. resourceUrl looks like .../Invoices/{id}.
    try {
      const p = payload as { events?: Array<{ resourceUrl?: string; eventCategory?: string }> };
      const invoiceIds: string[] = [];
      for (const e of p.events ?? []) {
        if (e.eventCategory !== "INVOICE" || !e.resourceUrl) continue;
        const m = /\/Invoices\/([^/?#]+)/.exec(e.resourceUrl);
        if (m) invoiceIds.push(m[1]);
      }
      return { handled: true, invoiceIds };
    } catch {
      return { handled: false, error: "Malformed Xero webhook payload" };
    }
  }
}

registerAccountingProvider(new XeroProvider());