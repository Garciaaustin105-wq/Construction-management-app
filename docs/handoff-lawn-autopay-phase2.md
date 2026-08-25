# Opus handoff — Lawn autopay Phases 2 + 3 (consent, then expose payments)

Prepared 2026-08-23. Phase 1 (liability gate) is **SHIPPED**. This doc is
self-contained: read it, build Phases 2 and 3 **together**, report back.

Background/why: `docs/handoff-lawn-autopay.md` (the 4-phase plan) and
`GORILLADESK_FEATURE_ADOPTION.md` (competitive context, one dir up).

---

## ⚠️ Read first

- Repo `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app`, branch from
  `origin/main` (== `52037b8`). **Re-check `git status` before you start** —
  multi-session repo, the tree moves.
- Untracked files that are NOT yours: `.claude/launch.json`,
  `CONNECT_PAYMENTS_HANDOFF.md`, `PHASE1_CONTENT_PACKAGE.md`,
  `TERRA_VERDE_MARKETING_PLAN_2026-08-23.md`. Leave them; never `git add -A`.
- **`stash@{0}`** holds unrelated ISP WIP. Do NOT pop.
- **No new SQL** — Phases 2 and 3 need none (see Schema facts). If you think you
  need a column, stop and come back for sign-off.
- No commit/push without the user saying "push".

## ⚠️ THE SEQUENCING HAZARD — why 2 and 3 ship together

`src/lib/lawnBilling.ts:175` **already calls** `chargeInvoiceOffSession()` on
every cycle-billed invoice. It is inert today only because no customer has a
saved card — nothing in the app links to `/api/invoices/save-card/[token]`.

The moment you expose a save-card link (Phase 3) **without** consent (Phase 2),
the first customer who saves a card is auto-charged on every future cycle
forever, with no opt-out for them or the office.

So: **make `chargeInvoiceOffSession` require `autopay_enabled` BEFORE you
expose any save-card affordance.** Shipping Phase 3 alone is a live billing
incident.

---

## What Phase 1 already gives you (do NOT rebuild)

`src/lib/connectAccount.ts`:
- `ConnectAccount` carries `lossesOwner` (raw Stripe value) + derived
  `platformLiable`.
- `isPlatformLiable(lossesOwner)` — exported, **fails closed** (`!== "stripe"`,
  so null = liable).
- `refreshConnectAccount()` caches `controller.losses.payments`.
- **`requireChargeableAccount()` throws for a platform-liable account.** This is
  the single chokepoint — `invoiceCharge.ts:115`, `invoicePay.ts:80` and
  `invoicePay.ts:341` all call it, so every money path is already gated. Your
  new code inherits this automatically. Do not add a second liability check.

`src/app/api/billing/connect/status/route.ts` returns **`platformLiable`** on
all three response paths, so UI gates without its own Stripe call.

Live state: Peanutz L&L is `charges_enabled=true` but `losses_owner=application`
→ **blocked**. The other three orgs have no connected account.

---

## PHASE 2 — consent

### 2a. Honor the flag in the charge path
`src/lib/invoicePay.ts` → `chargeInvoiceOffSession()`. It currently checks for a
saved card (`stripe_customer_id` + `stripe_payment_method_id`) and returns
`{ charged: false, reason: "no saved card" }`. Add `autopay_enabled` to that
same customer read and refuse when false:

```ts
if (!customer?.autopay_enabled)
  return { charged: false, reason: "autopay not enabled" };
```

Keep the `{charged, reason}` shape — `lawnBilling.ts` wraps this in try/catch
and a falsy result must leave the invoice `sent` so it still delivers normally.

### 2b. Office control
`src/components/CustomersManager.tsx` is the office customer directory. Its
`Customer` type is currently
`{ id, name, contact_name, contact_email, phone, address, notes }` — extend it
and the selects with `autopay_enabled` plus the card display columns that
already exist on the table (`stripe_card_brand`, `stripe_card_last4`,
`stripe_card_exp_month`, `stripe_card_exp_year`).

Show card-on-file as `Visa ····4242 · 12/27` and an autopay toggle. Rules:
- Toggle is **disabled with an explanation when there is no saved card** —
  enabling autopay without a card is meaningless and would read as broken.
- Turning it **off** must always be possible, including when the org is
  platform-liable. Revoking consent is never gated.

### 2c. Consent must be explicit at save time
Whatever Phase 3 renders for save-card must state plainly that saving enrolls
the customer in automatic charging of future invoices. Do not enable autopay as
a silent side effect of `setup_intent.succeeded` — the webhook stamps the card,
the customer's explicit action sets the flag.

---

## PHASE 3 — expose the payment paths

