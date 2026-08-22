-- isp_billing_b.sql
-- ----------------------------------------------------------------------------
-- ISP / fiber module — billing phase B: subscriber enrollment and the ISP
-- customer profile (equipment / router / service state).
--
-- REQUIRES isp_billing_a.sql to have been run first (isp_plans is referenced by
-- FK, organizations.dunning_grace_days is read by the dunning cron).
--
-- Idempotent + additive. Safe to re-run. Run in the Supabase SQL editor —
-- paste from a text editor (Notepad), NOT the web editor.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. isp_subscriptions — one subscriber's enrollment on one plan.
-- ============================================================================
-- The bridge between a `customers` row and a Stripe Subscription living on the
-- ORG's connected account.
--
-- -- Why BOTH stripe_customer_id and stripe_subscription_id --
-- Under direct charges every Stripe object is created on the connected account,
-- including the Customer. The platform's own Stripe Customer namespace is
-- unrelated and must never be used here. Storing the connected-account Customer
-- id is what lets us open a Billing Portal session for the subscriber later
-- without re-creating them (and thereby orphaning their saved card).
--
-- -- status is OURS, not Stripe's --
-- Stripe subscription statuses are (incomplete, incomplete_expired, trialing,
-- active, past_due, canceled, unpaid, paused). We deliberately keep a SEPARATE
-- vocabulary because 'suspended' has no Stripe equivalent — it is this app's
-- post-grace service cutoff, applied by the dunning cron, and Stripe knows
-- nothing about it. Mapping happens in src/lib/ispBilling.ts. Never blind-copy
-- Stripe's status string into this column.
--
-- -- grace_until --
-- Set to now() + organizations.dunning_grace_days when a payment first fails.
-- The cron suspends past_due rows whose grace_until has passed. Cleared on
-- recovery. Null while healthy.

create table if not exists public.isp_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  customer_id            uuid not null references public.customers(id) on delete cascade,
  plan_id                uuid not null references public.isp_plans(id) on delete restrict,
  -- Both ids live on the ORG's connected account, not the platform account.
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text not null default 'none'
                           check (status in ('none','trialing','active','past_due','suspended','canceled')),
  current_period_end     timestamptz,
  grace_until            timestamptz,
  started_at             timestamptz,
  suspended_at           timestamptz,
  canceled_at            timestamptz,
  -- Set when the dunning warning email went out, so the cron never sends twice
  -- for the same past_due episode. Cleared on recovery alongside grace_until.
  warned_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- A subscription id is globally unique when present. Partial (not a plain
-- unique constraint) because rows legitimately exist with a null id: an offline
-- / manually-tracked enrollment before Stripe onboarding finishes.
create unique index if not exists idx_isp_subscriptions_stripe_sub
  on public.isp_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- At most ONE live subscription per customer. Canceled rows are kept for
-- history, so the constraint is partial over the live statuses only. This is
-- what stops a double-enroll from silently billing someone twice.
create unique index if not exists idx_isp_subscriptions_one_live
  on public.isp_subscriptions (customer_id)
  where status in ('none','trialing','active','past_due','suspended');

create index if not exists idx_isp_subscriptions_org
  on public.isp_subscriptions (organization_id);

-- The cron's working set: past_due rows whose grace window has expired.
create index if not exists idx_isp_subscriptions_dunning
  on public.isp_subscriptions (status, grace_until)
  where status = 'past_due';

alter table public.isp_subscriptions enable row level security;

drop policy if exists office_manage_isp_subscriptions on public.isp_subscriptions;
create policy office_manage_isp_subscriptions on public.isp_subscriptions
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists management_read_isp_subscriptions on public.isp_subscriptions;
create policy management_read_isp_subscriptions on public.isp_subscriptions
  for select to authenticated
  using (public.tier_management(organization_id));

-- The subscriber sees their own enrollment, via the same profiles.customer_id
-- bridge customer_rls.sql established. SELECT only — a customer changing their
-- own subscription status is exactly the hole this must not have.
drop policy if exists customer_read_own_isp_subscription on public.isp_subscriptions;
create policy customer_read_own_isp_subscription on public.isp_subscriptions
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (
      select profiles.customer_id from public.profiles where profiles.id = auth.uid()
    )
  );


-- ============================================================================
-- 2. isp_customer_profiles — ISP-specific fields for a customer.
-- ============================================================================
-- A SIDE table, not columns on `customers`, because `customers` is shared by
-- every tenant and variant (construction + lawn). Adding router_serial to the
-- table a landscaping company uses would be schema pollution for 100% of orgs
-- to serve one. One row per customer, created lazily the first time the office
-- fills in the ISP tab.
--
-- router_online is a MANUAL office toggle for now. Real reachability
-- (ping / SNMP / TR-069 polling) is explicitly a later phase — router_status_at
-- exists so the UI can say "as of <when>" and not imply live truth it does not
-- have. Do not wire this to anything that claims real-time status until an
-- actual probe exists behind it.
--
-- service_suspended is DENORMALIZED from isp_subscriptions.status='suspended'.
-- It is maintained by the trigger below rather than by application code so it
-- cannot drift, and it exists so the install-create gate and the customer list
-- can filter without joining through subscriptions on every read.

