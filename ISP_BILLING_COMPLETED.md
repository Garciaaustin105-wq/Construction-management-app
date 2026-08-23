# ISP subscriber billing — what was completed

Written 2026-08-22 by the Claude Code (Opus 5) session that built it, in
response to the "ISP Billing — Handoff Brief" pasted from the other Opus chat.

Branch `feat/isp-installs-module`. Supabase `avmqteevisqxwmmxkrbg`.

**Read the "Conflicts with the newer brief" section at the bottom before
building the next phase.** Two decisions in this code contradict the newer
brief now sitting in `ISP_BILLING_HANDOFF.md`.

---

## State

| | Status |
|---|---|
| App code | On disk. `tsc --noEmit` clean, `next build` exit 0, lint clean (0 issues in new files). |
| Database | **Migrations NOT applied.** Parser-validated only (see below). |
| Stripe dashboard | **Not configured.** Connect not enabled, no webhook endpoint. |
| Env | `STRIPE_ISP_WEBHOOK_SECRET` not set. |
| Git | **Uncommitted.** Tree also carries unrelated uncommitted work. |
| Browser / Stripe testing | **Never run.** Nothing exercised against a real Stripe account. |

**Validation method for the SQL:** both files were executed against the live
database inside `begin; … rollback;`, completed without error, and were then
confirmed to have left nothing behind (`isp_tables=0`, `isp_funcs=0`,
`isp_triggers=0`). So syntax, FK targets, RLS helper signatures, and trigger
bodies are verified against the real schema — but no DDL is committed. The user
runs migrations in the SQL editor, per the standing rule.

---

## The one decision that changed the design

The brief specified **BYO Stripe secret keys** (org pastes `sk_live_…`, stored
AES-encrypted via the `accounting/crypto.ts` pattern).

**The product owner rejected that and chose Stripe Connect**, after asking
which option kept them least involved in other orgs' data and money. Three
consequences, all of which make this code look unlike the brief:

1. **No `isp_stripe_connections` table, no encrypted credentials, no
   `crypto.ts` import.** We store an `acct_…` id and nothing else — there is no
   secret to encrypt. A DB breach yields account identifiers, which are useless
   alone, and the org can revoke platform access from their own Stripe
   dashboard.
2. **No OAuth.** Stripe no longer recommends OAuth for connecting accounts
   (single-platform policy — an existing Stripe account generally can't be
   attached to another platform). Current path is `accounts.create` + a
   Stripe-hosted onboarding link. No `ca_…` client id, no redirect URI, no
   `state` HMAC.
3. **Webhook routing is trivial.** The brief's "decrypt-match every org's
   webhook secret to work out who this is" is unnecessary — connected-account
   events carry `event.account`.

### Liability — the part not to casually change

Stripe assigns dispute/refund/negative-balance liability by **where the charge
lives**, not by account type. The app's first Connect attempt (`e2cf93c`, since
removed) used Express accounts + **destination** charges, putting every
subscriber chargeback on the *platform's* balance and causing Stripe to hold a
reserve against it. This module inverts that:

- **Direct charges** — every call carries the org's `Stripe-Account` header, so
  the charge is created on the org's account and they are merchant of record.
- `controller.losses.payments = "stripe"` — Stripe, not the platform, absorbs
  unrecoverable negative balances. Only permitted with direct charges.
- `controller.fees.payer = "account"`, `stripe_dashboard.type = "full"`,
  `requirement_collection = "stripe"` — the Standard-account equivalent, since
  legacy `type: "standard"` is deprecated.

**Never add `transfer_data`, `application_fee_amount`, or `on_behalf_of`** to
`ispBilling.ts` / `ispSubscriptions.ts` — any of them silently reassigns
liability back to the platform. Full reasoning is in the header of
`src/lib/ispBilling.ts`.

`src/lib/billing.ts` is **unmodified** (its `getStripe()` is imported, not
redefined). `/api/stripe/webhook` and the platform SaaS path are untouched.

---

## Three Stripe SDK 22 shape changes worked around

Each is a silent runtime `null` if written the older way — none is a build
error. All three are isolated in shim readers at the top of
`src/lib/ispSubscriptions.ts`:

