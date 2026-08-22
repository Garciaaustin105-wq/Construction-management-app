# ISP Billing — Handoff Brief

> Paste-ready brief for a separate (Opus) chat. It assumes the reader has NOT
> seen this repo. All facts below were verified live/by-code on 2026-08-22.
> Decisions marked **(decided)** were settled with the product owner.

## What this is
Build the customer + billing layer for the ISP module (fiber/ISP feature). The installs module (`installs`, `install_types`, `install_*` child tables, photos) and a free-text `customers.service_plan` already exist and are live for one org (Terra Vista). This adds: **business-type at signup**, **ISP customer onboarding (office-managed, no login)**, **owner-defined plan catalog**, **per-org customer billing via the org's own Stripe account**, **missed-payment dunning**, and **ISP customer-profile fields** (router rental, online status, equipment).

## Customer & business-type model (decided)

1. **Business type is additive / multi-select, not a new app variant (decided).**
   - Today the platform has `app_variant` ∈ {construction, lawn} (build-time, per-deploy) and a per-org boolean `organizations.isp_module_enabled`. Terra Vista is a construction org that ALSO does fiber, so ISP cannot be a single-choice variant.
   - Add an explicit, editable, multi-select **business type** on the org, chosen at signup. An org can be `construction + isp`, `lawn`, `isp` only, etc. The existing `app_variant` (build-time deploy split) stays; business type is a runtime org attribute that, together with module flags, drives which nav items + surfaces show for that org.
   - Suggested schema: a `organization_business_types` join table (`organization_id, business_type text check in ('construction','lawn','isp',...)`, unique pair) OR a `business_types text[]` column on `organizations`. Keep `isp_module_enabled` as the per-module gate (a construction+ISP org can toggle the ISP module). Nav adapts to the declared set.
   - Signup (`/api/signup`, `src/app/signup`) gains a "what kind of business are you?" multi-select step. Existing orgs get backfilled (construction orgs → `construction`; Terra Vista → `construction, isp`).

2. **ISP customers are office-managed records with NO in-app login (decided — do NOT reuse the construction Client Portal).**
   - The construction "Client Portal" is an *authed* customer model: `auth.users` with `role=customer`, `profiles.customer_id` bridge (`customer_rls.sql`), magic-link OTP, `/admin/clients` invite + `/customer` portal. That was built for the platform's *own* construction customers connecting to the platform. **It is wrong for ISP subscribers** and must NOT be reused for them.
   - ISP subscribers are plain `customers` rows: office creates + owns the record (contact, address, service plan, equipment, subscription). No `auth.users` entry, no `profiles` row, no magic link. The subscriber never logs into this app in this phase.
   - Subscriber touchpoints: emails (welcome, dunning, receipts) + a **Stripe-hosted Customer Portal link** (Stripe manages the payment method / invoices; the link is generated with the org's own Stripe key and sent/linked by the office). No in-app customer auth.
   - A **dedicated in-app ISP customer portal** (own login, view plan/bills/equipment) is a **later phase** — explicitly out of scope now (see Out of scope).
   - **Add-customer UX (decided):** a direct **"Add customer" action on the Home/dashboard** (office/admin creates the record), NOT buried under Admin → Client Portal. (Today `/admin/customers` exists with a CustomersManager add form; the construction "Client Portal & Messages" link on that page is irrelevant to ISP — hide it for orgs whose business type is ISP-only, or surface ISP-appropriate actions instead.)

3. **Per-user function restrictions (decided: defer).** The owner wants, eventually, to restrict which org functions individual users can access (a per-user permission matrix on top of roles). **Do not build this in this phase** — capture it as a future requirement. Scope it ISP-first later.

## Repo facts you must respect (verified live)
- Repo: `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app`. Branch to work on: `feat/isp-installs-module`. Supabase project `avmqteevisqxwmmxkrbg`. Verify DB state live via `information_schema`/`pg_policy`/`pg_proc` — never infer from `.sql` files. SQL migrations live at repo root, idempotent (`add column if not exists`), no DROP. New SQL must be run by the user in the Supabase SQL Editor.
- RLS helpers (SECURITY DEFINER, `multi_tenancy_a.sql`): `tier_office(org_id)`, `tier_office_or_pm(org_id)`, `tier_management(org_id)`, `same_org(uid, org_id)`. Office write policies: `for all ... using/with check (tier_office_or_pm(organization_id))`. Crew never get direct UPDATE on `installs` (their writes are SECURITY DEFINER RPCs). Superuser bypasses RLS.
- **Stripe pivot (DO NOT VIOLATE):** the platform never touches customer money. `src/lib/billing.ts`'s `getStripe()` uses `process.env.STRIPE_SECRET_KEY` = the **platform's** key, used ONLY to bill ORGS for their SaaS subscription (`organizations.stripe_customer_id`/`stripe_subscription_id`, `saas_billing.sql`; webhook `src/app/api/stripe/webhook/route.ts`). The old customer-pay/Connect path was deliberately removed (`drop_connect_columns.sql`, `STRIPE_BILLING_SETUP.md`, `payments.sql`/`pushInvoice.ts`/`provider.ts` headers, `InvoiceStatusBanner.tsx` no-Pay-button contract).
  - **This feature does NOT reverse the pivot.** Each org connects **their own** Stripe account; their ISP subscribers pay the org directly. The platform only stores the org's Stripe credentials (encrypted) and calls the Stripe API with the org's key. The platform's Stripe account is never used for customer charges. (Owner's words: "i dont want us to have anything to do with how the admins of other org deal with their money.")
