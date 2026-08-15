-- ============================================================================
-- billing_past_due_gate.sql  (idempotent / additive — safe to re-run)
-- ----------------------------------------------------------------------------
-- Block new jobs when the org's subscription is past_due, in ADDITION to the
-- expired/canceled check the trigger already had. Mirrors the createGate
-- past_due change in src/lib/billing.ts.
--
-- Why a trigger: /lawn/new and /admin/projects/new are client components that
-- insert jobs directly via the RLS user client (no server route). The app-side
-- createGate only gates /api/users (seat creation). A BEFORE-INSERT trigger is
-- the only reliable gate for client-direct job inserts — it runs for every
-- insert regardless of caller (client or service role).
--
-- Run in Supabase SQL Editor (Notepad paste). No data changes; just redefines
-- the function + re-arms the trigger. Reads stay allowed when past_due — only
-- CREATES are blocked.
-- ============================================================================

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

  -- Past-due subscription: a payment failed and Stripe is retrying. Block new
  -- jobs until billing info is updated (matches createGate past_due check).
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume creating jobs.';
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