| Old (still in most examples) | Actual — SDK 22 / OpenAPI v2349 |
|---|---|
| `invoice.subscription` | `invoice.parent.subscription_details.subscription` |
| `subscription.current_period_end` | `subscription.items.data[].current_period_end` (per-item now) |
| `invoice.payment_intent` | `invoice.payments.data[].payment.payment_intent` — and `payments` is **only present when expanded**, so usually absent in webhook payloads |

That third one is why `invoicePaymentRef()` falls back to `invoice.id` as the
dedupe key. Also: `Stripe.Account` has no `livemode` in the SDK types, so
`isLiveMode()` derives it from the key prefix.

---

## What was built

### SQL (run A then B; Notepad paste, not the web editor)

- **`isp_billing_a.sql`** — `isp_plans` (catalog, mirrors `install_types`),
  `isp_connect_accounts` (one row/org, no credentials),
  `isp_billing_events` (webhook idempotency log),
  `organizations.dunning_grace_days` (default 14, bounded 0–90),
  `customers.service_plan`
- **`isp_billing_b.sql`** — `isp_subscriptions`, `isp_customer_profiles`,
  `sync_isp_service_suspended()` trigger (keeps `service_suspended`
  denormalized), `guard_install_create_suspended()` (blocks new installs for
  suspended subscribers, mirroring `guard_job_create()`)

Verification queries are commented at the bottom of each file.

> `customers.service_plan` did **not** exist when this session started but
> **does now** — it was run mid-session. `isp_billing_a.sql` includes it as an
> idempotent no-op. That also fixed a live bug: the uncommitted customer pages
> were selecting a column that didn't exist.

### Library

- `src/lib/ispBilling.ts` — connected-account lifecycle, `forAccount()` header
  helper, the liability-critical `accounts.create`, lazy plan→Price creation on
  the org's account, Stripe→app status mapping
- `src/lib/ispSubscriptions.ts` — enrollment, webhook state sync, dunning
  transitions, internal invoice mirror + accounting push, dunning emails
- `src/lib/ispModule.ts` — server-side `isIspOrg()` gate

### Routes

`/api/isp/connect/{start,refresh,disconnect}` ·
`/api/isp/stripe/webhook` · `/api/isp/cron/dunning` · `/api/isp/settings` ·
`/api/isp/subscriptions/{enroll,portal,cancel}`

### UI

- `/admin/isp/plans` + `IspPlansManager.tsx`
- `/admin/isp/billing` + `IspBillingPanel.tsx`
- ~~`/portal/subscription` + `PortalSubscriptionView.tsx`~~ **DELETED** — see Phase 2 below
- `/isp/checkout/complete` — public, unauthenticated Stripe return page
- `IspCustomerPanel.tsx` — the "Internet" tab, injected into
  `CustomerDetail.tsx` through a new optional `ispPanel` **slot prop**, so the
  shared component stays variant-neutral
- Two tiles on `/manage`, gated on `isIspOrg`

`vercel.json` gained `/api/isp/cron/dunning` at `35 13 * * *`.
`ISP_BILLING_SETUP.md` documents the Stripe dashboard steps and a test-mode
end-to-end script.

---

## Design notes worth not re-litigating

- **Enrollment returns a Checkout link; it does not create the subscription.**
  The subscriber must enter their own card and clear 3DS. A server-created
  subscription with no payment method dies as `incomplete` after ~23h — looks
  like success until it isn't.
- **`status` is our vocabulary, not Stripe's.** `suspended` has no Stripe
  equivalent; only the cron produces it. `mapStripeStatus()` deliberately won't
  knock a suspended row back to `past_due` on a Stripe retry.
- **The event log is a claim, not an audit trail.** Insert `handled=false` →
  process → set `handled=true`. Duplicate with `handled=true` is acked;
  duplicate with `handled=false` is *re-processed*. The naive "insert first,
  return early on duplicate" silently drops every event whose first attempt
  failed.
- **Grace clock set once per episode.** Stripe fires `invoice.payment_failed`
  on every retry over ~3 weeks; re-stamping would push suspension forward
  forever.
- **Cron suspends; the webhook restores.** `invoice.paid` restores service the
  moment money lands, not up to 24h later.
- **Suspend first, email second** in the cron — if Resend is down the cutoff
  still applies.
