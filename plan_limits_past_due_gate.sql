-- ============================================================================
-- plan_limits_past_due_gate.sql  (idempotent / additive — safe to re-run)
-- ----------------------------------------------------------------------------
-- Two small fixes to the three BEFORE-INSERT create-guards in plan_limits_v2.sql:
--
-- 1. PAST-DUE GATE (the real fix). A Stripe payment that's retrying sets
--    organizations.plan_status = 'past_due'. The variant-aware guard_job_create
--    that won the plan_limits_v2.sql vs billing_past_due_gate.sql drift does NOT
--    check plan_status, so a past-due org could keep creating jobs (and customers
--    and crew members — neither of those guards ever had the check). This restores
--    the block on ALL THREE creates, matching src/lib/billing.ts createGate's
--    past_due branch. Reads stay allowed when past_due — only CREATES are blocked.
--
--    Why a trigger: /lawn/new and /admin/projects/new are client components that
--    insert directly via the RLS user client (no server route). The app-side
--    createGate only gates /api/users (seat creation). A BEFORE-INSERT trigger
--    is the only reliable gate for client-direct inserts — it runs for every
--    insert regardless of caller (client or service role).
--
-- 2. RAISE-MESSAGE PLACEHOLDER FIX (cosmetic). The cap-reached messages used
--    '%s' but plpgsql's RAISE placeholder is '%' (no 's'), so they rendered as
--    e.g. "Job limit reached (150s) on the pros plan". Fixed to '%'.
--
-- CAP NUMBERS + COUNT LOGIC ARE UNCHANGED. The count(*) is still unfiltered
-- (no status predicate) — the "count only active jobs" improvement is DEFERRED
-- (churn on lawn lives in recurring_schedules.active, not jobs.status; a
-- status <> 'completed' filter is a no-op on lawn today; no org is near the cap
-- — max 6 of 150). Design that against a real churned row later, not as a guess.
--
-- Run in the Supabase SQL Editor (single-quoted literals; paste from a text
-- editor, not the web editor). Re-running is safe. Run AFTER plan_limits_v2.sql
-- if you ever re-run that file, so this version is the live one.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. jobs — variant-aware cap + past-due gate + message fix
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_job_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan     text;
  v_status   text;
  v_trial    timestamptz;
  v_variant  text;
  v_eff      text;
  v_count    bigint;
  v_max      int;
begin
  select plan, plan_status, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_status, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  -- Effective plan (lazy trial expiry, same as billing.ts effectiveStatus).
  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow new jobs. Subscribe to continue.';
  end if;

  -- Past-due subscription: a Stripe payment is retrying. Block new jobs until
  -- billing info is updated (matches src/lib/billing.ts createGate past_due).
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume creating jobs.';
  end if;

  -- Max jobs per tier per variant (mirror src/lib/plans.ts maxJobs).
  v_max := case
    when v_eff = 'trial'     then null
    when v_eff = 'free'      then 25
    when v_eff = 'enterprise' then (case when v_variant = 'lawn' then 500 else null end)
    when v_eff = 'pro'        then (case when v_variant = 'lawn' then 150 else 50 end)
    when v_eff = 'starter'    then (case when v_variant = 'lawn' then 25 else 10 end)
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.jobs
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Job limit reached (%) on the % plan. Upgrade to add more jobs.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_job_create on public.jobs;
create trigger trg_guard_job_create
  before insert on public.jobs
  for each row execute function public.guard_job_create();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. crew_members — variant-aware cap + past-due gate + message fix
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_crew_member_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    text;
  v_status  text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_count   bigint;
  v_max     int;
begin
  select plan, plan_status, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_status, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow adding crew members. Subscribe to continue.';
  end if;

  -- Past-due subscription: block new crew members until billing is updated.
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume adding crew members.';
  end if;

  -- Max crew_members per tier per variant (mirror src/lib/plans.ts maxCrewMembers).
  v_max := case
    when v_eff = 'trial'     then null
    when v_eff = 'free'      then 3
    when v_eff = 'enterprise' then null
    when v_eff = 'pro'        then (case when v_variant = 'lawn' then 150 else 100 end)
    when v_eff = 'starter'    then (case when v_variant = 'lawn' then 25 else 15 end)
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.crew_members
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Crew member limit reached (%) on the % plan. Upgrade to add more crew.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_crew_member_create on public.crew_members;
create trigger trg_guard_crew_member_create
  before insert on public.crew_members
  for each row execute function public.guard_crew_member_create();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. customers — variant-aware cap + past-due gate + message fix
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_customer_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    text;
  v_status  text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_count   bigint;
  v_max     int;
begin
  select plan, plan_status, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_status, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow adding customers. Subscribe to continue.';
  end if;

  -- Past-due subscription: block new customers until billing is updated.
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume adding customers.';
  end if;

  -- Max customers per tier per variant (mirror src/lib/plans.ts maxCustomers).
  v_max := case
    when v_eff = 'trial'      then null
    when v_eff = 'free'       then 25
    when v_eff = 'enterprise' then null
    when v_eff = 'pro'        then (case when v_variant = 'lawn' then 1000 else 500 end)
    when v_eff = 'starter'    then (case when v_variant = 'lawn' then 100 else 50 end)
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.customers
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Customer limit reached (%) on the % plan. Upgrade to add more customers.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_customer_create on public.customers;
create trigger trg_guard_customer_create
  before insert on public.customers
  for each row execute function public.guard_customer_create();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Defense-in-depth: revoke direct RPC execute (trigger-only fns).
--    create or replace preserves grants, so re-revoke to be explicit.
-- ────────────────────────────────────────────────────────────────────────────
revoke execute on function public.guard_job_create()           from public, anon, authenticated;
revoke execute on function public.guard_crew_member_create()   from public, anon, authenticated;
revoke execute on function public.guard_customer_create()      from public, anon, authenticated;