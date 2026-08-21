-- ai_action_gating.sql
-- ----------------------------------------------------------------------------
-- Per-org MONTHLY AI-action cap — the margin-safety gate that MUST exist before
-- the first AI feature (photo analysis, in-app assistant, etc.) ships.
--
-- WHY: AI features add a per-request LLM variable cost that flat per-org pricing
-- does NOT recover (see lowvoltage-pricing-enforcement-audit.md — the same
-- "flat pricing eats variable cost" theme as the storage leak). Without a cap,
-- a $29 Starter org running 10k photo-analyses/month would cost the platform
-- more than it pays in. This gate makes AI usage bounded + tier-gated so growth
-- can never turn AI into a loss leader.
--
-- DESIGN — a logged, counted, checked quota (NOT a hard trigger like the
-- storage/job guards, because AI actions originate from server routes that
-- already hold the service-role client, not from client writes to a table).
-- Two SECURITY DEFINER RPCs the AI routes call via the service-role admin
-- client (mirrors the guard_* pattern but invoked explicitly, not as a
-- trigger):
--   check_ai_quota(p_org)  -> {allowed, used, max}   call BEFORE the LLM (429 if !allowed → NO LLM cost)
--   record_ai_action(...)  -> remaining (int)         call AFTER  the LLM (logs tokens + cost)
-- `record_ai_action` re-checks the quota at insert time (TOCTOU-safe: a second
-- request that raced past check_ai_quota still hits the ceiling here) and
-- raises if over — so the route can rely on either gate.
--
-- QUOTAS (mirror src/lib/plans.ts maxAiActionsPerMonth — variant-INDEPENDENT,
-- LLM cost doesn't depend on construction vs lawn):
--   trial 25  (a taste), starter 0 (AI disabled), pro 100, enterprise 5000,
--   expired/canceled 0. `ai_action_max()` is the single source of these on the
-- DB side; keep it in sync with plans.ts.
--
-- NOTE on the "no RPCs" guidance: that refers to CLIENT-callable RPCs (anon/
-- authenticated execute). These functions are SECURITY DEFINER service-role-
-- only — `revoke execute from public, anon, authenticated` (same discipline as
-- plan_limits_v2.sql / storage_cap.sql). They are invoked from server routes
-- via createAdminClient().rpc(...), which uses the service-role key (bypasses
-- RLS + the revoke). Consistent with the existing guard_* pattern; just called
-- explicitly rather than attached to a trigger, because AI actions aren't a
-- table the client writes to.
--
-- Idempotent: create table if not exists / create or replace function. Run in
-- the Supabase SQL editor (paste via Notepad to preserve quotes).
--
-- Verify after running:
--   select proname from pg_proc where proname in ('ai_action_max','check_ai_quota','record_ai_action');
--   select tablename from pg_tables where tablename='ai_action_log';
--   select relname, relrowsecurity from pg_class where relname='ai_action_log';
-- ----------------------------------------------------------------------------

create table if not exists public.ai_action_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id      uuid references public.profiles(id) on delete set null,
  feature         text not null,                 -- e.g. 'photo_analysis', 'assistant'
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  cost_cents      integer not null default 0,    -- LLM cost of this action, in cents
  created_at      timestamptz not null default now()
);

-- Monthly quota lookup = (org, calendar month). This index serves both the
-- check_ai_quota count and the record_ai_action re-check.
create index if not exists idx_ai_action_log_org_month
  on public.ai_action_log (organization_id, created_at);

alter table public.ai_action_log enable row level security;

-- Office/admin can READ their own org's AI usage (for a "X actions left this
-- month" UI + an admin usage view). WRITES happen only through the
-- SECURITY DEFINER record_ai_action (bypasses RLS as the function owner), so
-- there is no INSERT/UPDATE/DELETE policy here — clients can't write the log
-- directly, and the revoke below stops them from calling the function.
drop policy if exists ai_action_log_read_own on public.ai_action_log;
create policy ai_action_log_read_own on public.ai_action_log
  for select
  using (public.same_org(auth.uid(), organization_id));

