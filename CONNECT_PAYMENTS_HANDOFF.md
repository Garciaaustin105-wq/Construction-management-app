# Connect Payments — UI handoff to Opus

UNTRACKED — do NOT commit (like ESTIMATE_CONVERT_HANDOFF.md / CHEMICALS_HANDOFF.md).
Exclude from ship. Claude-direct already wrote + build-gated the server core;
this doc is the Opus lane (bulk UI). Build against the contracts below.

## What shipped (Claude-direct, DONE, build gate green 2026-08-24)

Stripe Connect customer payments, re-added as **DIRECT charges** (org is merchant
of record, platform never liable / takes no cut — reverses the 2026-08-18 Pay
Here removal but keeps us out of the money flow). Lawn-only v1. Full bundle:
Pay button + save-card + cycle-billing auto-charge.

New/edited server files (already on feat/ai-admin, tsc + both builds exit 0):
- `src/lib/connectAccount.ts` — org Connect account lifecycle (direct-charge
  invariants in the header). Exports `forAccount`, `getConnectAccount`,
  `getOrgForStripeAccount`, `createConnectedAccount`, `createOnboardingLink`,
  `refreshConnectAccount`, `requireChargeableAccount`.
- `src/lib/invoicePay.ts` — `createInvoiceCheckoutSession` (Pay button, direct
  charge + saves card via setup_future_usage), `recordInvoicePayment`,
  `applyInvoicePayment`, `applyInvoicePaymentFromPI`, `chargeInvoiceOffSession`.
- `src/lib/invoiceCharge.ts` — `ensureStripeCustomer`, `stampCustomerCard`,
  `createSaveCardCheckoutSession` (mode=setup), `saveCardForCustomer`.
- `src/app/api/billing/connect/{start,status}/route.ts` — office-gated, lawn-only.
- `src/app/api/invoices/pay/[token]/route.ts` — public, returns `{ url }`.
- `src/app/api/invoices/save-card/[token]/route.ts` — public, returns `{ url }`.
- `src/app/api/stripe/connect/webhook/route.ts` — STRIPE_CONNECT_WEBHOOK_SECRET.
- `src/lib/lawnBilling.ts` — auto-charge hook inserted before deliverInvoice.
- `src/proxy.ts` — `/api/billing/connect` blocked on construction.
- `customer_payment_methods.sql` — 6 cols on customers (USER-RUN, not yet live).

## Your 4 UI pieces

### 1. `src/app/admin/billing/ConnectStripeButton.tsx` (RECOVER + ADAPT)

Recover the deleted file:
```
git show 3ea62c3:src/app/admin/billing/ConnectStripeButton.tsx
```
Adaptations:
- **Drop the payouts state entirely.** The old 4-state UI gated on
  `chargesEnabled && payoutsEnabled`. We now gate on `chargesEnabled` ONLY
  (payouts being false just strands money in the org's Stripe balance; it does
  NOT block accepting a charge — that over-strict gate is what broke the old
  Pay Here). Remove `initialPayoutsEnabled` prop + the "Almost there — payouts
  not enabled" state. New states: **ready** (chargesEnabled) / **finishing**
  (chargesEnabled false, details_submitted true) / **not started** (no account).
- Props: `{ initialConnectAccountId: string | null, initialChargesEnabled: boolean, initialDetailsSubmitted: boolean }`.
- Start → `POST /api/billing/connect/start` → `window.location.assign(data.url)`.
- Refresh → `POST /api/billing/connect/status` → updates chargesEnabled/detailsSubmitted.
- `?connect=success|return` → success toast "Stripe connected — verifying…";
  `?connect=refresh` → warning "The onboarding link expired. Click to resume."
- Mount LAWN-ONLY (hide on construction — `isLawn()` from `@/lib/variant`).

### 2. Admin billing page wiring (`src/app/admin/billing/page.tsx`)

The page already reads `tenant.orgId` + uses the RLS session `supabase` client
and passes a `accountingSection` to `<BillingForm>`. Add a **"Customer
payments"** section (separate from bookkeeping) — lawn-only — that:
- Selects `stripe_connect_account_id, connect_charges_enabled, connect_details_submitted`
  from `organizations` (add to the existing org read or a new one).
- Renders `<ConnectStripeButton initialConnectAccountId=… initialChargesEnabled=…
  initialDetailsSubmitted=… />`.