Both routes exist and **nothing links to them** (grep `invoices/pay/` and
`save-card` across `src/` — only the route files match):
- `src/app/api/invoices/pay/[token]/route.ts` → Checkout session, returns `{url}`
- `src/app/api/invoices/save-card/[token]/route.ts` → setup session, returns `{url}`

Both key off the invoice `share_token`, so the home is
`src/app/invoices/view/[token]/page.tsx` (currently renders `InvoiceDocument` +
`InvoiceStatusBanner`, no payment affordance at all).

### Gate every affordance on ALL THREE
```
isLawn() && connect_charges_enabled && !platformLiable
```
`platformLiable` is not optional here. An account can be fully chargeable at
Stripe and still be one we refuse to use — that is the entire point of Phase 1.

### The stale copy you must resolve
`src/app/invoices/view/[token]/InvoiceStatusBanner.tsx` says, in shipped code:

> *"Per the payments pivot the platform never touches customer money — there is
> NO in-app Pay button… The customer pays on their OWN accounting provider's pay
> page (QBO/Xero/FreshBooks), or offline."*

**The owner has confirmed the pivot is reversed for the LAWN side only.** So:
gate this by variant — lawn gets the payment UI, construction keeps the existing
wording. Do **not** blanket-delete it.

### Office-facing explanation (carried over from Phase 1)
When an org is `platformLiable`, the office must see *why* payments are off, not
a silently missing button. Something like: *"Online payments are turned off for
this account. It was connected under our previous setup, which would place
chargeback liability on the platform. Reconnect to enable payments."* Wording is
yours; it must be visible and actionable. There was nowhere to put this in
Phase 1 because nothing consumed `connect/status` — your Phase 3 UI is the home.

---

## Schema facts (verified 2026-08-23 — no new SQL needed)

- `customers`: `autopay_enabled boolean NOT NULL DEFAULT false` ✅ live.
  Also `stripe_customer_id`, `stripe_payment_method_id`, `stripe_card_brand`,
  `stripe_card_last4`, `stripe_card_exp_month`, `stripe_card_exp_year`.
  **0 of 24 customers currently have a card or autopay on.**
- `organizations`: `stripe_connect_account_id`, `connect_charges_enabled`,
  `connect_details_submitted`, `connect_losses_owner`. There is **no**
  `connect_payouts_enabled` and **no** `dunning_grace_days`.
- `invoices`: `stripe_payment_intent_id`, `amount_paid`, `share_token`.
- Webhook `we_1U88ZX…` → `https://www.terraverdelawnmanagement.com/api/stripe/connect/webhook`,
  connected-accounts scoped, events: `checkout.session.completed`,
  `setup_intent.succeeded`, `account.updated`.
  **`payment_intent.succeeded` / `payment_intent.payment_failed` are NOT
  subscribed** — they only matter for off-session autopay, so once Phase 2 goes
  live they should be added in the Stripe Dashboard. Editing an endpoint's
  events does not rotate the signing secret.
- **The apex domain 308-redirects to `www`.** Stripe does not follow redirects.
  Any new webhook/callback URL must use the `www` form.

## Ground rules

- Blue primary (`bg-blue-600`) on BOTH deploys; lawn green is chrome only.
- Role gates EXACT vs `src/lib/navItems.ts`. On lawn, `project_manager` gets
  base nav only; office surfaces are office + admin. `super_admin` (null org)
  bounces from org-scoped pages.
- Public/token portals get **no** `PageContainer` app chrome.
- RLS session client for reads; service role is server-only.
- Never `git add -A`; stage only your files.

## Build gate

Build FIRST, then tsc — wiping `.next` **breaks** tsc (`LayoutProps` is a
Next-generated global that lives in `.next/types`). Note `rm -rf .next` also
fails intermittently on Windows ("Directory not empty") — you can skip it.

```
NEXT_PUBLIC_APP_VARIANT=lawn npx next build
NEXT_PUBLIC_APP_VARIANT=construction npx next build
npx tsc --noEmit
```

## Report back

1. Proof consent gates the charge: what `chargeInvoiceOffSession` returns for a
   customer with a card but `autopay_enabled = false`.
2. Proof the payment UI stays hidden for a `platformLiable` org (Peanutz is the
   live case), and what the office sees instead.
3. How you resolved the `InvoiceStatusBanner` construction/lawn split.
4. File list + build-gate results.
5. Any drift from the Schema facts above. **This document lineage has been wrong
   before** — an earlier version claimed `lot_sqft`/access-notes/lat-lng were
   missing when `lawn_jobs` already had them, and claimed a
   `dunning_grace_days` column that does not exist. Verify before you build, and
   say so if reality differs.
