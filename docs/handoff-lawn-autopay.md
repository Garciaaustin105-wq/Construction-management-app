# Opus handoff — Lawn autopay + dunning (Connect phase 2)

Prepared 2026-08-23, after shipping `d5f3331` (Connect customer payments) to main.
Read this whole file before writing code. The liability section is not
background — it changes the build order and adds a gate that must exist before
any payment UI is exposed.

Full competitive context: `GORILLADESK_FEATURE_ADOPTION.md` (one dir up).

---

## ⚠️ Read first — the liability constraint

The platform runs **direct charges** on connected accounts. Who absorbs an
unrecoverable loss (chargeback, refund past balance, fraud) is decided by
`controller.losses.payments` on the connected account, and that property is
**immutable after account creation**.

`src/lib/connectAccount.ts` creates accounts correctly — this is the
Standard-equivalent config and the comment block explaining it is accurate:

```
controller: {
  stripe_dashboard:       { type: "full" }
  fees:                   { payer: "account" }
  losses:                 { payments: "stripe" }   ← Stripe absorbs losses
  requirement_collection: "stripe"
}
```

**But both existing live accounts predate that code and are wrong.** Verified
against the Stripe API 2026-08-23:

| Org | Account | `losses.payments` | State |
|---|---|---|---|
| Peanutz L&L (lawn) | `acct_1U5HAM…` | **`application`** | fully onboarded, charges + payouts enabled, bank attached |
| Terra Vista (construction) | `acct_1U585OF…` | **`application`** | never onboarded — no ToS, no bank, no capabilities, charges disabled |

`losses.payments = "application"` means **the platform account is liable** for
that org's chargebacks. That is exactly the exposure the owner deliberately
avoided in the first payments pivot.

### Known constraint from the owner (2026-08-23)

**Peanutz will NOT re-create their Stripe account right now.** So the app must
be safe to ship while a live, fully-onboarded, platform-liable account exists.
Do not design around "we'll fix the account first" — you can't.

### The trap in the current code

`src/app/api/billing/connect/start/route.ts`:

```ts
let accountId = org.stripe_connect_account_id ?? null;
if (!accountId) { accountId = await createConnectedAccount(...) }
```

An account is only created when the column is **null**. Both orgs will reuse
their existing Express accounts forever, so the correct config in
`connectAccount.ts` can never take effect for them. Clearing a stale id is
therefore **required** for any re-onboard to work — not cosmetic.

---

## PHASE 1 — the liability gate — ✅ SHIPPED 2026-08-23 (`52037b8`)

> Built and on main. The gate lives inside `requireChargeableAccount()` — the
> chokepoint all three money paths already funnel through — rather than at each
> call site as originally specced below. `isPlatformLiable()` fails closed.
> `connect/status` returns `platformLiable`. Terra Vista's stale account id was
> cleared and Peanutz's loss owner backfilled.
>
> **Phases 2 + 3 are now specced in `docs/handoff-lawn-autopay-phase2.md`** —
> start there. The section below is kept for the reasoning only.

## PHASE 1 (original spec — for reference)

No payment surface may be exposed for a connected account whose losses fall on
the platform. Build the gate before the UI that needs it.

### 1a. Cache the loss owner

New column, mirroring the two flags `refreshConnectAccount` already caches:

```sql
alter table public.organizations
  add column if not exists connect_losses_owner text;
```

Nullable, additive, no RLS change (new columns inherit the table's existing
policies — same as `connect_charges_enabled` was added). **NEW SQL — draft it as
`connect_losses_owner.sql` in the repo root and get Claude-direct's sign-off
before running. Do not run it yourself.**

### 1b. Populate it

`src/lib/connectAccount.ts` → `refreshConnectAccount()` already calls
`stripe.accounts.retrieve` and writes `connect_charges_enabled` /
`connect_details_submitted`. Add:

```ts
connect_losses_owner: account.controller?.losses?.payments ?? null,
```

It's on the same object already being fetched — no extra Stripe call.

### 1c. One helper, used everywhere

```ts
/** True when the PLATFORM absorbs this org's chargebacks — i.e. the account
 *  predates the Standard-equivalent controller config. Payments must stay
 *  closed for these orgs. Null (never refreshed) is treated as unsafe. */
export function isPlatformLiable(losesOwner: string | null): boolean {
  return losesOwner !== "stripe";
}
```

Fail **closed**: null → liable → payments off. An org that has never been
refreshed must not get a Pay button by default.

### 1d. Apply it in both places

- **UI gate** — any Pay / Save-card affordance renders only when
  `connect_charges_enabled && !isPlatformLiable(connect_losses_owner)`.
- **Server gate** — `chargeInvoiceOffSession` (`src/lib/invoicePay.ts`) must
  bail with `{ charged: false, reason: "platform-liable account" }` before
  touching Stripe. Autopay runs server-side from cycle billing; a UI-only gate
  would not stop it.

### 1e. Tell the office why

On the lawn billing page, when an org is platform-liable, show a plain
explanation rather than a silently missing button — something like: *"Online
payments are turned off for this account. It was connected under our previous
setup, which would place chargeback liability on the platform. Reconnect to
enable payments."* Wording is yours; the requirement is that it is **visible and
actionable**, not a silent no-op.

**Net effect:** Peanutz stays dormant and safe with no action from them; any org
onboarding through current code works immediately; the block self-resolves the
day Peanutz reconnects. Nothing is hardcoded to an account id.

### 1f. Clear the dead Terra Vista id

