-- fix_jobs_recursion.sql — break the jobs ↔ lawn_visits RLS infinite recursion
-- ----------------------------------------------------------------------------
-- SYMPTOM: every authenticated read of public.jobs (and any table joining it —
-- photos, rfis, invoices) fails with
--     42P17: infinite recursion detected in policy for relation "jobs"
-- so the office/admin dashboard renders an empty jobs list (and empty photos/
-- RFI/invoice tiles) for EVERY role, not just crew. Surfaced by the temporary
-- DEBUG banner on /dashboard (commit 2182bb8).
--
-- ROOT CAUSE: lawn_crew_route.sql added a SELECT policy on public.jobs that
-- looks the crew's visits up DIRECTLY on lawn_visits:
--
--   create policy "Crew read jobs via lawn visit" on public.jobs for select
--     using ( same_org(...) and exists (
--       select 1 from public.lawn_visits lv
--       where lv.job_id = jobs.id and lv.crew_id = auth.uid() ));
--
-- A direct subquery enforces RLS on the inner table. lawn_visits already has
-- crew/customer SELECT policies that look the job up DIRECTLY on jobs:
--
--   "Crew read assigned lawn visits"   -> exists (select 1 from jobs j ...)
--   "Customer read own lawn visits"     -> exists (select 1 from jobs j ...)
--
-- So evaluating the jobs policy enforces RLS on lawn_visits, whose policies
-- enforce RLS on jobs, whose policy enforces RLS on lawn_visits ... = infinite
-- recursion. Postgres raises 42P17. (The existing tier_*/same_org helpers do
-- NOT recurse because they are SECURITY DEFINER — the function owner bypasses
-- RLS, so no policy is re-evaluated inside them. The bug is the one DIRECT
-- jobs→lawn_visits edge introduced by lawn_crew_route.sql.)
--
-- FIX: route the jobs-side lookup through a SECURITY DEFINER helper that reads
-- lawn_visits with RLS BYPASSED, exactly like same_org()/tier_*() read
-- profiles. The jobs policy no longer enforces RLS on lawn_visits, so the
-- jobs→lawn_visits edge disappears; lawn_visits→jobs stays (harmless — jobs
-- does not reference lawn_visits back anymore), and the cycle is broken for
-- every role. The lawn_visits-side policies are intentionally left untouched.
--
-- Additive + idempotent (create or replace function, drop policy if exists).
-- No CHECKs/RPCs/DROP TABLE/COLUMN — passes scripts/check-migrations.mjs.
-- Run in the Supabase SQL Editor (paste via Notepad so quotes survive). Re-run
-- is safe. No app change is required for this fix to take effect, but commit
-- 2182bb8's temporary DEBUG banner should be removed once verified.
-- ----------------------------------------------------------------------------

-- 1. SECURITY DEFINER helper: does this user have ANY lawn visit assigned to
--    this job (crew_id = uid)? RLS is BYPASSED inside the function (owner is
--    the creator / superuser), so the jobs policy that calls it cannot recurse
--    into lawn_visits' own policies. Mirrors the same_org/tier_* pattern.
create or replace function public.lawn_visit_assigned_to(p_job_id uuid, p_uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.lawn_visits lv
    where lv.job_id = p_job_id and lv.crew_id = p_uid
  );
$$;

-- 2. Rewrite the offending jobs policy to use the helper (RLS bypassed) instead
--    of a direct lawn_visits subquery (RLS enforced → recursion). Same
--    admission semantics: same org AND the caller has a visit on this job.
drop policy if exists "Crew read jobs via lawn visit" on public.jobs;
create policy "Crew read jobs via lawn visit" on public.jobs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and public.lawn_visit_assigned_to(jobs.id, auth.uid())
  );

-- 3. Verify (run manually in the SQL Editor after this succeeds):
--      select count(*) from public.jobs;            -- a number, NOT 42P17
--      select id, name from public.jobs limit 5;    -- rows return
--    Then reload /dashboard as office/admin/crew — the jobs list + photos/
--    RFI/invoice tiles populate and the red DEBUG banner is gone (once the
--    banner removal commit deploys).