- Copy: "Connect your Stripe account to accept online invoice payments. You're
  the merchant of record — we never touch your customers' money or take a cut.
  Stripe runs the verification." (This is the user-authorized reversal of the
  old "platform never touches customer money" copy — make the new posture clear.)
- Pass it into `<BillingForm>` as a new prop (e.g. `customerPaymentsSection`)
  and render it above or below the accounting section. Mirror how
  `accountingSection` is threaded.

### 3. `src/app/invoices/view/[token]/InvoicePayPanel.tsx` (RECOVER + ADD save-card)

Recover the deleted file:
```
git show "a1aa564:src/app/invoices/view/[token]/InvoicePayPanel.tsx"
```
Adaptations:
- Keep the Pay button (`POST /api/invoices/pay/{token}` → redirect to
  `data.url`) + the paid/justPaid/canceled banners.
- **Add a "Save card for auto-pay" button** below Pay:
  `POST /api/invoices/save-card/{token}` → `window.location.assign(data.url)`.
  Hint text: "Save a card and we'll charge it automatically when invoices are
  due." Show only when `canPay` (same gate as Pay).
- Add a `?card=1` success banner (green): "Card saved — future invoices will be
  charged automatically." (The save-card route's success_url is
  `/invoices/view/{token}?card=1`.)
- Props: `{ token, balanceDueStr, canPay, paid, justPaid, canceled, cardSaved }`.
  When `!canPay && !canceled && !cardSaved` render nothing (hidden when org not
  ready / invoice not payable — same as before).

### 4. `src/app/invoices/view/[token]/page.tsx` (EDIT — re-mount the panel, lawn only)

This page was made read-only in `3ea62c3` (replaced InvoicePayPanel with
InvoiceStatusBanner). Re-add the panel for the LAWN variant:
- Add `connect_charges_enabled` to the `organizations` select (the page already
  loads the org for name/address/phone/email/logo).
- Compute `canPay = !isPaid && status !== "void" && balanceDue > 0 &&
  !!orgConnectChargesEnabled` (NO payouts gate).
- Read query params: `paid` (justPaid), `canceled`, `card` (cardSaved).
- Render `<InvoicePayPanel>` (lawn only — gate with `isLawn()`; construction
  keeps `<InvoiceStatusBanner>` read-only, since construction orgs have no
  connected account and `canPay` would be false anyway, but keep the page clean
  by not rendering the panel on construction).
- Keep `<InvoiceStatusBanner>` for the paid/void display states; the panel is
  the interactive Pay/Save-card surface beneath it.

## API contracts (what your fetches return)

- `POST /api/billing/connect/start` → `{ url }` (302 to Stripe) or
  `{ error }` (401/403/404/502).
- `POST /api/billing/connect/status` →
  `{ connected, chargesEnabled, detailsSubmitted, error? }`.
- `POST /api/invoices/pay/[token]` → `{ url }` or `{ error }` (400 expected /
  500 unexpected).
- `POST /api/invoices/save-card/[token]` → `{ url }` or `{ error }`.

## Notes / don'ts

- Do NOT touch the server files (connectAccount/invoicePay/invoiceCharge/routes/
  webhook/lawnBilling/proxy) — Claude-direct owns them; they're build-gated.
- Do NOT add a payouts gate anywhere — charges_enabled only.
- Do NOT ship this handoff doc (untracked).
- Do NOT ship the ISP billing files (`ispBilling.ts` etc.) — they stay on
  feat/isp-installs-module.
- The `customer_payment_methods.sql` is NOT yet live — Claude-direct will have
  the user run it. The UI doesn't depend on it (it only needs the org connect
  columns, which already exist).
- Blue primary `bg-blue-600` on BOTH deploys (don't switch to green for the
  pay buttons).

## Verification (Opus builds; Claude-direct + user verify)

After Opus builds the 4 pieces, Claude-direct re-runs the build gate (tsc +
lawn build + construction build). Then USER browser-E2E (lawn test org, Stripe
TEST connected account — NOT the live platform account): connect → pay an
invoice → save a card → trigger cycle billing auto-charge → decline path →
already-paid idempotency → construction shows no Pay button. See the plan file
`resilient-crunching-barto.md` Verification section for the full E2E.