- **`/api/isp/settings` exists only because `organizations` UPDATE RLS requires
  `role = 'admin'` literally**, while every other ISP surface uses
  `isOfficeLike` (which admits `office`). Client-direct would update zero rows
  with no error for office users.
- **No proxy gating for `/admin/isp/*`** — matches `/installs`, which also
  isn't in `BLOCKED_PAGE_PREFIXES`. Per-page guards + RLS instead.

---

## Known gaps (deliberate, flagged not hidden)

- **Setup fees stored and displayed but never charged.**
  `isp_plans.setup_fee_cents` is recorded; wiring it as a one-off Checkout line
  item is not done.
- **Router online status is a manual toggle** — no ping/SNMP/TR-069 probe.
  Labelled "set by hand" with a timestamp so it can't read as live telemetry.
- **Price edits apply to new sign-ups only** (Stripe Prices are immutable). The
  admin UI says so explicitly.
- **Monthly interval only** (`billing_interval` constrained to `'month'`).
- **No plan-switching / proration UI** — cancel + re-enroll.

---

## Conflicts with the newer brief in `ISP_BILLING_HANDOFF.md`

That brief was written after this work and states two things this code
contradicts. Resolve these before building on top.

**1. Subscriber login.** The newer brief says (decided) ISP subscribers are
office-managed records with **no `auth.users`, no `profiles` row, no in-app
login**, and that an in-app subscriber portal is a later phase. This code ships
one anyway:

- `/portal/subscription` + `PortalSubscriptionView.tsx` — a subscriber-facing
  page resolved through `profiles.customer_id`
- RLS policy `customer_read_own_isp_subscription` on `isp_subscriptions`, which
  uses the same bridge

Neither is harmful if unused: with no `profiles` row for subscribers, the page
redirects to `/dashboard` and the policy matches nothing. But the *intended*
subscriber touchpoint under the new model is the **Stripe-hosted Billing
Portal**, which is already built and works without any app login —
`/api/isp/subscriptions/portal` generates it, and the office can hand over the
link. Decide whether to delete the in-app portal page or keep it dormant for the
later phase.

**2. Stripe credential storage.** The newer brief still says "the platform only
stores the org's Stripe credentials (encrypted)" and points at the
`accounting/crypto.ts` pattern. **That is the design the owner rejected.** This
code stores no credentials at all. Following that line of the brief would
rebuild the rejected BYO-keys model and reintroduce the custody risk that
motivated the switch. Treat the brief as stale on this point.

---

## Next steps

1. Run `isp_billing_a.sql`, then `isp_billing_b.sql`.
2. Enable Connect + set platform branding in the Stripe dashboard.
3. Add the webhook endpoint at `/api/isp/stripe/webhook` with **"Events on
   connected accounts" checked** — without that box `event.account` is empty and
   every delivery is ignored. Set `STRIPE_ISP_WEBHOOK_SECRET`.
4. Walk section 7 of `ISP_BILLING_SETUP.md` end-to-end in test mode. **This is
   the largest untested surface** — nothing here has touched a real Stripe
   account.
5. Resolve the two conflicts above.
6. Commit.


---

# Phase 2 — 2026-08-22 (same session, after owner decisions)

Executed the four settled decisions relayed from the other Opus chat, then
built the two remaining features. `tsc` exit 0, `next build` exit 0, lint clean
in all new files.

## Decisions executed

**#2 + #3 — in-app subscriber portal removed.** ISP subscribers are
office-managed records with no `auth.users`/`profiles` row, so anything
resolving through `profiles.customer_id` was permanently dead:
- Deleted `src/app/portal/subscription/page.tsx` and
  `src/components/PortalSubscriptionView.tsx`.
- Removed the `customer_read_own_isp_subscription` policy from
  `isp_billing_b.sql` — **before that migration was ever run**, so this is a
  drop-from-file, not an apply-then-drop. A bare `drop policy if exists` is
  kept so any database that got an earlier draft converges.
- Stripped the subscriber branch from `/api/isp/subscriptions/portal`; it is
  now office-only. The API half and the RLS half were deleted together on
  purpose — either one alone is broken.

