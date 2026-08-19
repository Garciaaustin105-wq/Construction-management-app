// QuickBooks Online accounting provider adapter.
// ----------------------------------------------------------------------------
// Pure HTTP I/O over Intuit's OAuth2 + QBO v3 REST API. Implements the
// AccountingProvider interface from ./provider.ts. Adapters are stateless: the
// caller owns token lifecycle (decrypt/refresh/persist — see
// accounting_connections.sql) and hands a DECRYPTED TokenSet to each call. This
// module does NOT touch the DB, RLS, or encryption. SQL/RLS/auth/security stay
// Claude-direct per [[lowvoltage-local-model-delegation]].
//
// Intuit OAuth2 notes:
//  - Authorize: https://appcenter.intuit.com/connect/oauth2
//  - Token:     https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer (form-encoded, Basic auth)
//  - scope:     com.intuit.quickbooks.accounting
//  - access ~60min; refresh 100-day rolling / 5yr hard; refresh tokens are ROTATED
//  - realmId arrives in the OAuth CALLBACK query params, NOT the token body, so
//    exchangeCodeForTokens returns realmId:null — the route attaches it before
//    persisting (TokenSet.realmId).
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

const INTUIT_CLIENT_ID = process.env.INTUIT_CLIENT_ID ?? "";
const INTUIT_CLIENT_SECRET = process.env.INTUIT_CLIENT_SECRET ?? "";
const INTUIT_ENVIRONMENT = process.env.INTUIT_ENVIRONMENT ?? "production";

// QBO v3 REST base. Sandbox vs production by INTUIT_ENVIRONMENT.
const REST_BASE =
  INTUIT_ENVIRONMENT === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com/v3/company/"
    : "https://quickbooks.api.intuit.com/v3/company/";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const MINOR_VERSION = "70";

/** Money → decimal string (QBO wants Amount as a decimal, not cents). */
const money = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "0.00");

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** Extract a readable error message from an Intuit error response. */
async function intuitError(res: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return `Intuit HTTP ${res.status}`;
  }
  const b = body as Record<string, unknown>;
  const fault = b.Fault as { Error?: Array<{ Message?: string }> } | undefined;
  if (fault?.Error?.[0]?.Message) return fault.Error[0].Message;
  if (typeof b.error === "string") return (b.error_description as string) ?? (b.error as string);
  return `Intuit HTTP ${res.status}`;
}

function authBasic(): string {
  return `Basic ${Buffer.from(`${INTUIT_CLIENT_ID}:${INTUIT_CLIENT_SECRET}`).toString("base64")}`;
}

