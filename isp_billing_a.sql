-- isp_billing_a.sql
-- ----------------------------------------------------------------------------
-- ISP / fiber module — billing phase A: the plan catalog, the org's Stripe
-- Connect link, the webhook event log, and the dunning grace knob.
--
-- CONTEXT — read this before touching anything Stripe-shaped in this repo.
-- There are now THREE distinct Stripe surfaces, and conflating them is the one
-- mistake that undoes the 2026-08-17 payments pivot:
--
--   1. PLATFORM SaaS billing  — STRIPE_SECRET_KEY, organizations.stripe_*,
--      /api/stripe/webhook, src/lib/billing.ts::getStripe().
--      Bills ORGS for their subscription to this app. UNTOUCHED by this file.
--   2. Accounting sync        — accounting_connections, one-way push of
--      receivables to the org's own QBO/Xero/FreshBooks. UNTOUCHED.
--   3. ISP subscriber billing — THIS FILE. Each org connects their own Stripe
--      CONNECTED ACCOUNT; their fiber subscribers pay THEM directly.
--
-- WHY CONNECT AND NOT "PASTE YOUR SECRET KEY" (the rejected alternative):
-- storing an org's live sk_live_... would make this database the custodian of
-- full API access to every org's Stripe account — one breach, total compromise,
-- permanently. Connect stores only an `acct_...` identifier, which is useless on
-- its own, and the org can revoke the platform from their own dashboard. That
-- is why there is NO ciphertext column anywhere in this file and why
-- src/lib/accounting/crypto.ts is deliberately NOT imported by the ISP billing
-- code. If you ever find yourself adding a `*_key_enc` column here, stop.
--
-- WHY DIRECT CHARGES (this is the liability-critical decision):
-- Stripe assigns dispute/refund/negative-balance liability by WHERE THE CHARGE
-- LIVES, not by account type. The app's FIRST Connect attempt (commit e2cf93c,
-- since removed) used Express accounts + DESTINATION charges, which put every
-- subscriber chargeback on the PLATFORM's balance and made Stripe hold a
-- reserve against it. This module does the opposite: charges are created ON the
-- connected account (Stripe-Account header), so the ORG is merchant of record,
-- disputes and refunds debit THEIR balance, and negative-balance liability is
-- assigned to Stripe via controller.losses.payments = stripe. See
-- src/lib/ispBilling.ts for the account-creation call that encodes this. Do not
-- switch these to destination charges — it silently re-assigns liability to us.
--
-- Idempotent + additive: `if not exists` / `drop policy if exists`. No DROP
-- TABLE, no destructive column change. Safe to re-run.
--
-- Run in the Supabase SQL editor — paste from a text editor (Notepad), NOT the
-- web editor (it mangles single quotes).
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 0. customers.service_plan — the free-text fallback.
-- ============================================================================
-- This column was written in customers_service_plan.sql but that file was never
-- run (verified live 2026-08-22: information_schema had no such column), so it
-- is folded in here rather than left as a second file to forget. It stays even
-- though isp_plans now exists: the catalog drives BILLING, this stays for
-- ad-hoc / grandfathered / non-catalog arrangements the office types by hand.
-- A customer's real plan is their active isp_subscriptions row when one exists.

alter table public.customers add column if not exists service_plan text;


-- ============================================================================
-- 1. isp_plans — the org-defined plan catalog.
-- ============================================================================
-- Mirrors install_types exactly (org-scoped, name/position/active, unique on
-- lower(name), office-manage + org-wide-read RLS) because the office already
-- knows how that surface behaves.
--
-- -- The two stripe_* columns need explanation --
-- A Stripe Price lives on ONE account. Because we use direct charges, the
-- Product/Price backing a plan is created on the ORG's connected account, not
-- the platform's — so these ids are meaningless outside the context of
-- isp_connect_accounts.stripe_account_id for the same org. They are populated
-- LAZILY (first time the plan is used to enroll someone), never at insert, so
-- an org can build their catalog before they finish Stripe onboarding.
--
-- Stripe Prices are IMMUTABLE. Editing price_cents therefore cannot update the
-- Price in place: the app creates a NEW Price on the org's account and
-- overwrites stripe_price_id. Subscribers already enrolled stay on the OLD
-- price until someone explicitly migrates them — which is the correct default
-- (silently repricing existing customers is how you get chargebacks), but it
-- does mean price_cents here is "the price NEW subscribers get", not
-- "what everyone pays". The admin UI says so out loud.