- Reuse the encrypted-per-org-credential pattern that already powers accounting integrations: `src/lib/accounting/crypto.ts` (AES with `ACCOUNTING_TOKEN_ENCRYPTION_KEY`), `accounting_connections.sql` (`accounting_connections` table, one row per org×provider, `tier_office` RLS), `src/lib/accounting/connections.ts` (`getUsableTokens`/`getConnections`).
- Existing customer-billing plumbing to reuse (org-scoped, bills end-customers today via offline/invoice): `invoices` + `invoice_line_items` (`quotes_invoices.sql`, `invoices_standalone.sql`), `payments` (`payments.sql`, offline cash/check/other), `deliverInvoice` + share-token public view (`invoice_send.sql`, `src/lib/invoiceSend.ts`), `invoices.due_date`/`amount_paid`, `pushInvoiceToAllConnectedProviders` (auto-pushed on proposal e-sign — precedent for auto-syncing ISP invoices to QBO/Xero/FreshBooks).
- `install_types` is the pattern to mirror for a plan catalog: org-scoped, `name`/`position`/`active`, unique on `(organization_id, lower(name))`, `office_manage_install_types` RLS, org-wide read.
- `customers` is generic: `id, organization_id, name, contact_name, contact_email, phone, address, service_plan (free text), notes, sms_opt_in, email_opt_in, accounting_external_id`. **No ISP profile fields exist today.** `install_materials.serial_number` tracks per-install equipment (ONT/router) but there's no customer-level equipment record. Note: the `profiles.customer_id` bridge + "Customer see own record" RLS exist for the construction Client Portal — ISP customers have no `profiles` row, so those policies simply don't apply to them.
- `guard_job_create()` + `billing_past_due_gate.sql` is the existing dunning-gate pattern (block new jobs when org `plan_status='past_due'`) — adaptable to a customer-side service-suspension gate.
- Nav is variant-aware in `src/lib/navItems.ts` (+ `src/lib/useIspModule.ts` for the ISP module flag); the ISP "Installs" tab is inserted after Home. Business-type-driven nav will extend this.
- Standing rules: never commit/echo Stripe secrets; the module is UI-gated by `isp_module_enabled` (RLS is the real gate); this repo's Claude session may be `glm-5.2:cloud` with no vision — never Read image files (PNG/JPG/SVG); edit markup as text. Local Ollama can be delegated mechanical codegen (never for SQL/RLS/auth/security).

## Two design decisions to settle with the user (if not already)

1. **Org-Stripe connect model.** Recommended: **BYO Stripe keys** — org admin pastes their own `sk_live_…`/`sk_test_…` + webhook signing secret into a `/admin/isp/billing` settings page; stored encrypted via the `crypto.ts` pattern in a new `isp_stripe_connections` table (one row per org, `tier_office` RLS). The app constructs a per-org Stripe client from the stored key and creates Checkout Sessions / Subscriptions / Customer Portal sessions for that org's customers; money lands in the org's Stripe account, never the platform's. Alternative: Stripe Connect (Express/Standard) — heavier, requires Connect on the platform account, but avoids storing raw secret keys. Flag the security trade-off (stored live secret key) and let the user choose; recommend BYO keys unless they have compliance reasons.
2. **Plan catalog vs free-text.** `customers.service_plan` (free text) already exists. Recommended: add an `isp_plans` catalog (mirrors `install_types`) and an `isp_subscriptions` table; keep `customers.service_plan` as a free-text fallback for ad-hoc/non-catalog plans. A customer's active subscription → their plan.

