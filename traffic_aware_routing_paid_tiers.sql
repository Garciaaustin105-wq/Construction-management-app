-- Traffic-aware routing (Google Distance Matrix) becomes a PAID-tier feature.
-- Applied to prod 2026-09-01. Supersedes the `free` case in route_opt_quota.sql.
--
-- Free drops from 5/day to 0. The app's OWN optimizer stays on every tier
-- including free — nearestNeighborRoute + refineRouteHaversine in
-- src/lib/lawnRouting.ts is nearest-neighbour plus 2-opt on straight-line
-- distance. It costs nothing, needs no third-party API, works offline, and
-- cannot be deprecated out from under us. Free users still get an optimized
-- route; what is gated is specifically the REAL DRIVE TIME matrix, which is
-- the only part carrying a metered per-call cost.
--
-- No new mechanism: 0 already means "disabled" here (expired/canceled use it),
-- and check_route_opt_quota computes
--     allowed := (v_max is null or v_used < v_max)
-- so 0 denies before any Google call is made — zero spend on a blocked request.
--
-- MUST be changed together with src/lib/plans.ts (`maxRouteOptsPerDay` on the
-- free tier of BOTH LAWN_TIERS and CONSTRUCTION_TIERS). This function takes a
-- plan name and is variant-agnostic — one 'free' case serves both apps — so a
-- change on one side only makes the app and the database disagree about what
-- is allowed.
--
-- Safe when applied: all three orgs were on 'pro'. No live org lost anything.
--
-- Idempotent + additive: CREATE OR REPLACE only, no DROP, no TRUNCATE.

create or replace function public.route_opt_max(p_plan text, p_trial timestamptz)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_eff text;
begin
  v_eff := p_plan;
  if p_plan = 'trial' and p_trial is not null and now() > p_trial then
    v_eff := 'expired';
  end if;

  return case v_eff
    when 'free'                        then 0     -- was 5: paid feature now
    when 'trial'                       then null  -- unlimited
    when 'starter'                     then null
    when 'growth'                      then null
    when 'pro'                         then null
    when 'enterprise'                  then null
    when 'expired'                     then 0
    when 'canceled'                    then 0
    else 0
  end;
end;
$function$;
