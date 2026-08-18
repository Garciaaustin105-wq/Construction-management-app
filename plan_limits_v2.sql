-- Terra Vista / Terra Verde — multi-dimensional, variant-aware plan limits.
-- ============================================================================
-- Mirrors src/lib/plans.ts (variant-aware via organizations.app_variant). Two
-- BEFORE-INSERT guards that raise when an org has hit its tier cap, so the caps
-- are enforced at the DB (not just app-side — a savvy user with the anon key
-- can't bypass a trigger). Reads the org's plan + app_variant + trial expiry.
--
-- Caps (must match src/lib/plans.ts PLAN_TIERS):
--   construction: starter jobs=10, pro jobs=50, enterprise(null)
--                  starter crew=15, pro crew=100, enterprise(null)
--   lawn:          starter jobs=25, pro jobs=150, enterprise jobs=500
--                  starter crew=25, pro crew=150, enterprise(null)
--   trial:         unlimited.  expired/canceled: 0 (block all creates).
--
-- ⚠️ BEHAVIOR CHANGE for existing orgs: they were grandfathered to Pro (see
-- saas_billing.sql §4). Construction Pro now caps jobs at 50 (was 100). A
-- grandfathered Pro org with >50 jobs will hit the cap on its NEXT job create
-- (existing jobs stay). If that affects a real customer, bump them to Business
-- (enterprise) from the platform admin view — Business is unlimited.
--
-- Idempotent. Run in the Supabase SQL editor (single-quoted literals; paste
-- from a text editor, not the web editor). Re-running is safe.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Variant-aware job-create guard (replaces saas_billing.sql's guard_job_create)
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

  -- Max jobs per tier per variant (mirror src/lib/plans.ts maxJobs).
  v_max := case
    when v_eff = 'trial'     then null
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
      raise exception 'Job limit reached (%s) on the %s plan. Upgrade to add more jobs.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$$;

-- (re-attach to the existing trigger; drop+create keeps it pointing at the new fn body)
drop trigger if exists trg_guard_job_create on public.jobs;
create trigger trg_guard_job_create
  before insert on public.jobs
  for each row execute function public.guard_job_create();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Crew-member cap guard (new dimension). Fires on crew_members INSERT.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_crew_member_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_count   bigint;
  v_max     int;
begin
  select plan, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_trial, v_variant
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

  -- Max crew_members per tier per variant (mirror src/lib/plans.ts maxCrewMembers).
  v_max := case
    when v_eff = 'trial'     then null
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
      raise exception 'Crew member limit reached (%s) on the %s plan. Upgrade to add more crew.',
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
-- 3. Defense-in-depth: revoke direct RPC execute (trigger-only fns).
-- ────────────────────────────────────────────────────────────────────────────
revoke execute on function public.guard_job_create()           from public, anon, authenticated;
revoke execute on function public.guard_crew_member_create()   from public, anon, authenticated;