## Feature 0 — Business type at signup
- New `organization_business_types` table (or `organizations.business_types text[]`). RLS: `tier_office` write, same-org read. Backfill existing orgs.
- Signup (`src/app/signup/page.tsx` + `/api/signup`) gains a multi-select "what kind of business are you?" step. For `isp`, auto-enable `isp_module_enabled` (or require explicit enable after signup).
- Nav (`src/lib/navItems.ts`) adapts to the declared business-type set, not just `app_variant` + `isp_module_enabled`. The construction "Client Portal & Messages" link on `/admin/customers` is hidden for orgs that are ISP (it's a construction-customer-portal concept, irrelevant to ISP subscribers).

## Feature 1 — ISP customer onboarding (office-managed, no login)
- "Add customer" action on the **Home/dashboard** (office/admin) that creates a `customers` row (contact, address, service_plan, etc.). Reuse/extend the `CustomersManager` add form, but surface it from Home for ISP orgs — NOT via Admin → Client Portal.
- Do NOT create an `auth.users` or `profiles` row for ISP customers. They are records only.
- The customer record is the anchor for their plan subscription (Feature 4), equipment profile (Feature 6), and emails.

## Feature 2 — Plan catalog (`isp_plans`)
New org-scoped table, mirror `install_types`:
- `id uuid PK`, `organization_id uuid → organizations cascade`, `name text`, `speed_mbps int` (nullable, display), `price_cents int not null check >= 0`, `billing_interval text check in ('month')` (start monthly-only), `setup_fee_cents int default 0`, `position int default 0`, `active bool default true`, `created_at`, unique `(organization_id, lower(name))`.
- RLS: `office_manage_isp_plans` (for all, `tier_office_or_pm`), `same_org_read_isp_plans` (SELECT).
- Office CRUD UI at `/admin/isp/plans` (reuse the `install_types` admin pattern if one exists, else CustomersManager-style list+add). Seeded for Terra Vista: e.g. "100M fiber", "1G fiber", "1G fiber / 12mo".

## Feature 3 — Per-org Stripe connection (`isp_stripe_connections`)
- New table: `id, organization_id (unique), stripe_secret_key_enc text, stripe_webhook_secret_enc text, mode text check in ('live','test')`, `charges_enabled bool`, `created_at/updated_at`. `tier_office` RLS. Encrypt with `src/lib/accounting/crypto.ts` (reuse, do not reinvent).
- Settings page `/admin/isp/billing`: admin pastes their Stripe secret key + webhook secret, chooses live/test, "Test connection" button (creates a throwaway Stripe client, retrieves balance, stores on success). Show connected status.
- **Per-org Stripe client helper** in a new `src/lib/ispBilling.ts` (do NOT touch `billing.ts`/`getStripe()`): `getOrgStripeClient(orgId)` → decrypt the org's key, `new Stripe(key, {apiVersion})`. All customer-charge code uses this. `billing.ts` remains platform-SaaS-only.
- Webhook: a **separate** webhook route (e.g. `/api/isp/stripe/webhook`) — the org's Stripe webhook points here with the org's webhook secret. Route must look up which org by the webhook secret (decrypt-match) to route events, then sync that org's subscription. Keep separate from the platform webhook `/api/stripe/webhook`.

## Feature 4 — Customer subscriptions (`isp_subscriptions`)
- New table: `id, organization_id, customer_id → customers cascade, plan_id → isp_plans restrict, stripe_subscription_id text (unique where not null), stripe_customer_id text, status text check in ('active','trialing','past_due','suspended','canceled','none')`, `current_period_end timestamptz`, `grace_until timestamptz` (the 2-week buffer), `started_at`, `canceled_at`, `created_at/updated_at`. RLS: office all (`tier_office_or_pm`). **No customer-side RLS** — ISP customers have no login, so there is no "customer see own" policy in this phase.
- Office enrolls a customer onto a plan from the customer detail page or a new `/admin/isp/subscriptions` surface: creates a Stripe Customer + Subscription (or a Checkout link the office sends to the subscriber to enter card) via the org's Stripe client; stores `stripe_customer_id`/`stripe_subscription_id`/`status`/`current_period_end`.
- **Payment management is Stripe-hosted (decided — no in-app customer portal now):** generate a **Stripe Customer Portal** session link (with the org's key) and surface it to the office / include it in emails to the subscriber. Stripe hosts plan/payment-method management. No in-app customer auth.

## Feature 5 — Dunning (missed payment → warning → grace → suspend)
- Org-configurable grace: store `dunning_grace_days int default 14` on `organizations` (additive column, office-admin settable on `/admin/isp/billing`) — or per-plan; recommend org-level default with per-plan override later.
- Flow: Stripe `invoice.payment_failed` (via the ISP webhook) → set subscription `status='past_due'`, `grace_until = now() + grace_days`, send a warning email (reuse `src/lib/email` / Resend; template the dunning email like `src/lib/emailLoaders.ts`).
- Daily cron (reuse the cron infra, e.g. the lawn nightly cron pattern): for subscriptions `past_due` and `grace_until < now()` → set `status='suspended'`, fire a "service suspended" email, and apply a service gate (e.g. block new installs / mark customer `service_suspended`; mirror `billing_past_due_gate.sql`'s trigger-gate pattern at the customer/install level).
- Recovery: on `invoice.paid` → `status='active'`, clear `grace_until`. On `subscription.deleted` → `status='canceled'`, `canceled_at=now()`.
- Idempotency: log events in a `isp_billing_events` table (mirror `billing_events`).

## Feature 6 — ISP customer-profile fields
Keep `customers` generic; add a side table `isp_customer_profiles` (one row per customer, `customer_id unique → customers cascade`, `organization_id`):
- `router_rented bool default false`, `router_model text`, `router_serial text`, `router_online bool` (office-toggled manual status to start; a real ping/health check is a later phase — note it), `static_ip text`, `installed_at date`, `contract_term_months int`, `notes text`, `created_at/updated_at`.
- RLS: office all (`tier_office_or_pm`). No customer-side policy (no login this phase).
- Surface on `src/components/CustomerDetail.tsx` as a new "ISP" tab (gate on `isp_module_enabled`), and pull existing `install_materials.serial_number` history for the router/ONT when present.
- Tie the profile to the active `isp_subscriptions.plan_id` so the customer file shows plan + equipment + online status together.

## Automation ("everything they do is automated")
- Monthly billing is Stripe's job (recurring Subscription) — the app does NOT generate invoices manually for plan renewals; Stripe charges the card and emits `invoice.paid`/`invoice.payment_failed`. On `invoice.paid`, optionally create a matching `invoices` row (reuse `invoices`/`invoice_line_items`) and push to the org's accounting via `pushInvoiceToAllConnectedProviders` (mirror the proposal-e-sign auto-push precedent) so the org's books stay in sync. Decide with user whether to auto-create internal `invoices` rows or rely on Stripe's invoice alone.
- Dunning emails + suspension are cron-driven (above).
- New install / customer onboarding can auto-create a subscription if the office selects a plan at install-create time (extend `src/components/NewInstallForm.tsx` with a plan `<select>` once `isp_plans` exists).

## Out of scope (note, don't build this phase)
- **Dedicated in-app ISP customer portal** (own login, plan/bills/equipment view) — later phase; for now subscribers use the Stripe-hosted Customer Portal link + emails.
- **Per-user function restrictions / permission matrix** — captured as a future requirement; scope ISP-first later.
- Real router health/online probing (start with manual `router_online` toggle; ping/SNMP/TR-069 health is a later phase).
- Platform-side fee taking on org customer payments (the platform takes nothing — BYO Stripe).
- Reversing the payments pivot or using the platform Stripe key for customer charges.
- Reusing the construction Client Portal / `auth.users role=customer` / `profiles.customer_id` / magic-link flow for ISP subscribers.

## Suggested build order
1. Feature 0 — business type at signup + nav adaptation + backfill.
2. Feature 1 — "Add customer" from Home (office-managed, no login).
3. Feature 2 — plan catalog (`isp_plans`) + admin UI (no Stripe yet).
4. Feature 3 — `isp_stripe_connections` + `src/lib/ispBilling.ts` per-org client + `/admin/isp/billing` connect page + test-connection.
5. Separate ISP webhook route + `isp_billing_events`.
6. Feature 4 — `isp_subscriptions` + enroll flow + Stripe Customer Portal link (Stripe-hosted).
7. Feature 5 — dunning (org grace config + warning email + cron + suspend gate).
8. Feature 6 — `isp_customer_profiles` + CustomerDetail ISP tab.
9. Auto-create internal `invoices` on `invoice.paid` + accounting push (optional, user decides).

## Verify
- Run each migration in SQL Editor; live-verify columns/RLS via `information_schema`/`pg_policy`.
- `npm run build` exit 0; new `/admin/isp/*` + signup routes compile.
- End-to-end with Stripe **test mode** keys: signup a new org picking ISP business type, connect a test Stripe account, define a plan, add a customer from Home, enroll them, trigger a failed payment (Stripe test card `4000 0000 0000 0341`), confirm past_due → warning → grace → suspend, then a paid invoice → re-activate.
- Confirm the platform Stripe key (`STRIPE_SECRET_KEY`) and platform webhook (`/api/stripe/webhook`) are untouched and still only handle SaaS org billing.
- Confirm no `auth.users`/`profiles` rows are created for ISP subscribers (records-only).