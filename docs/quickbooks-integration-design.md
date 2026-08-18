 # QuickBooks Online Integration Technical Design Document

## 1. Goals & Non-Goals

- **Goals:**
  - Integrate QuickBooks Online (QBO) with the existing multi-tenant SaaS construction-management app.
  - Enable the platform to sync documents (customers, invoices, estimates, payments) to QBO and read payment status back.
  - Design a pluggable per-org `accounting-integrations` module with a normalized provider-agnostic adapter interface.
  - Support the pivot to move the contractor's own customer payments + bookkeeping to QBO for the CONSTRUCTION app.

- **Non-Goals:**
  - The platform will NEVER process or hold the contractor's customer payment money.
  - The platform will NOT replace the contractor's books.

## 2. Architecture

The `accounting-integrations` module will have a normalized provider-agnostic adapter interface. Here's a TypeScript interface skeleton:

```typescript
interface AccountingProvider {
  syncCustomer(customer: Customer): Promise<void>;
  syncInvoice(invoice: Invoice): Promise<void>;
  syncEstimate(estimate: Estimate): Promise<void>;
  recordPayment(payment: Payment): Promise<void>;
  getInvoicePaymentStatus(invoiceId: string): Promise<PaymentStatus>;
  handleWebhook(event: WebhookEvent): Promise<void>;
  getAuthUrl(): string;
  exchangeCodeForTokens(code: string): Promise<Tokens>;
  refreshTokens(refreshToken: string): Promise<Tokens>;
  disconnect(): Promise<void>;
}
```

The module will include a provider registry/factory and an enum of supported providers:

```typescript
enum SupportedProviders {
  QuickBooksOnline,
  Stripe,
  Xero,
  FreshBooks,
  Wave,
}

class AccountingProviderFactory {
  static create(provider: SupportedProviders, orgId: string): AccountingProvider {
    // Implementation
  }
}
```

## 3. QuickBooks Online OAuth2 Flow

- **Intuit Endpoints:**
  - Authorization: `https://appcenter.intuit.com/connect/oauth2`
  - Token: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
  - Revoke: `https://developer.api.intuit.com/v2/oauth2/tokens/revoke`

- **Required Scopes:**
  - `com.intuit.quickbooks.accounting`
  - `com.intuit.quickbooks.payment` is not required as we are NOT processing payments.

- **Redirect/Callback Route Design:**
  - `/api/accounting/quickbooks/callback`

- **Token Model:**
  - Access token expires after 60 minutes.
  - Refresh token has a rolling expiry of 100 days and a hard expiry of 5 years.

- **Realm ID Storage:**
  - Stored in the `accounting_connections` table.

## 4. Token & Connection Storage

- **New Postgres Table:**
  - `accounting_connections` (org-scoped, RLS via `tier_office`)
  - Columns: provider, realm_id, encrypted refresh token, token expiry, connection status, last sync

- **Encryption-at-Rest Approach:**
  - Supabase's edge functions or a similar approach will be used for encryption.

- **Resilience Pattern:**
  - If a token is expired or revoked, the connection status will be marked as down, tokens will be cleared, and the user will be notified.

- **SQL Table Sketch:**

  ```sql
  CREATE TABLE accounting_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    provider SupportedProviders NOT NULL,
    realm_id TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    token_expiry TIMESTAMPTZ NOT NULL,
    connection_status ConnectionStatus NOT NULL,
    last_sync TIMESTAMPTZ
  );
  ```

- **RLS Policy Sketch:**

  ```sql
  CREATE POLICY accounting_connections_tier_office
  FOR ALL
  USING (same_org(organization_id, current_setting('auth.organization_id'::text)))
  WITH CHECK (same_org(organization_id, current_setting('auth.organization_id'::text)));
  ```

## 5. Entity Mapping

- App Customer -> QBO Customer
- App Invoice + line items -> QBO Invoice (SalesItemLineDetail) + CustomerRef
- App Estimate -> QBO Estimate
- App Payment -> QBO Payment linked via LinkedTxn

## 6. Sync Strategy

- **Outbound:**
  - When an invoice/estimate is created/approved/sent in-app, push to QBO.
- **Inbound:**
  - QBO webhooks (or polling fallback) update the app invoice's payment status / balance.
- **Idempotency:**
  - QBO `DocNumber` / app invoice id stored as a QBO custom field or our own `accounting_sync_log` table.
- **Rate Limits & Backoff:**
  - Handle rate limits + 429 backoff.

## 7. Webhooks

- **Intuit Webhook Signature Verification:**
  - Verify the signature of incoming webhook events to ensure their authenticity.
- **Event Types:**
  - Invoice paid, Payment created
- **Mapping Back to the Org:**
  - Map events back to the org via realm_id + our connection table.

## 8. Security & Risk

- **Lower Risk than Stripe Connect Pay Here:**
  - The platform never touches customer money, so there is no Connect verification/payouts liability.
  - There is no money-flow bug risk as the platform does not process payments.
- **Token Security:**
  - Tokens are encrypted at rest and cleared if the connection status is marked as down.
- **RLS:**
  - RLS policies are used to ensure that each organization can only access its own data.
- **Guardrail:**
  - Sync errors will not block the contractor's core in-app workflow.

## 9. Phased Implementation Plan

- **Phase 1:** QBO OAuth + connection storage + customer/invoice sync (outbound) + status read-back (~2 weeks)
- **Phase 2:** estimates + payments + webhooks (~3 weeks)
- **Phase 3:** Stripe-BYO provider for lawn + provider registry (~4 weeks)
- **Phase 4:** Xero/FreshBooks (~6 weeks)

## 10. Open Questions

- **Bidirectional vs Outbound-Only Initially:**
  - Initially, the sync will be outbound-only.
- **Handling Tax Codes / Automated Sales Tax:**
  - This will be addressed in a future phase.
- **Multi-Currency:**
  - This will be addressed in a future phase.
- **Existing Stripe Connect Pay Here Invoices:**
  - Existing Stripe Connect Pay Here invoices will be migrated to QBO during the implementation.