> **Consequence the decision didn't cover, handled here:** four live Stripe
> redirect targets pointed at the deleted page — Checkout `success_url` /
> `cancel_url` and the Billing Portal `return_url` (×2). Those are hit by a
> signed-OUT stranger mid-payment, so deleting the page without a replacement
> would 404 someone who just paid. Added **`/isp/checkout/complete`**: public,
> no `getMe()`, no RLS, and deliberately shows **no account data** (the URL
> carries no token and proves nothing about who is looking).

**#4 — `ISP_BILLING_HANDOFF.md` patched in place, append-only.** Added a dated
superseded banner, and inline ⛔ RETIRED / ✅ ACTUAL corrections at the
BYO-keys design decision, Feature 3, and the two "Repo facts" lines. Original
text left struck-through rather than removed so the change stays traceable.
(The brief's Feature 4 already said "no customer-side RLS / no in-app customer
portal" — so #2/#3 bring the *code* into line with the brief, not away from it.)

## Feature 0 — business type at signup

`business_types.sql` (new, **not run**, rollback-validated):
- `organizations.business_types text[] not null default '{}'`
- CHECK: elements drawn from `{construction, lawn, isp}` **and**
  `cardinality >= 1`. Created `NOT VALID`, then backfilled, then
  `VALIDATE CONSTRAINT` — so the rule binds new writes immediately without
  rejecting the existing all-empty rows mid-migration, and the validate step
  *proves* the backfill was complete rather than silently partial.
- Backfill derives from evidence, not hardcoded ids: `app_variant` gives the
  primary trade, `isp_module_enabled` adds `isp`. Verified against live data —
  Terra Vista resolves to `{construction, isp}`, the other three to
  `{construction}` / `{lawn}` / `{lawn}`.
- GIN index for `business_types @> array['isp']`.

**Array column, not a join table** (the brief left this open): business type is
read on essentially every page load for nav, and the org row is already fetched
there — a column rides that read for free, a join table adds a query to the
hottest path. Three closed values buy nothing from normalization.

**`get_my_tenant()` deliberately NOT modified.** Its fixed `returns table(...)`
signature means adding a column needs DROP + CREATE on the login path. Nothing
in Feature 0/1 needs it, so it was left alone; read via
`src/lib/businessTypes.server.ts` instead. Do the RPC change as its own
migration when nav actually branches on business type.

Code:
- `src/lib/businessTypes.ts` — constants, labels, `parseBusinessTypes`,
  `hasBusinessType`. **Client-safe by contract**: the signup form imports it, so
  it must never import `@/lib/supabase/server` (that drags `next/headers` into
  the browser bundle and hard-fails the build — it did, once).
- `src/lib/businessTypes.server.ts` — the DB read, split out for that reason.
- `/api/signup` — accepts `business_types`, drops unrecognized values (a bad
  value would fail the CHECK and lose the whole signup), falls back to the
  deploy variant when absent so older cached bundles still work. **Built on top
  of f33a971's lawn free-tier branch, not over it.**
- `SignupForm.tsx` — multi-select, seeded with the deploy variant, and refuses
  to reach zero selections (empty would 500 against the cardinality check at
  the very last step of signup).

## Feature 1 — Add customer on Home

- Dashboard gains an **Add customer** tile in the Create block for ISP orgs,
  office/admin only. Gated on `isp_module_enabled` **OR**
  `business_types @> {isp}` — either alone would miss a real ISP org during the
  migration window.
- Links to `/admin/customers?add=1`; `CustomersManager` now focuses and scrolls
  the name field on that param, so the tile lands you with a cursor in the box
  rather than at the top of a list — which was the "buried under Admin" problem
  the tile exists to fix.
- When the ISP tile is shown, the New Project tile steps down from primary blue
  to secondary so there aren't two competing calls to action.
- `/admin/customers` page wrapped in `<Suspense>` (required by
  `useSearchParams`).

## Migrations now pending, in order

1. `isp_billing_a.sql`
2. `isp_billing_b.sql`  ← now without the customer-side policy
3. `business_types.sql`

All three are additive, idempotent, and rollback-validated against the live
schema. **None has been run.**

## Still untested

The entire Stripe path — no connected account, no webhook endpoint, no
`STRIPE_ISP_WEBHOOK_SECRET`. Section 7 of `ISP_BILLING_SETUP.md` is the script.
Nothing in phase 2 has been opened in a browser either.