/** Standard headers for a QBO REST call (bearer access token). */
function apiHeaders(tokens: TokenSet): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/** POST an entity to QBO; return the parsed wrapped object (e.g. { Customer }). */
async function postEntity(
  tokens: TokenSet,
  entity: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = `${REST_BASE}${tokens.realmId}/${entity}?minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: apiHeaders(tokens),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await intuitError(res));
  const json = (await res.json()) as Record<string, unknown>;
  return (json[entity] as Record<string, unknown>) ?? {};
}

/** GET an entity by id; return the parsed wrapped object. */
async function getEntity(
  tokens: TokenSet,
  entity: string,
  id: string
): Promise<Record<string, unknown>> {
  // QBO entity state (esp. SyncToken) MUST NOT be served from any cache — a
  // stale SyncToken causes "Stale Object Error" (5010) on the next write.
  // Next/Vercel's data cache keys on URL (not the bearer header), so we BOTH
  // set cache:"no-store" AND append a cache-busting `_` param (unique per call)
  // so a GET made when SyncToken=0 can never be replayed after QBO bumped it.
  const url = `${REST_BASE}${tokens.realmId}/${entity}/${id}?minorversion=${MINOR_VERSION}&_=${Date.now()}`;
  const res = await fetch(url, { headers: apiHeaders(tokens), cache: "no-store" });
  if (!res.ok) throw new Error(await intuitError(res));
  const json = (await res.json()) as Record<string, unknown>;
  return (json[entity] as Record<string, unknown>) ?? {};
}

export class QuickBooksProvider implements AccountingProvider {
  readonly id: AccountingProviderId = "quickbooks";
  readonly label = "QuickBooks Online";

  // ── Configuration ──────────────────────────────────────────────────────────
  isConfigured(): boolean {
    return Boolean(INTUIT_CLIENT_ID && INTUIT_CLIENT_SECRET);
  }

  // ── OAuth2 ────────────────────────────────────────────────────────────────
  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: INTUIT_CLIENT_ID,
      scope: "com.intuit.quickbooks.accounting",
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
    if (!res.ok) throw new Error(await intuitError(res));
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number };
    const now = Date.now();
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessTokenExpiresAt: new Date(now + b.expires_in * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + b.x_refresh_token_expires_in * 1000).toISOString(),
      realmId: null, // QBO returns realmId in the callback query, not the token body.
    };
  }

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: authBasic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!res.ok) throw new Error(await intuitError(res));
    // QBO ROTATES refresh tokens — the response carries a new refresh_token.
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number };
    const now = Date.now();
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessTokenExpiresAt: new Date(now + b.expires_in * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + b.x_refresh_token_expires_in * 1000).toISOString(),
      realmId: null,
    };
  }

  // ── sync (push app → QBO) ──────────────────────────────────────────────────
  async syncCustomer(input: SyncCustomerInput): Promise<SyncResult> {
    try {
      const { tokens, name, email, phone, billingAddress, existingExternalId } = input;
      const body: Record<string, unknown> = { DisplayName: name };
      if (email) body.PrimaryEmailAddr = { Address: email };
      if (phone) body.PrimaryPhone = { FreeFormNumber: phone };
      if (billingAddress) {
        // QBO rejects `null` inside BillAddr ("Customer has invalid or
        // unsupported properties") — omitted, not null. Only include the
        // sub-fields we actually have. (Our customer `address` is often a
        // single unstructured string, so usually only Line1 is set.)
        const billAddr: Record<string, string> = {};
        if (billingAddress.line1) billAddr.Line1 = billingAddress.line1;
        if (billingAddress.city) billAddr.City = billingAddress.city;
        if (billingAddress.state) billAddr.CountrySubDivisionCode = billingAddress.state;
        if (billingAddress.zip) billAddr.PostalCode = billingAddress.zip;
        if (Object.keys(billAddr).length) body.BillAddr = billAddr;
      }
      if (existingExternalId) {
        // QBO requires Id + the current SyncToken on updates. Use a SPARSE
        // (partial) update — `sparse` is lowercase in QBO (capital-S `Sparse`
        // is an unknown property → "request has invalid or unsupported property"),
        // and partial update won't reset fields we don't send.
        body.Id = existingExternalId;
        body.sparse = true;
        // SyncToken must be current or QBO throws "Stale Object Error" (5010).
        // A cached GET or a double-click/concurrent sync can hand us a stale
        // token, so fetch it fresh inside apply() and retry once on a stale
        // rejection (re-fetches a then-current token).
        const apply = async (): Promise<Record<string, unknown>> => {
          const cur = await getEntity(tokens, "customer", existingExternalId);
          return postEntity(tokens, "customer", { ...body, SyncToken: cur.SyncToken });
        };
        let updated: Record<string, unknown>;
        try {
          updated = await apply();
        } catch (e) {
          if (!/stale object/i.test((e as Error).message)) throw e;
          updated = await apply(); // one retry with a freshly-fetched SyncToken
        }
        return {
          externalId: existingExternalId,
          externalNumber: (updated.DisplayName as string) ?? null,
        };
      }
      const created = await postEntity(tokens, "customer", body);
      return {
        externalId: String(created.Id),
        externalNumber: (created.DisplayName as string) ?? null,
      };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async syncInvoice(input: SyncInvoiceInput): Promise<SyncResult> {
    try {
      const { tokens, customerExternalId, docNumber, dueDate, lineItems, existingExternalId } = input;
      const body: Record<string, unknown> = {
        CustomerRef: { value: customerExternalId },
        TxnDate: todayISO(),
        Line: lineItems.map((li) => ({
          Description: li.description,
          Amount: money(li.quantity * li.unitPrice),
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { name: "Services" }, Qty: li.quantity, UnitPrice: money(li.unitPrice) },
        })),
      };
      if (docNumber) body.DocNumber = docNumber;
      if (dueDate) body.DueDate = dueDate;
      if (existingExternalId) {
        const cur = await getEntity(tokens, "invoice", existingExternalId);
        body.Id = existingExternalId;
        body.SyncToken = cur.SyncToken;
        body.Line = [...(body.Line as unknown[]), ...((cur.Line as unknown[]) ?? [])];
      }
      const created = await postEntity(tokens, "invoice", body);
      return { externalId: String(created.Id), externalNumber: (created.DocNumber as string) ?? null };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async syncEstimate(input: SyncEstimateInput): Promise<SyncResult> {
    try {
      const { tokens, customerExternalId, docNumber, lineItems, existingExternalId } = input;
      const body: Record<string, unknown> = {
        CustomerRef: { value: customerExternalId },
        Line: lineItems.map((li) => ({
          Description: li.description,
          Amount: money(li.quantity * li.unitPrice),
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemRef: { name: "Services" }, Qty: li.quantity, UnitPrice: money(li.unitPrice) },
        })),
      };
      if (docNumber) body.DocNumber = docNumber;
      if (existingExternalId) {
        const cur = await getEntity(tokens, "estimate", existingExternalId);
        body.Id = existingExternalId;
        body.SyncToken = cur.SyncToken;
        body.Line = [...(body.Line as unknown[]), ...((cur.Line as unknown[]) ?? [])];
      }
      const created = await postEntity(tokens, "estimate", body);
      return { externalId: String(created.Id), externalNumber: (created.DocNumber as string) ?? null };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  async recordPayment(input: RecordPaymentInput): Promise<SyncResult> {
    try {
      const { tokens, invoiceExternalId, amount, reference, paidAt } = input;
      // The interface gives us the invoice id, not the customer id — look it up.
      const inv = await getEntity(tokens, "invoice", invoiceExternalId);
      const customerRef = inv.CustomerRef as { value: string } | undefined;
      if (!customerRef?.value) return { externalId: null, error: "Invoice has no CustomerRef" };
      const body: Record<string, unknown> = {
        CustomerRef: { value: customerRef.value },
        TotalAmt: money(amount),
        TxnDate: paidAt ? paidAt.slice(0, 10) : todayISO(),
        Line: [{ Amount: money(amount), LinkedTxn: [{ TxnId: invoiceExternalId, TxnType: "Invoice" }] }],
      };
      if (reference) body.PaymentRefNumber = reference;
      const created = await postEntity(tokens, "payment", body);
      return { externalId: String(created.Id) };
    } catch (e) {
      return { externalId: null, error: (e as Error).message };
    }
  }

  // ── read-back (QBO → app) ───────────────────────────────────────────────────
  async getInvoicePaymentStatus(
    tokens: TokenSet,
    invoiceExternalId: string
  ): Promise<InvoicePaymentStatus> {
    try {
      const inv = await getEntity(tokens, "invoice", invoiceExternalId);
      const balance = Number(inv.Balance ?? 0);
      const total = Number(inv.TotalAmt ?? 0);
      return {
        paid: balance <= 0,
        balance,
        paidAmount: Math.max(0, total - balance),
      };
    } catch (e) {
      return { paid: false, balance: null, paidAmount: null, error: (e as Error).message };
    }
  }

  async handleWebhook(payload: unknown): Promise<WebhookResult> {
    // Intuit sends { eventNotifications: [{ realmId, data: { entities: [...] } }] }.
    // Signature verification (intuit-signature HMAC + verification token) is the
    // route's job. Here we only surface the invoice ids that changed so the
    // caller can refresh them.
    try {
      const p = payload as { eventNotifications?: Array<{ data?: { entities?: Array<{ id?: string; type?: string; deleted?: boolean }> } }> };
      const invoiceIds: string[] = [];
      for (const n of p.eventNotifications ?? []) {
        for (const e of n.data?.entities ?? []) {
          if (e.type === "Invoice" && e.id && !e.deleted) invoiceIds.push(e.id);
        }
      }
      return { handled: true, invoiceIds };
    } catch {
      return { handled: false, error: "Malformed Intuit webhook payload" };
    }
  }
}

registerAccountingProvider(new QuickBooksProvider());