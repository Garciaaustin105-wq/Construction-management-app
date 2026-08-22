# ISP Subscriber Billing — Setup

How an org bills its fiber/internet customers monthly. Companion to
`STRIPE_BILLING_SETUP.md` (which covers the **platform's** SaaS billing — a
different Stripe surface that this does not touch).

---

## The model, in one paragraph

Each org connects **their own Stripe account**. Their subscribers' cards are
charged **directly on that account** — the money never enters the platform's
Stripe balance, and the platform takes no fee. The org is merchant of record:
their disputes, their refunds, their payouts, their Stripe fees, their 1099s.
The platform stores only an `acct_…` identifier, never a secret key, and the org
can revoke platform access from their own Stripe dashboard at any time.

### Why this matters (and what NOT to change)

Stripe assigns liability by **where the charge lives**, not by account type.

| | This module | The removed 2026-08 attempt (`e2cf93c`) |
|---|---|---|
| Charge type | **Direct** — on the org's account | Destination — on the platform |
| Chargeback hits | The org's balance | **The platform's balance** |
| Negative-balance liability | **Stripe** (`losses.payments: "stripe"`) | The platform |
| Reserve held against platform | No | Yes |

The single change that would silently undo all of this is switching to
destination charges. If you ever find yourself adding `transfer_data`,
`application_fee_amount`, or `on_behalf_of` in `src/lib/ispBilling.ts` or
`src/lib/ispSubscriptions.ts` — stop. See the header comment in `ispBilling.ts`.

---

## 1. Run the migrations

In the Supabase SQL editor, **paste from a text editor (Notepad), not the web
editor** — it mangles single quotes. In order:

1. `isp_billing_a.sql` — plan catalog, Connect link, webhook event log, grace-days column
2. `isp_billing_b.sql` — subscriptions, ISP customer profiles, suspension trigger

Both are additive and idempotent (safe to re-run). Verification queries are
commented at the bottom of each file.

> `isp_billing_a.sql` includes `customers.service_plan`, which supersedes the
> standalone `customers_service_plan.sql`. If that column already exists the
> statement is a no-op.

---

## 2. Enable Connect on the platform Stripe account

One-time, in **your** Stripe dashboard (the platform account):

1. **https://dashboard.stripe.com/connect** → complete the platform profile.
   Stripe asks what your platform does and who your users are.
2. **https://dashboard.stripe.com/settings/connect** → set your platform's
   name, icon, and brand color. Your orgs see this branding on the onboarding
   screens, so it's worth filling in properly.

There is **no OAuth client ID to configure and no redirect URI to register.**
Stripe no longer recommends OAuth for connecting accounts (their single-platform
policy means an existing Stripe account generally can't be attached to another
platform). The app creates the connected account via the API and hands the user
a Stripe-hosted onboarding link instead.

---

## 3. Create the ISP webhook endpoint

Still in the platform Stripe dashboard → **Developers → Webhooks → Add endpoint**.

- **URL:** `https://<your-domain>/api/isp/stripe/webhook`
- **Listen to:** ✅ **Events on connected accounts** ← this checkbox is the whole
  thing. Without it, `event.account` arrives empty, the route can't tell which
  org an event belongs to, and every delivery is ignored.
- **Events:**
  - `account.updated`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`

Copy the signing secret into the env var below.

> This is a **second, separate** endpoint. Leave the existing
> `/api/stripe/webhook` (platform SaaS billing) exactly as it is — different
> URL, different secret, different events.

---

## 4. Environment variables

| Var | New? | Purpose |
|---|---|---|
| `STRIPE_ISP_WEBHOOK_SECRET` | **new** | Signing secret from step 3 |
| `STRIPE_SECRET_KEY` | existing | Platform key. Used only as the API *caller*; every call carries the org's `Stripe-Account` header |
| `CRON_SECRET` | existing | Authorizes the nightly dunning sweep |
| `RESEND_API_KEY` | existing | Dunning emails. Unset ⇒ emails are skipped, and nobody is marked "warned" without notice |

---

## 5. Cron

`vercel.json` now schedules `/api/isp/cron/dunning` at `35 13 * * *`
(≈08:35 CDT), just after the existing lawn reminder cron.

It only ever turns `past_due` → `suspended` once the grace window has elapsed.
**Restoration is not on the cron** — `invoice.paid` restores service the moment
money arrives, so someone who pays at 2am is back online at 2am.

---

## 6. Per-org setup (each ISP org does this once)

1. **Manage → ISP Billing → Connect Stripe.** Redirects to Stripe's hosted
   onboarding (bank details, identity, tax info — collected by Stripe, never by
   us).
2. Back in the app, the page re-reads the account. Returning from onboarding
   does **not** mean it finished — Stripe is explicit that `return_url` only
   means the flow was entered and exited. The page shows real status from
   `charges_enabled`.
3. **Manage → Plans** — define the packages sold (name, speed, monthly price).
4. Enroll a customer: **Customer → Internet tab → choose a plan → Create
   sign-up link**, then send that link to the customer. They enter their own
   card on Stripe's page (necessary for SCA/3DS; a server-created subscription
   without a payment method just dies as `incomplete` 23 hours later).

---

## 7. End-to-end test (test mode)

Use a **test-mode** platform key so the connected account is test-mode too.

1. Connect a test account; Stripe's onboarding accepts test data
   (SSN `000-00-0000`, routing `110000000`, account `000123456789`).
2. Create a plan, enroll a test customer, pay with `4242 4242 4242 4242`.
   → subscription goes `active`; an internal `invoices` row appears and is
   pushed to any connected bookkeeping provider.
3. Force a failure: in Stripe, swap the customer's card to
   **`4000 0000 0000 0341`** (attaches fine, fails on charge) and trigger the
   renewal.
   → status `past_due`, `grace_until` set, warning email sent.
4. Test the suspension without waiting 14 days — set `grace_until` into the past
   and invoke the cron:
   ```sql
   update isp_subscriptions set grace_until = now() - interval '1 day'
   where id = '<row id>';
   ```
   ```bash
   curl -X POST https://<your-domain>/api/isp/cron/dunning -H "Authorization: Bearer $CRON_SECRET"
   ```
   → status `suspended`, `isp_customer_profiles.service_suspended` flips via
   trigger, suspension email sent, and creating a new install for that customer
   is now blocked by `guard_install_create_suspended()`.
5. Pay the open invoice in Stripe → status `active`, grace cleared, restoration
   email sent.

### Confirm the platform surface is untouched

```sql
select count(*) from billing_events;   -- platform SaaS log: unchanged
select count(*) from isp_billing_events; -- ISP log: has your test events
```

`/api/stripe/webhook` and `STRIPE_SECRET_KEY`'s SaaS role are not modified by
this feature.

---

## Known gaps (deliberate, not oversights)

- **Router online status is a manual toggle.** There is no ping/SNMP/TR-069
  probe behind it. The UI says "set by hand" and timestamps it so it can't be
  mistaken for live telemetry.
- **Setup fees are stored but not charged.** `isp_plans.setup_fee_cents` is
  recorded and displayed; wiring it as a one-off Checkout line item is not done.
- **Price changes apply to new sign-ups only.** Stripe Prices are immutable —
  editing a plan's price mints a new Price for future enrollments. Existing
  subscribers keep their rate until moved deliberately. The admin UI says so.
- **Monthly interval only.** `billing_interval` is constrained to `'month'`;
  annual plans would need a new Price path.
- **No proration/plan-switching UI.** Changing someone's plan means cancel +
  re-enroll today.
