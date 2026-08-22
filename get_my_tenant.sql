-- get_my_tenant.sql
-- Performance audit 2026-08-21 (Task 13). Collapses getMe()'s 3 serial round
-- trips (auth.getUser network call + profiles + organizations) into ONE
-- PostgREST RPC. Client-side, getUser() is replaced by a LOCAL getSession()
-- (reads the cookie the proxy already refreshed — 0 network), so the whole
-- identity+org resolve becomes a single round trip.
--
-- WHY A SECURITY DEFINER RPC (not a PostgREST embed): the live
-- profiles.organization_id -> organizations.id FK is NOT reliably declared
-- (multi_tenancy_a.sql used `add column if not exists ... references`, a NO-OP
-- when the column pre-existed, so the FK never landed). A PostgREST embed
-- organizations(...) on the profiles select 400s (PGRST108) and nulls the
-- whole parent select (broke prod once, see lowvoltage-postgrest-embed-fk). A
-- SECURITY DEFINER function reads both rows server-side, scoped to auth.uid(),
-- needing no FK.
--
-- RLS SAFETY: SECURITY DEFINER bypasses RLS, but the function is self-scoped:
-- `where id = auth.uid()` for the profile, `where id = <own organization_id>`
-- for the org. It can only ever return the caller's OWN profile + org, so the
-- bypass cannot leak cross-tenant data. Returns exactly one row per authed
-- caller; zero rows when not authed (auth.uid() is null).
--
-- SESSION VALIDATION: PostgREST 401s before invoking if the JWT is
-- invalid/expired, which is the session-validation step that used to be
-- auth.getUser(). The client treats a null/error RPC result as signed-out.
--
-- Run in the Supabase SQL Editor. Live-verify with:
--   select proname, prosecdef, provolatile from pg_proc where proname = 'get_my_tenant';
-- (prosecdef = t, provolatile = 's' for STABLE.)

create or replace function public.get_my_tenant()
returns table (
  role text,
  organization_id uuid,
  has_profile boolean,
  is_super_admin boolean,
  org_name text,
  plan text,
  plan_status text,
  trial_ends_at timestamptz,
  app_variant text
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  p_role    text;
  p_org     uuid;
  o_name    text;
  o_plan    text;
  o_status  text;
  o_trial   timestamptz;
  o_variant text;
begin
  if uid is null then
    return;  -- not authenticated, zero rows (client treats as signed-out)
  end if;

  select role, organization_id
    into p_role, p_org
  from public.profiles
  where id = uid;

  -- Skip the org read when there is no org to read. Keys off orgId (not role),
  -- matching getMe(): orgId null -> NO_ORG. A super_admin that still has an
  -- org_id (legacy) resolves its org row too, same as the old code.
  if p_org is not null then
    select name, plan, plan_status, trial_ends_at, app_variant
      into o_name, o_plan, o_status, o_trial, o_variant
    from public.organizations
    where id = p_org;
  end if;

  -- role is returned raw (null when no profile row); the client applies the
  -- "crew" fallback. has_profile distinguishes a real crew user from an
  -- incomplete signup (both role "crew" after the fallback).
  return query select
    p_role,
    p_org,
    (p_role is not null) as has_profile,
    (p_role = 'super_admin') as is_super_admin,
    o_name,
    o_plan,
    o_status,
    o_trial,
    o_variant;
end;
$$;

-- Client-callable: PostgREST invokes as `authenticated` (the JWT role). The
-- function is auth.uid()-scoped, so revoke anon/public defense-in-depth and
-- grant authenticated, the same discipline as approve_estimate /
-- assign_job_crew in harden_function_execute.sql.
revoke execute on function public.get_my_tenant() from public, anon;
grant execute on function public.get_my_tenant() to authenticated;