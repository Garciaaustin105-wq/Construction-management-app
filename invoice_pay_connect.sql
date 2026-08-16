-- invoice_pay_connect.sql — online invoice payments via Stripe Connect.
-- Each tenant org connects their OWN Stripe account (Express) and receives
-- customer invoice payments directly (destination charges created on the
-- platform account with transfer_data.destination = the org's connected
-- account). Idempotent + additive. Run in Supabase SQL Editor (Notepad paste).

-- ---------------------------------------------------------------------------
-- 1. organizations: Connect linkage (receiving customer payments)
--    stripe_connect_account_id is the org's CONNECTED Stripe account, distinct
--    from stripe_customer_id which is the org as a SaaS subscriber paying the
--    platform. connect_charges_enabled + connect_details_submitted are a
--    cached snapshot of the connected account's status (refreshed on onboarding
--    return + on billing-page view) so the public invoice view can show/hide
--    the Pay button without a Stripe API call on every load.
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists stripe_connect_account_id text;

alter table public.organizations
  add column if not exists connect_charges_enabled boolean not null default false;

alter table public.organizations
  add column if not exists connect_details_submitted boolean not null default false;

create unique index if not exists organizations_stripe_connect_account_id_key
  on public.organizations (stripe_connect_account_id)
  where stripe_connect_account_id is not null;

-- ---------------------------------------------------------------------------
-- 2. invoices: audit / dedup on paid invoices
--    Event-level idempotency is already handled by billing_events.stripe_event_id
--    (the webhook records every event id). These invoice-level columns let the
--    webhook stamp the Stripe payment intent + checkout session so a re-delivery
--    can't double-apply or clobber paid_at, and so an admin can trace a payment.
--    No RLS change: the webhook writes via the service role (bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists stripe_payment_intent_id text;

alter table public.invoices
  add column if not exists stripe_checkout_session_id text;