-- jobs_type.sql — isolate lawn jobs from construction jobs + lawn property profile
-- ----------------------------------------------------------------------------
-- Goal: "everything for lawn stays in the Lawn tab, not in other tabs."
--
--   1. Add a discriminator column on jobs: type text ('construction' | 'lawn'),
--      default 'construction' so every existing + future construction job is
--      correct with zero code change. App validates the two values (no DB CHECK
--      constraint — the repo deliberately avoids CHECK whitelists so adding a
--      new type never needs a schema migration; same convention as
--      recurring_schedules.frequency / lawn_visits.status).
--   2. Backfill: any job that already has a recurring_schedules row IS a lawn
--      job (the de-facto discriminator today).
--   3. lawn_jobs — a 1:1 property PROFILE for lawn jobs (the per-property
--      detail record crews pull up every visit: lot sqft, gate code, pets,
--      access notes, obstacles, sprinkler, map pin). Its PK id IS the jobs.id,
--      so every existing jobs FK (photos.job_id, invoices.job_id,
--      estimates.job_id, recurring_schedules.job_id, lawn_visits.job_id) keeps
--      working unchanged — lawn jobs are still jobs rows (type='lawn'), just
--      filtered out of construction surfaces. The app supplies
--      organization_id (root-style, like lawn_services) since id is the job id,
--      not a job_id column — no set_org_from_job trigger here.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE),
-- no CHECKs, no RPCs, no RLS changes to existing tables — passes
-- scripts/check-migrations.mjs and is safe to re-run.
--
-- Run order: run THIS file in the Supabase SQL Editor BEFORE/AT deploy (paste
-- via Notepad — SQL Editor mangles pasted single quotes into double quotes).
-- The deployed app queries jobs.type the moment it goes live, so the column
-- must exist first or those reads will PostgREST-error.
-- ----------------------------------------------------------------------------
begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Discriminator column on jobs
-- ════════════════════════════════════════════════════════════════════════════
alter table public.jobs
  add column if not exists type text not null default 'construction';

-- Backfill existing lawn jobs (any job with a recurring_schedules row).
-- Re-runnable: once type='lawn' it stays 'lawn' (the WHERE still matches, the
-- UPDATE is a harmless no-op).
update public.jobs
   set type = 'lawn'
 where id in (select job_id from public.recurring_schedules);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. lawn_jobs — 1:1 property profile for a lawn job
--    id = jobs.id (enforced 1:1 by PK); on delete cascade so deleting the job
--    removes its profile. App supplies organization_id.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.lawn_jobs (
  id              uuid primary key references public.jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lot_sqft        numeric,          -- mowable area, for sqft pricing / chem rates
  gate_code       text,            -- crew access
  pets            text,            -- "dog in yard — ring bell", etc.
  access_notes    text,            -- "key under mat", "unlock side gate"
  obstacles       text,            -- sprinkler heads, dog run, beehives
  sprinkler       boolean not null default false,
  map_lat         numeric,
  map_lng         numeric,
  created_at      timestamptz not null default now()
);

create index if not exists idx_lawn_jobs_org on public.lawn_jobs(organization_id);

alter table public.lawn_jobs enable row level security;

-- Office/admin/PM manage their org's lawn job profiles; app supplies org.
drop policy if exists "Office manage lawn job profiles" on public.lawn_jobs;
create policy "Office manage lawn job profiles" on public.lawn_jobs
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- All management can read.
drop policy if exists "Management read lawn job profiles" on public.lawn_jobs;
create policy "Management read lawn job profiles" on public.lawn_jobs
  for select to authenticated
  using (public.tier_management(organization_id));

-- Crew assigned to the job can read the property profile (so the field crew
-- sees gate code / pets / access before they arrive).
drop policy if exists "Crew read assigned lawn job profiles" on public.lawn_jobs;
create policy "Crew read assigned lawn job profiles" on public.lawn_jobs
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = lawn_jobs.id and auth.uid() = any(j.assigned_crew)
    )
  );

-- Owning customer can read their own lawn job's property profile.
drop policy if exists "Customer read own lawn job profile" on public.lawn_jobs;
create policy "Customer read own lawn job profile" on public.lawn_jobs
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = lawn_jobs.id
        and j.customer_id in (select customer_id from public.profiles where id = auth.uid())
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Verification (run manually in SQL Editor after this file succeeds)
-- ════════════════════════════════════════════════════════════════════════════
-- select type, count(*) from public.jobs group by type;
-- select count(*) from public.lawn_jobs;          -- should equal # lawn jobs
-- select count(*) from public.jobs where type='lawn'
--   and id not in (select id from public.lawn_jobs);  -- 0 (lawn_jobs created on /lawn/new)

commit;