-- ----------------------------------------------------------------------------
-- Resolve the monthly AI-action cap for an (effective) plan. Pure (no DB read):
-- callers read organizations.plan + trial_ends_at and pass them in, keeping the
-- lazy-trial-expiry logic in one place. Mirrors src/lib/plans.ts
-- maxAiActionsPerMonth (variant-independent).
-- ----------------------------------------------------------------------------
create or replace function public.ai_action_max(p_plan text, p_trial timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eff text;
begin
  v_eff := p_plan;
  if p_plan = 'trial' and p_trial is not null and now() > p_trial then
    v_eff := 'expired';
  end if;

  return case v_eff
    when 'trial'                       then 25
    when 'pro'                         then 100
    when 'enterprise'                  then 5000
    when 'starter'                     then 0
    when 'expired'                     then 0
    when 'canceled'                    then 0
    else 0
  end;
end;
$$;

-- ----------------------------------------------------------------------------
-- Read-only quota check. Returns (allowed, used, max) for the current calendar
-- month. `allowed` is true when max is null (unlimited — not currently used) or
-- used < max. AI routes call this BEFORE invoking the LLM so an over-quota
-- request returns 429 with NO LLM spend.
-- ----------------------------------------------------------------------------
create or replace function public.check_ai_quota(p_org uuid)
returns table(allowed boolean, used int, max int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  text;
  v_trial timestamptz;
  v_max   int;
  v_used  int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    -- Unknown org: deny (no quota to spend).
    return query select false, 0, 0;
    return;
  end if;

  v_max := public.ai_action_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.ai_action_log
    where organization_id = p_org
      and created_at >= date_trunc('month', now());

  return query select (v_max is null or v_used < v_max), v_used, v_max;
end;
$$;

-- ----------------------------------------------------------------------------
-- Log one AI action + re-check the quota at insert (TOCTOU-safe). Returns the
-- remaining actions after this one (max - used - 1), or -1 when max is null
-- (unlimited). Raises if the org is at/over its monthly cap — the route treats
-- that as a 429 (the LLM call should already have been guarded by check_ai_quota,
-- but a race between check + record is caught here).
-- ----------------------------------------------------------------------------
create or replace function public.record_ai_action(
  p_org         uuid,
  p_profile     uuid,
  p_feature     text,
  p_tokens_in   int default 0,
  p_tokens_out  int default 0,
  p_cost_cents  int default 0
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan     text;
  v_trial    timestamptz;
  v_eff      text;
  v_max      int;
  v_used     int;
  v_remain   int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    raise exception 'Unknown organization for AI action.';
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  v_max := public.ai_action_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.ai_action_log
    where organization_id = p_org
      and created_at >= date_trunc('month', now());

  if v_max is not null and v_used >= v_max then
    raise exception 'AI action limit reached (%) on the %s plan this month. Upgrade for more.',
      v_max, v_eff;
  end if;

  insert into public.ai_action_log
    (organization_id, profile_id, feature, tokens_in, tokens_out, cost_cents)
  values
    (p_org, p_profile, p_feature, p_tokens_in, p_tokens_out, p_cost_cents);

  v_remain := case when v_max is null then -1 else (v_max - v_used - 1) end;
  return v_remain;
end;
$$;

-- Service-role only: no client/anon/authenticated may call these (the AI routes
-- use createAdminClient().rpc(...) with the service-role key, which bypasses
-- the revoke). Mirrors plan_limits_v2.sql / storage_cap.sql discipline.
revoke execute on function public.ai_action_max(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.check_ai_quota(uuid)               from public, anon, authenticated;
revoke execute on function public.record_ai_action(uuid, uuid, text, int, int, int) from public, anon, authenticated;