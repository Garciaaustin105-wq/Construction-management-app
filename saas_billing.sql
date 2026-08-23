-- saas_billing.sql — SaaS subscription billing schema (Stripe, flat per-org monthly).
-- Idempotent + additive. Run in Supabase SQL Editor (Notepad paste) BEFORE/AT deploy.
-- Adds Stripe linkage + trial + plan lifecycle columns to organizations, a CHECK
-- on the existing plan column, a billing_events audit/idempotency table, and
-- grandfathers every existing org to Pro/active so no app breaks on deploy.

-- ---------------------------------------------------------------------------
-- 1. organizations: billing columns
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists stripe_customer_id text;

alter table public.organizations
  add column if not exists stripe_subscription_id text;

alter table public.organizations
  add column if not exists trial_ends_at timestamptz;

-- Lifecycle of the subscription: trial | active | past_due | canceled | expired.
alter table public.organizations
  add column if not exists plan_status text not null default 'trial';

-- Monthly subscription amount in cents, synced from Stripe webhook. Used for the
-- super_admin platform MRR rollup without calling the Stripe API.
alter table public.organizations
  add column if not exists subscription_amount_cents integer not null default 0;

-- Unique index so we can look up an org from a Stripe customer id safely.
create unique index if not exists organizations_stripe_customer_id_key
  on public.organizations (stripe_customer_id) where stripe_customer_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Constrain organizations.plan to known tiers
-- ---------------------------------------------------------------------------
alter table public.organizations
  drop constraint if exists organizations_plan_check;

alter table public.organizations
  add constraint organizations_plan_check
  check (plan in ('trial','starter','pro','enterprise','expired','canceled','free'));

-- ---------------------------------------------------------------------------
-- 3. billing_events: webhook idempotency + audit log
--    Service-role-written only (webhook). Clients can't insert/update/delete.
--    Only super_admin may read (platform audit).
-- ---------------------------------------------------------------------------
create table if not exists public.billing_events (
  id              bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  stripe_event_id text unique not null,
  event_type      text not null,
  created_at      timestamptz not null default now(),
  payload         jsonb
);

alter table public.billing_events enable row level security;

drop policy if exists "Super admin read billing events" on public.billing_events;
create policy "Super admin read billing events" on public.billing_events
  for select to authenticated
  using (public.is_super_admin(auth.uid()));

-- No insert/update/delete policies: only the service role (webhook) writes, and
-- the service role bypasses RLS. No client ever mutates this table.

-- ---------------------------------------------------------------------------
-- 3b. REMOVED — the variant-aware guard_job_create in plan_limits_v2.sql is the
--     source of truth. This older non-variant copy was a "last-applied-wins"
--     drift hazard: re-running saas_billing.sql after plan_limits_v2.sql would
--     silently regress the trigger (drop+create here overwrites the newer one).
--     Do NOT re-add a guard_job_create here — edit plan_limits_v2.sql instead.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Grandfather every existing org to Pro/active so nothing breaks on deploy.
--    Super_admin can change any org's tier afterward from the platform view.
-- ---------------------------------------------------------------------------
update public.organizations
  set plan = 'pro',
      plan_status = 'active',
      trial_ends_at = null
  where plan = 'trial' and trial_ends_at is null;