create table if not exists public.isp_plans (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  speed_mbps        integer,                 -- display only; null for non-speed plans
  price_cents       integer not null default 0 check (price_cents >= 0),
  billing_interval  text not null default 'month' check (billing_interval in ('month')),
  setup_fee_cents   integer not null default 0 check (setup_fee_cents >= 0),
  position          integer not null default 0,
  active            boolean not null default true,
  stripe_product_id text,                    -- on the ORG's connected account
  stripe_price_id   text,                    -- on the ORG's connected account
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Case-insensitive uniqueness per org, same as install_types. Expression index
-- rather than a table constraint because lower() is not allowed in `unique (...)`.
create unique index if not exists idx_isp_plans_org_name
  on public.isp_plans (organization_id, lower(name));

create index if not exists idx_isp_plans_org
  on public.isp_plans (organization_id);

alter table public.isp_plans enable row level security;

drop policy if exists office_manage_isp_plans on public.isp_plans;
create policy office_manage_isp_plans on public.isp_plans
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- Org-wide read: crew scheduling an install and the customer portal both need
-- to resolve a plan name/price without office rights.
drop policy if exists same_org_read_isp_plans on public.isp_plans;
create policy same_org_read_isp_plans on public.isp_plans
  for select to authenticated
  using (public.same_org(auth.uid(), organization_id));


-- ============================================================================
-- 2. isp_connect_accounts — the org's Stripe Connect link.
-- ============================================================================
-- ONE row per org. Holds NO credentials — only the connected account id and the
-- onboarding/capability flags Stripe reports back, which are cached here so the
-- admin UI can render "connected / needs attention" without an API round trip
-- on every page load. The flags are refreshed from `account.updated` webhooks
-- and by the explicit refresh button; treat them as a cache, not as truth.
--
-- charges_enabled is the gate that matters: an account mid-onboarding can exist
-- with details_submitted = true and still not be able to accept charges. The
-- enroll flow must refuse to create subscriptions unless charges_enabled.
--
-- INSERTS come from the service role (the connect route), matching the
-- accounting_connections model — there is deliberately no INSERT policy for
-- authenticated roles, so a client can never fabricate a connection row
-- pointing at someone else's acct_ id.

create table if not exists public.isp_connect_accounts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null unique references public.organizations(id) on delete cascade,
  stripe_account_id  text not null unique,   -- acct_... ; not a secret, but still org-scoped
  status             text not null default 'pending'
                       check (status in ('pending','active','restricted','disconnected')),
  charges_enabled    boolean not null default false,
  payouts_enabled    boolean not null default false,
  details_submitted  boolean not null default false,
  livemode           boolean not null default false,
  -- Stripe's requirements hash, verbatim, for rendering "what is still needed".
  requirements       jsonb,
  connected_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_isp_connect_accounts_acct
  on public.isp_connect_accounts (stripe_account_id);

alter table public.isp_connect_accounts enable row level security;

-- tier_office (NOT tier_office_or_pm): connecting/disconnecting the org's
-- payment processor is an owner-level financial action, the same call
-- accounting_connections makes for the same reason.
drop policy if exists office_read_isp_connect on public.isp_connect_accounts;
create policy office_read_isp_connect on public.isp_connect_accounts
  for select to authenticated
  using (public.tier_office(organization_id));

drop policy if exists office_update_isp_connect on public.isp_connect_accounts;
create policy office_update_isp_connect on public.isp_connect_accounts
  for update to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

drop policy if exists office_delete_isp_connect on public.isp_connect_accounts;
create policy office_delete_isp_connect on public.isp_connect_accounts
  for delete to authenticated
  using (public.tier_office(organization_id));


-- ============================================================================
-- 3. isp_billing_events — webhook idempotency log.
-- ============================================================================
-- Mirrors billing_events (the platform SaaS log) but is a SEPARATE table on
-- purpose: these events arrive from CONNECTED accounts on a different endpoint
-- with a different signing secret, and mixing them would make the super-admin
-- platform log unreadable and the org-scoped read policy below impossible.
--
-- stripe_event_id is unique — that uniqueness IS the idempotency mechanism. The
-- handler inserts FIRST and treats a 23505 unique violation as "already
-- processed, ack and return 200", which is what stops Stripe's retries from
-- double-applying a suspension or double-creating an invoice.
--
-- organization_id is nullable: an event can arrive for a connected account we
-- cannot resolve to an org (e.g. after a disconnect), and we still want the row
-- logged rather than the insert failing.

create table if not exists public.isp_billing_events (
  id                bigint generated always as identity primary key,
  organization_id   uuid references public.organizations(id) on delete cascade,
  stripe_account_id text,                    -- the connected account it came from
  stripe_event_id   text unique not null,
  event_type        text not null,
  handled           boolean not null default false,
  error             text,                    -- set when the handler threw; for replay
  created_at        timestamptz not null default now(),
  payload           jsonb
);

create index if not exists idx_isp_billing_events_org
  on public.isp_billing_events (organization_id, created_at desc);

alter table public.isp_billing_events enable row level security;

-- The org's office can read THEIR OWN billing events — unlike billing_events,
-- which is super-admin-only. Justification: this is the org's own subscriber
-- billing history (why did this customer get suspended?), not platform data.
drop policy if exists office_read_isp_billing_events on public.isp_billing_events;
create policy office_read_isp_billing_events on public.isp_billing_events
  for select to authenticated
  using (organization_id is not null and public.tier_office(organization_id));

drop policy if exists super_admin_read_isp_billing_events on public.isp_billing_events;
create policy super_admin_read_isp_billing_events on public.isp_billing_events
  for select to authenticated
  using (public.is_super_admin(auth.uid()));

-- No insert/update/delete policies: only the service role (webhook) writes.


-- ============================================================================
-- 4. organizations.dunning_grace_days — the missed-payment buffer.
-- ============================================================================
-- Org-level default (14 days per the ISP's stated policy). A per-plan override
-- is deliberately NOT modelled yet — add isp_plans.dunning_grace_days and
-- coalesce if it is ever actually needed, rather than carrying an unused
-- column now.
--
-- Bounded 0..90 so a typo cannot create a subscriber who is never suspended.

alter table public.organizations
  add column if not exists dunning_grace_days integer not null default 14;

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_dunning_grace_days_ck'
  ) then
    alter table public.organizations
      add constraint organizations_dunning_grace_days_ck
      check (dunning_grace_days >= 0 and dunning_grace_days <= 90);
  end if;
end
$do$;


-- ============================================================================
-- 5. updated_at triggers
-- ============================================================================
-- public.touch_updated_at() already exists (accounting_connections.sql created
-- it, hardened in harden_function_execute*.sql). Reused, not redefined.

drop trigger if exists trg_isp_plans_touch on public.isp_plans;
create trigger trg_isp_plans_touch
  before update on public.isp_plans
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_isp_connect_accounts_touch on public.isp_connect_accounts;
create trigger trg_isp_connect_accounts_touch
  before update on public.isp_connect_accounts
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- VERIFY (run after, expect the noted row counts)
-- ============================================================================
-- select table_name from information_schema.tables where table_schema='public'
--   and table_name in ('isp_plans','isp_connect_accounts','isp_billing_events');
--   -- expect 3
-- select column_name from information_schema.columns
--   where table_name='customers' and column_name='service_plan';           -- expect 1
-- select column_name from information_schema.columns
--   where table_name='organizations' and column_name='dunning_grace_days'; -- expect 1
-- select c.relname, p.polname from pg_policy p join pg_class c on c.oid=p.polrelid
--   where c.relname like 'isp_%' order by 1,2;                             -- expect 7
