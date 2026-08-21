-- close_legacy_rls_bypass.sql
-- ----------------------------------------------------------------------------
-- Closes 13 confirmed UNSCOPED (cross-tenant) RLS bypasses found live in
-- pg_policy 2026-08-19. Each dropped policy checks only `role = 'office'` (or
-- nothing) with NO organization scope, so an office user could SELECT / INSERT /
-- UPDATE / DELETE across EVERY tenant's rows. Each has a verified org-scoped
-- replacement already live (tier_office(organization_id) or
-- tier_office(storage_job_org(name))) covering the same command, so dropping
-- the unscoped one removes the bypass without losing access.
--
-- ONE ADDITIONAL FIX vs the original audit list: jobs had NO scoped office
-- SELECT policy — "Office full access jobs" (ALL, unscoped) was the only office
-- read path. Dropping it without a replacement would strand office users with
-- zero jobs read access. So we CREATE "Office select jobs" (scoped) FIRST.
--
-- Verified live before authorizing (pg_policy ground truth, not file grep —
-- these were created ad-hoc in the SQL Editor, so no committed .sql file
-- contained them). Photo revert also confirmed: storage "Office upload photos"
-- INSERT body = tier_office(storage_job_org(name)) (org-scoped), no leftover
-- is_office(auth.uid()) hole.
--
-- Run order matters: the CREATE must precede the jobs drops. Idempotent drops
-- (if exists). If a paste into the SQL Editor clips long content, run in the
-- 4 batches marked below.
-- ----------------------------------------------------------------------------

-- ===================== BATCH 1: jobs (create FIRST, then drop) ==============
create policy "Office select jobs" on public.jobs
  for select to authenticated
  using (public.tier_office(organization_id));

drop policy if exists "Office delete jobs"      on public.jobs;
drop policy if exists "Office full access jobs" on public.jobs;

-- ===================== BATCH 2: customers + photos =========================
drop policy if exists "Office full access"        on public.customers;
drop policy if exists "Office delete photos"      on public.photos;
drop policy if exists "Office full access photos" on public.photos;

-- ===================== BATCH 3: rfis + blueprints + job_views ==============
drop policy if exists "Office delete rfis"          on public.rfis;
drop policy if exists "Office full access rfis"     on public.rfis;
drop policy if exists "Office delete blueprints db" on public.blueprints;
drop policy if exists "Office full access blueprints" on public.blueprints;
drop policy if exists "Office delete job views"     on public.job_views;

-- ===================== BATCH 4: storage.objects (blueprints bucket) ========
drop policy if exists "office_delete_blueprints" on storage.objects;
drop policy if exists "office_upload_blueprints" on storage.objects;
drop policy if exists "public_read_blueprints"   on storage.objects;

-- ----------------------------------------------------------------------------
-- VERIFY (run after all 4 batches). Expect 0 rows from the first, 1 from the
-- second.
-- ----------------------------------------------------------------------------
-- select c.relname as tbl, p.polname as policy
-- from pg_policy p
-- join pg_class c on c.oid = p.polrelid
-- join pg_namespace n on n.oid = c.relnamespace
-- where ((n.nspname='public'
--   and c.relname in ('jobs','customers','photos','rfis','blueprints','job_views'))
--   or (n.nspname='storage' and c.relname='objects'))
--   and p.polname in (
--     'Office delete jobs','Office full access jobs','Office full access',
--     'Office delete photos','Office full access photos',
--     'Office delete rfis','Office full access rfis',
--     'Office delete blueprints db','Office full access blueprints',
--     'Office delete job views',
--     'office_delete_blueprints','office_upload_blueprints','public_read_blueprints');
--
-- select polname from pg_policy
-- where polrelid='public.jobs'::regclass and polname='Office select jobs';