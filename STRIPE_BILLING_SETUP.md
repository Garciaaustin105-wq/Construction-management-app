# Stripe billing setup — Terra Vista / Terra Verde SaaS

Flat per-org monthly subscriptions. One Stripe account serves BOTH variants
(construction + lawn); the two Vercel deploys each point at their own price ids.
The platform never touches customer money — Stripe here is SaaS subs ONLY.

> Secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) live ONLY in Vercel env.
> Never commit them. This doc holds no secret values.

---

## 1. Prices to create in Stripe (6 total)

All prices: **Recurring → Monthly → USD**, quantity unit = 1 (flat per-org).
You can use one Product ("Terra Vista SaaS") with six prices, or one product per
tier — either works; the app maps tier by the **price id** env var, not by product.

### Construction variant  (price env → set on the construction Vercel project)
| Tier      | Amount  | Env var                          |
|-----------|---------|----------------------------------|
| Starter   | $49/mo  | `STRIPE_PRICE_STARTER_CONSTRUCTION` |
| Pro       | $149/mo | `STRIPE_PRICE_PRO_CONSTRUCTION`    |
| Business  | $399/mo | `STRIPE_PRICE_ENTERPRISE_CONSTRUCTION` |

### Lawn variant  (price env → set on the lawn Vercel project)
| Tier      | Amount  | Env var                          |
|-----------|---------|----------------------------------|
| Starter   | $29/mo  | `STRIPE_PRICE_STARTER_LAWN` |
| Pro       | **$149/mo** (NEW — was $99) | `STRIPE_PRICE_PRO_LAWN` |
| Business  | $199/mo | `STRIPE_PRICE_ENTERPRISE_LAWN` |

For each: Dashboard → Products → Add product → Recurring → Standard → Monthly →
USD → enter amount → Save → copy the `price_…` id → paste into the matching env
var on Vercel.

> The code falls back to the base env vars (`STRIPE_PRICE_STARTER`,
> `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ENTERPRISE`) if the variant-specific one is
> unset, so a half-migration keeps working. Prefer the variant-specific ones.

---

## 2. Grandfather existing lawn Pro subscribers ($99 → still Pro)

Stripe keeps an existing subscription on whatever price it started on — you do
NOT touch their sub. The only risk is the webhook's `priceIdToTier()` no longer
recognizing the OLD $99 price after you rotate `STRIPE_PRICE_PRO_LAWN` to the new
$149 id. Fix: list the old price id in `STRIPE_LEGACY_PRICES` so it still maps to
`pro`.

On the **lawn Vercel project**, set:
```
STRIPE_LEGACY_PRICES=price_OLD_LAWN_PRO_99:pro
```
Format is `price_id:tier` pairs, comma-separated. Add more retired ids the same
way (`price_x:pro,price_y:starter`). Existing $99 subs keep paying $99 (Stripe)
and keep syncing as `pro` (app) — grandfathered forever unless you migrate them
in Stripe explicitly.

If you also retire any construction price later, add its old id here too on the
construction project.

---

## 3. Webhook endpoint(s)

Code path: `POST /api/stripe/webhook` (one route handles both variants).

Because the two variants are on **different domains**, create **two endpoints**
in Stripe (Developers → Webhooks → Add endpoint), one per domain:

| Endpoint URL | Project |
|---|---|
| `https://terravistaconstructionmanagement.com/api/stripe/webhook` | construction |
| `https://terraverdelawnmanagement.com/api/stripe/webhook` | lawn |

Events to send (select exactly these):
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Each endpoint gets its own signing secret (`whsec_…`). Set on the matching
Vercel project as:
```
STRIPE_WEBHOOK_SECRET=whsec_…
```

> One Stripe account → two endpoints → two `whsec` values → one per Vercel
> project. The route is the same code; only the secret + domain differ.

---

## 4. Customer Portal — auto-configured (no manual setup)

`src/lib/billing.ts` `ensurePortalConfig()` creates a named, cancel-only portal
configuration on first use (subscription_update disabled, cancel/card/invoice
history enabled) and caches its id. This locks plan CHANGES out of the portal so
the only path to a cheaper plan is the guarded `/api/billing/checkout` (where the
downgrade guard runs). You do not need to create this in the Dashboard.

If you want to verify: Dashboard → Settings → Business settings → Customer
Portal → you'll see a non-default config with "Update subscriptions" off. The
Dashboard's default config is untouched.

---

## 5. Secrets + env summary

**Both Vercel projects** need:
- `STRIPE_SECRET_KEY` = live `sk_live_…`
- `STRIPE_WEBHOOK_SECRET` = that project's `whsec_…`
- The 3 price ids for that variant (table in §1)
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_VARIANT`
  (`construction` | `lawn`) — already set.

**Lawn project additionally**:
- `STRIPE_LEGACY_PRICES` = `price_OLD_LAWN_PRO_99:pro` (§2)

---

## 6. Verify after activation

- **Checkout amounts**: construction $49 / $149 / $399; lawn $29 / $149 / $199.
  Open `/admin/billing` on each deploy → click each tier → Stripe Checkout shows
  the right amount.
- **Grandfathered sub**: an existing $99 lawn Pro org should still read `plan=pro`
  in the app. In Supabase SQL Editor:
  ```sql
  select plan, plan_status, subscription_amount_cents
    from organizations
    where stripe_subscription_id is not null
    order by subscription_amount_cents desc;
  ```
  The $99 org shows `subscription_amount_cents = 9900` + `plan = pro` (synced via
  the legacy map), not an unmapped-price error in the logs.
- **Portal**: a subscriber opening "Manage billing" sees cancel/card/invoices but
  NO plan-change option.
- **Webhook**: in Stripe → Developers → Webhooks → the endpoint should show
  successful deliveries (not 400/500). A 401/invalid-signature means the
  `STRIPE_WEBHOOK_SECRET` doesn't match that endpoint's `whsec`.

---

## 7. Tier → limits reference (mirror in DB)

The price ids map to tiers; the tiers carry the limits enforced by the DB guards
(`plan_limits_v2.sql`, `storage_cap.sql`, `ai_action_gating.sql`). Keep these in
sync with `src/lib/plans.ts`:

| Dim | Starter | Pro | Business | Trial | Expired/Canceled |
|---|---|---|---|---|---|
| Price (construction) | $49 | $149 | $399 | — | — |
| Price (lawn) | $29 | $149 | $199 | — | — |
| Storage | 5GB | 25GB / **75GB lawn** | 100GB / 75GB lawn (soft) | ∞ | 0 |
| AI actions/mo | 0 | 100 | 5000 | 25 | 0 |
| Jobs (construction) | 10 | 50 | ∞ | ∞ | 0 |
| Jobs/properties (lawn) | 25 | 150 | 500 | ∞ | 0 |
| Seats | 5 | 25 | ∞ / 75 lawn | ∞ | 0 |
| Crew members | 15 / 25 lawn | 100 / 150 lawn | ∞ | ∞ | 0 |
| Customers | 50 / 100 lawn | 500 / 1000 lawn | ∞ | ∞ | 0 |