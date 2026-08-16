-- ============================================================================
-- Terra Vista — City inspections checklist (job_inspections table + jobs.project_type).
-- ----------------------------------------------------------------------------
-- A per-job inspection checklist driven by whether the project is commercial or
-- residential. The curated baseline templates live in app code
-- (src/lib/inspectionTemplates.ts) and are seeded into job_inspections rows when
-- the office/PM clicks "Generate checklist" on /jobs/[id]/inspections. v1 uses
-- a generic US baseline (per-jurisdiction templates keyed to the job's location
-- are a follow-up). Each row tracks status (required/scheduled/passed/failed/na),
-- scheduled date, inspector, notes, and an optional cost-code tie-in.
--
-- Also adds jobs.project_type (commercial | residential) — set on the
-- construction job-creation portal (/admin/projects/new). No DB CHECK (repo
-- convention); null on old jobs + lawn jobs.
--
-- Run ONCE in the Supabase SQL Editor — paste from Notepad, NOT the terminal
-- (the Editor mangles pasted single quotes into double quotes); single-quoted
-- literals only.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE —
-- passes scripts/check-migrations.mjs). drop policy/trigger/index if exists +
-- create table if not exists / add column if not exists are safe and used below.
--
-- Run BEFORE deploying the app code that queries job_inspections / project_type
-- (the inspections UI would get PostgREST errors otherwise). Until then the app
-- degrades gracefully (supabase-js returns {error} not throw -> [] / null).
--
-- Reuses the SECURITY DEFINER helpers from multi_tenancy_a.sql / _b.sql:
--   tier_office_or_pm(org_id) / tier_management(org_id) / same_org(uid, org_id)
--   set_org_from_job()  -- BEFORE INSERT trigger: stamps org from job
--
-- RLS is the four-tier pattern from schedule_events (calendar.sql): office/PM
-- manage (for all), management read, assigned-crew read, owning-customer read.
-- job_inspections policies join `jobs` -> no RLS recursion.
-- ============================================================================
begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. jobs.project_type — commercial | residential (nullable; no CHECK).
--    Drives which curated inspection template seeds the checklist. Old jobs
--    and lawn jobs keep NULL (the inspections page offers to generate, default
--    residential, or prompt). The construction job creator sends the value.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.jobs
  add column if not exists project_type text;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. job_inspections — per-job inspection checklist rows.
--    status: required (default) -> scheduled -> passed | failed | na.
--    No DB CHECK on `status` (repo convention: app validates enums).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.job_inspections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  title           text not null,
  position        integer not null default 0,
  status          text not null default 'required',
  scheduled_date  date,
  inspector       text,
  notes           text,
  cost_code_id    uuid references public.cost_codes(id) on delete set null,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_job_inspections_job
  on public.job_inspections(job_id);
create index if not exists idx_job_inspections_org_position
  on public.job_inspections(organization_id, job_id, position);

alter table public.job_inspections enable row level security;

-- Stamp organization_id from the parent job (same trigger fn every other
-- job-child table uses). RAISES if the job is missing.
drop trigger if exists trg_job_inspections_org on public.job_inspections;
create trigger trg_job_inspections_org before insert on public.job_inspections
  for each row execute function public.set_org_from_job();

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — mirror the schedule_events pattern (calendar.sql):
--   office/admin/PM manage (create/edit/delete, set status/date/inspector),
--   all management read,
--   assigned crew read,
--   owning customer read.
-- Crew/management/customer are read-only by construction (no insert/update/
-- delete policies for them -> their writes no-op).
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists "Office manage job inspections" on public.job_inspections;
create policy "Office manage job inspections" on public.job_inspections
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read job inspections" on public.job_inspections;
create policy "Management read job inspections" on public.job_inspections
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned job inspections" on public.job_inspections;
create policy "Crew read assigned job inspections" on public.job_inspections
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = job_inspections.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own job inspections" on public.job_inspections;
create policy "Customer read own job inspections" on public.job_inspections
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = job_inspections.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- Verification (run manually in SQL Editor after this file succeeds)
-- ════════════════════════════════════════════════════════════════════════════
-- select project_type from public.jobs limit 1;        -- null ok, no error
-- select count(*) from public.job_inspections;          -- 0 ok

notify pgrst, 'reload schema';

commit;