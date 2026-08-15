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
  check (plan in ('trial','starter','pro','enterprise','expired','canceled'));

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
-- 3b. Job-create guard: block new jobs when the org's plan is expired/canceled
--     or when it has reached its job cap. Fires on every jobs INSERT (client
--     inserts included — triggers run even for service-role writes). The caps
--     mirror src/lib/plans.ts (keep them in sync if you change a tier's limit).
-- ---------------------------------------------------------------------------
create or replace function public.guard_job_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan        text;
  v_status      text;
  v_trial_ends  timestamptz;
  v_eff         text;
  v_count       bigint;
  v_max         int;
begin
  select plan, plan_status, trial_ends_at
    into v_plan, v_status, v_trial_ends
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  -- Effective plan (lazy trial expiry, same as src/lib/billing.ts effectiveStatus).
  v_eff := v_plan;
  if v_plan = 'trial' and v_trial_ends is not null and now() > v_trial_ends then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow new jobs. Subscribe to continue using Terra Vista.';
  end if;

  -- Max jobs per tier (mirror src/lib/plans.ts).
  v_max := case v_eff
    when 'starter'    then 10
    when 'pro'        then 100
    when 'enterprise' then null
    when 'trial'      then null
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.jobs
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Job limit reached (%s) on the %s plan. Upgrade to add more jobs.', v_max, v_eff;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_job_create on public.jobs;
create trigger trg_guard_job_create
  before insert on public.jobs
  for each row execute function public.guard_job_create();

-- ---------------------------------------------------------------------------
-- 4. Grandfather every existing org to Pro/active so nothing breaks on deploy.
--    Super_admin can change any org's tier afterward from the platform view.
-- ---------------------------------------------------------------------------
update public.organizations
  set plan = 'pro',
      plan_status = 'active',
      trial_ends_at = null
  where plan = 'trial' and trial_ends_at is null;