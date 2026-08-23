-- route_opt_quota.sql
-- ----------------------------------------------------------------------------
-- Per-org DAILY route-optimization cap — the server-side enforcement of the
-- free-tier route-opt limit (Step 7 of the capped-free-tier plan). The browser
-- Distance Matrix call is moved behind /api/lawn/route-optimize, which checks +
-- records against this quota before calling Google server-side. This makes the
-- cap money-correct: a free org can't bypass it from the console (the localStorage
-- soft cap in RouteMapPlanner is now just a client pre-check to avoid wasted 429s).
--
-- WHY: route optimization calls the Google Distance Matrix API, which bills per
-- request. Free orgs get 5/day (the conversion hook — capped, not blocked); paid
-- + trial are unlimited; expired/canceled 0. Mirrors the ai_action_gating.sql
-- pattern (a logged, counted, checked quota invoked via explicit SECURITY DEFINER
-- RPCs, not a trigger) — route opts originate from a server route holding the
-- service-role client, not from a client table write.
--
-- DESIGN (mirrors ai_action_gating.sql):
--   check_route_opt_quota(p_org) -> {allowed, used, max}  call BEFORE Google (429 if !allowed → NO Google spend)
--   record_route_opt(p_org,p_profile) -> remaining int     call AFTER  Google (logs the optimization)
-- `record_route_opt` re-checks the quota at insert (TOCTOU-safe: a second
-- request that raced past the check still hits the ceiling here) and raises if
-- over — so the route can rely on either gate.
--
-- QUOTAS (mirror src/lib/plans.ts maxRouteOptsPerDay — variant-INDEPENDENT,
-- Google bills per call regardless of construction vs lawn):
--   free 5, trial/starter/pro/enterprise NULL (unlimited), expired/canceled 0.
--   `route_opt_max()` is the single source of these on the DB side; keep it in
--   sync with plans.ts.
--
-- NOTE on the "no RPCs" guidance: these are SECURITY DEFINER service-role-only —
-- `revoke execute from public, anon, authenticated` (same discipline as
-- ai_action_gating.sql / plan_limits_v2.sql). Invoked from the server route via
-- createAdminClient().rpc(...), which uses the service-role key (bypasses RLS +
-- the revoke).
--
-- Idempotent: create table if not exists / create or replace function. Run in
-- the Supabase SQL editor (paste via Notepad to preserve quotes).
--
-- Verify after running:
--   select proname from pg_proc where proname in ('route_opt_max','check_route_opt_quota','record_route_opt');
--   select tablename from pg_tables where tablename='route_optimizations_log';
--   select relname, relrowsecurity from pg_class where relname='route_optimizations_log';
-- ----------------------------------------------------------------------------

create table if not exists public.route_optimizations_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- Daily quota lookup = (org, calendar day). Serves both the check count and the
-- record re-check.
create index if not exists idx_route_opt_log_org_day
  on public.route_optimizations_log (organization_id, created_at);

alter table public.route_optimizations_log enable row level security;

-- Office/admin can READ their own org's route-opt usage (for a "X optimizations
-- left today" UI). WRITES happen only through the SECURITY DEFINER
-- record_route_opt (bypasses RLS as the function owner), so there is no
-- INSERT/UPDATE/DELETE policy here — clients can't write the log directly, and
-- the revoke below stops them from calling the function.
drop policy if exists route_opt_log_read_own on public.route_optimizations_log;
create policy route_opt_log_read_own on public.route_optimizations_log
  for select
  using (public.same_org(auth.uid(), organization_id));

-- ----------------------------------------------------------------------------
-- Resolve the DAILY route-opt cap for an (effective) plan. Pure (no DB read):
-- callers read organizations.plan + trial_ends_at and pass them in, keeping the
-- lazy-trial-expiry logic in one place. Mirrors src/lib/plans.ts
-- maxRouteOptsPerDay (variant-independent). NULL = unlimited.
-- ----------------------------------------------------------------------------
create or replace function public.route_opt_max(p_plan text, p_trial timestamptz)
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
    when 'free'                        then 5
    when 'trial'                       then null  -- unlimited
    when 'starter'                     then null
    when 'pro'                         then null
    when 'enterprise'                  then null
    when 'expired'                     then 0
    when 'canceled'                    then 0
    else 0
  end;
end;
$$;

-- ----------------------------------------------------------------------------
-- Read-only quota check. Returns (allowed, used, max) for the current calendar
-- DAY. `allowed` is true when max is null (unlimited) or used < max. The route
-- calls this BEFORE hitting Google so an over-quota request returns 429 with NO
-- Google Distance Matrix spend.
-- ----------------------------------------------------------------------------
create or replace function public.check_route_opt_quota(p_org uuid)
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

  v_max := public.route_opt_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.route_optimizations_log
    where organization_id = p_org
      and created_at >= date_trunc('day', now());

  return query select (v_max is null or v_used < v_max), v_used, v_max;
end;
$$;

-- ----------------------------------------------------------------------------
-- Log one route optimization + re-check the quota at insert (TOCTOU-safe).
-- Returns the remaining optimizations after this one (max - used - 1), or -1
-- when max is null (unlimited). Raises if the org is at/over its daily cap —
-- the route treats that as a 429 (the Google call should already have been
-- guarded by check_route_opt_quota, but a race between check + record is caught
-- here).
-- ----------------------------------------------------------------------------
create or replace function public.record_route_opt(
  p_org     uuid,
  p_profile uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan   text;
  v_trial  timestamptz;
  v_eff    text;
  v_max    int;
  v_used   int;
  v_remain int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    raise exception 'Unknown organization for route optimization.';
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  v_max := public.route_opt_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.route_optimizations_log
    where organization_id = p_org
      and created_at >= date_trunc('day', now());

  if v_max is not null and v_used >= v_max then
    raise exception 'Route optimization limit reached (%) on the %s plan today. Upgrade for unlimited.',
      v_max, v_eff;
  end if;

  insert into public.route_optimizations_log (organization_id, profile_id)
  values (p_org, p_profile);

  v_remain := case when v_max is null then -1 else (v_max - v_used - 1) end;
  return v_remain;
end;
$$;

-- Service-role only: no client/anon/authenticated may call these (the route
-- uses createAdminClient().rpc(...) with the service-role key, which bypasses
-- the revoke). Mirrors ai_action_gating.sql / plan_limits_v2.sql discipline.
revoke execute on function public.route_opt_max(text, timestamptz)        from public, anon, authenticated;
revoke execute on function public.check_route_opt_quota(uuid)            from public, anon, authenticated;
revoke execute on function public.record_route_opt(uuid, uuid)           from public, anon, authenticated;