`acct_1U585OF…` is an abandoned stub — never onboarded, cannot move money, and
it's the owner's own construction org (Connect is lawn-only; `connect/status`
403s on `!isLawn()`). Clearing `organizations.stripe_connect_account_id` for
`7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b` unblocks the create path if construction
payments are ever wanted. **A data write — get sign-off, don't run it.**

---

## PHASE 2 — consent (must ship WITH Phase 3, never after)

There is currently **no autopay flag anywhere** — grep for `autopay`,
`auto_pay`, `autoCharge` returns nothing. Meanwhile `src/lib/lawnBilling.ts:175`
already calls `chargeInvoiceOffSession({ invoiceId })` on **every** cycle-billed
invoice.

So today the mechanism is fully wired and inert only because nobody can save a
card. **The moment a card exists, every future cycle invoice charges
automatically with no opt-out for the customer or the office.** That is why
consent cannot land after the save-card UI.

Add to the same signed-off migration:

```sql
alter table public.customers
  add column if not exists autopay_enabled boolean not null default false;
```

Default **false** — saving a card must not silently enrol anyone. Then:

- `chargeInvoiceOffSession` requires `autopay_enabled` in addition to a saved card.
- Office UI on the customer record: show card-on-file (`stripe_card_brand`,
  `stripe_card_last4`, `stripe_card_exp_month/year` are already columns) and a
  toggle to enable/disable autopay.
- The save-card flow should make enrolment explicit to the customer, not implied.

---

## PHASE 3 — expose the payment paths

Both routes exist and **nothing links to them** — grep `invoices/pay/` and
`save-card` across `src/` returns only the route files themselves:

- `src/app/api/invoices/pay/[token]/route.ts` → Checkout session, returns `{ url }`
- `src/app/api/invoices/save-card/[token]/route.ts` → setup session, returns `{ url }`

Both key off the invoice `share_token`, so the natural home is the public
invoice view: `src/app/invoices/view/[token]/page.tsx`.

**Note the contradiction you are resolving.** `InvoiceStatusBanner.tsx`
currently says, in shipped code:

> *"Per the payments pivot the platform never touches customer money — there is
> NO in-app Pay button… The customer pays on their OWN accounting provider's pay
> page (QBO/Xero/FreshBooks), or offline."*

The owner has confirmed **the pivot is reversed for the LAWN side**. So that
copy is stale for lawn and must change — but it may still be correct for
construction. Do not blanket-delete it; gate it by variant and keep the
construction wording intact unless told otherwise.

Gate the Pay / Save-card affordances on:
`isLawn() && connect_charges_enabled && !isPlatformLiable(...)`.

---

## PHASE 4 — dunning (the failure path)

The owner's own `a6a2221 docs(isp): flag dunning as the highest-risk untested
path` still stands, and it matters more now that money can actually move.

Current state:
- `payment_intent.payment_failed` is **not subscribed** on the Stripe webhook
  destination (only `checkout.session.completed`, `setup_intent.succeeded`,
  `account.updated`). It needs adding in the Stripe Dashboard — editing an
  endpoint's events does **not** rotate the signing secret.
- The handler for it exists and writes an `invoice_payment_failed` notification.
- **`organizations.dunning_grace_days` does NOT exist in prod** — verified.
  Anything referencing it is from the stashed ISP branch, not live.

Scope a retry/notify policy before building. Minimum viable: a failed autocharge
leaves the invoice `sent` (already the behaviour), notifies the office, and does
not silently retry forever.

---

## Verified schema facts (2026-08-23 — don't re-derive)

- `customers` already has: `stripe_customer_id`, `stripe_payment_method_id`,
  `stripe_card_brand`, `stripe_card_last4`, `stripe_card_exp_month`,
  `stripe_card_exp_year`. All live (`customer_payment_methods.sql` is applied).
- `organizations` has `stripe_connect_account_id`, `connect_charges_enabled`,
  `connect_details_submitted`. **No** `connect_payouts_enabled`, **no**
  `dunning_grace_days`.
- `invoices` has `stripe_payment_intent_id`, `amount_paid`, `share_token`.
- `billing_events` exists (webhook idempotency via `stripe_event_id`).
- Webhook destination `we_1U88ZX…` → `https://www.terraverdelawnmanagement.com/api/stripe/connect/webhook`,
  connected-accounts scoped, three events, live and verified.
- **The apex domain 308-redirects to `www`.** Stripe does not follow redirects.
  Any new webhook/callback URL must use the `www` form.

## Ground rules

- Blue primary (`bg-blue-600`) on BOTH deploys; lawn green is chrome only.
- Role gates EXACT vs `src/lib/navItems.ts`. On lawn, `project_manager` gets base
  nav only; office surfaces are office + admin. `super_admin` (null org) bounces.
- **No new SQL without sign-off.** Draft the migration, do not run it.
- RLS session client for reads; service role server-only.
- Public/token portals get NO `PageContainer` app chrome.
- Never `git add -A`. No commit/push without the user saying "push".

## Build gate

Build FIRST, then tsc — `rm -rf .next` before tsc **breaks** it (`LayoutProps`
is a Next-generated global living in `.next/types`).

```
NEXT_PUBLIC_APP_VARIANT=lawn npx next build
NEXT_PUBLIC_APP_VARIANT=construction npx next build
npx tsc --noEmit
```

## Report back

1. The migration you drafted, and confirmation you did NOT run it.
2. Proof the liability gate fails closed — what a platform-liable org sees, and
   that `chargeInvoiceOffSession` refuses before calling Stripe.
3. File list.
4. Build-gate results.
5. Any drift from the schema facts above. This document has been wrong before;
   verify before you build and say so if reality differs.