create table if not exists public.isp_customer_profiles (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  customer_id          uuid not null unique references public.customers(id) on delete cascade,
  router_rented        boolean not null default false,
  router_model         text,
  router_serial        text,
  router_online        boolean,               -- null = never reported
  router_status_at     timestamptz,           -- when router_online was last set
  static_ip            text,
  installed_at         date,
  contract_term_months integer check (contract_term_months is null or contract_term_months >= 0),
  service_suspended    boolean not null default false,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_isp_customer_profiles_org
  on public.isp_customer_profiles (organization_id);

alter table public.isp_customer_profiles enable row level security;

drop policy if exists office_manage_isp_customer_profiles on public.isp_customer_profiles;
create policy office_manage_isp_customer_profiles on public.isp_customer_profiles
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists management_read_isp_customer_profiles on public.isp_customer_profiles;
create policy management_read_isp_customer_profiles on public.isp_customer_profiles
  for select to authenticated
  using (public.tier_management(organization_id));

-- Crew on site need the equipment details (router model/serial, static IP) to
-- do the install; they are already trusted with install_materials serials.
drop policy if exists same_org_read_isp_customer_profiles on public.isp_customer_profiles;
create policy same_org_read_isp_customer_profiles on public.isp_customer_profiles
  for select to authenticated
  using (public.same_org(auth.uid(), organization_id));


-- ============================================================================
-- 3. Keep service_suspended in sync with subscription status.
-- ============================================================================
-- Fires on the subscription, writes the customer profile. SECURITY DEFINER so
-- the cron (service role) and the office client both hit the same path.
--
-- Deliberately UPSERTs: a customer can be suspended before anyone has opened
-- the ISP tab, so the profile row may not exist yet.

create or replace function public.sync_isp_service_suspended()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_suspended boolean;
begin
  v_suspended := (new.status = 'suspended');

  insert into public.isp_customer_profiles (organization_id, customer_id, service_suspended)
  values (new.organization_id, new.customer_id, v_suspended)
  on conflict (customer_id)
  do update set service_suspended = excluded.service_suspended;

  return new;
end;
$fn$;

drop trigger if exists trg_isp_sub_sync_suspended on public.isp_subscriptions;
create trigger trg_isp_sub_sync_suspended
  after insert or update of status on public.isp_subscriptions
  for each row execute function public.sync_isp_service_suspended();


-- ============================================================================
-- 4. Install-create gate: no new installs for a suspended subscriber.
-- ============================================================================
-- The service-cutoff enforcement point, mirroring guard_job_create()'s
-- BEFORE-INSERT shape (see billing_past_due_gate.sql) for the same reason: the
-- install create form inserts client-direct via the RLS user client, so a
-- trigger is the only gate that cannot be bypassed by calling a different
-- surface.
--
-- NARROW BY DESIGN: it fires only when the customer actually has a suspended
-- subscription row. Customers with no ISP subscription (every other org, and
-- ISP customers on manual billing) are completely unaffected — the lookup
-- misses and the insert proceeds. This is why there is no isp_module_enabled
-- check here: absence of a suspended row is already the correct no-op.

create or replace function public.guard_install_create_suspended()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_suspended boolean;
begin
  if new.customer_id is null then
    return new;
  end if;

  select true into v_suspended
    from public.isp_subscriptions
    where customer_id = new.customer_id
      and status = 'suspended'
    limit 1;

  if v_suspended then
    raise exception 'This customer''s service is suspended for non-payment. Restore their subscription before scheduling a new install.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_guard_install_create_suspended on public.installs;
create trigger trg_guard_install_create_suspended
  before insert on public.installs
  for each row execute function public.guard_install_create_suspended();


-- ============================================================================
-- 5. updated_at triggers
-- ============================================================================

drop trigger if exists trg_isp_subscriptions_touch on public.isp_subscriptions;
create trigger trg_isp_subscriptions_touch
  before update on public.isp_subscriptions
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_isp_customer_profiles_touch on public.isp_customer_profiles;
create trigger trg_isp_customer_profiles_touch
  before update on public.isp_customer_profiles
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 6. Lock down the new SECURITY DEFINER functions
-- ============================================================================
-- Matches harden_function_execute.sql: trigger functions are invoked by the
-- trigger, never called directly, so no role needs EXECUTE. Revoking closes the
-- "call the definer function directly with crafted args" surface.

revoke all on function public.sync_isp_service_suspended() from public, anon, authenticated;
revoke all on function public.guard_install_create_suspended() from public, anon, authenticated;


-- ============================================================================
-- VERIFY (run after)
-- ============================================================================
-- select table_name from information_schema.tables where table_schema='public'
--   and table_name in ('isp_subscriptions','isp_customer_profiles');   -- expect 2
-- select c.relname, p.polname, p.polcmd from pg_policy p
--   join pg_class c on c.oid=p.polrelid
--   where c.relname in ('isp_subscriptions','isp_customer_profiles') order by 1,2;
--   -- expect 4 + 3
-- select tgname from pg_trigger where tgname like 'trg_isp%'
--   or tgname = 'trg_guard_install_create_suspended' order by 1;        -- expect 5
