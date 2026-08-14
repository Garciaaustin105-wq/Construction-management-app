-- lawn_maintenance.sql — Lawn Maintenance area + recurring job schedules
-- ----------------------------------------------------------------------------
-- Adds the three tables behind the Lawn tab: a per-org service catalog / price
-- book (lawn_services), a job's recurrence rule (recurring_schedules), and the
-- materialized visit instances generated from a rule (lawn_visits). Also adds a
-- nullable visit_id FK on photos so before/after photos can attach to a visit.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE) so
-- it passes scripts/check-migrations.mjs and is safe to re-run.
--
-- Run order: run THIS file in the Supabase SQL Editor BEFORE deploying the app
-- code that queries the new tables (the Lawn UI reads lawn_services /
-- recurring_schedules / lawn_visits and would get PostgREST errors if the
-- tables did not exist yet).
--
-- Reuses the multi-tenancy helpers from multi_tenancy_a.sql / _b.sql:
--   same_org(uid, org_id)              — uid is in that org (or super_admin)
--   tier_office(org_id)                — office/admin/super_admin AND same_org
--   tier_office_or_pm(org_id)          — office/admin/PM/super_admin AND same_org
--   tier_management(org_id)            — management/super_admin AND same_org
--   set_org_from_job()                 — BEFORE INSERT trigger fn: stamps
--                                        organization_id from new.job_id
--
-- Design notes:
--   * lawn_services is a ROOT table (no job_id) — the app supplies
--     organization_id and `with check tier_office(organization_id)` enforces it.
--   * recurring_schedules + lawn_visits are job-anchored, so set_org_from_job()
--     stamps org from job_id (the app does NOT send organization_id for these).
--   * No CHECK constraints on the status/frequency text columns — the app
--     validates, and a DB CHECK whitelist is exactly the trap that bit
--     profiles_role_check (adding a new role required a schema migration).
--   * No RPCs — visit generation is done in JS (the app's standing stance of
--     keeping SQL literal-free / paste-safe).
-- ----------------------------------------------------------------------------

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. lawn_services — org-scoped service catalog / price book (ROOT table)
--    "Mow & edge", "Fertilize", "Aeration", "Leaf cleanup", "Hedge trim"…
--    Populates the service dropdown on job-create + the Services manager.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.lawn_services (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  default_price   numeric(12,2) not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create index if not exists idx_lawn_services_org
  on public.lawn_services(organization_id, active);

alter table public.lawn_services enable row level security;

-- Office/admin/super_admin manage their own org's catalog; app supplies the
-- organization_id (root table), and `with check` keeps a cross-org write out.
drop policy if exists "Office manage lawn services" on public.lawn_services;
create policy "Office manage lawn services" on public.lawn_services
  for all to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

-- Any same-org user (incl. crew/PM) can read the catalog to populate dropdowns.
drop policy if exists "Management read lawn services" on public.lawn_services;
create policy "Management read lawn services" on public.lawn_services
  for select to authenticated
  using (public.tier_management(organization_id));

-- ════════════════════════════════════════════════════════════════════════════
-- 2. recurring_schedules — a job's recurrence rule (job-anchored)
--    One row per lawn job describing the route (e.g. "biweekly Mon+Thu,
--    Mar 1–Nov 30, Mow & edge, $45/visit"). lawn_visits are generated from it.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.recurring_schedules (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  frequency       text not null,                 -- 'weekly' | 'biweekly' | 'monthly' (app validates)
  interval_weeks  int not null default 1,        -- 1=weekly, 2=biweekly, 4=monthly (drives generation)
  days_of_week     int[] not null default '{}',   -- 0=Sun..6=Sat, for weekly/biweekly
  day_of_month    int,                            -- 1..28, for true monthly
  start_date      date not null,
  end_date        date,                           -- null = open-ended season
  service_type    text,                           -- free text or matches a lawn_services.name
  price_per_visit numeric(12,2) not null default 0,
  active          boolean not null default true,  -- pause the whole route without deleting
  notes           text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_recurring_schedules_job
  on public.recurring_schedules(job_id);
create index if not exists idx_recurring_schedules_org
  on public.recurring_schedules(organization_id, active);

alter table public.recurring_schedules enable row level security;

-- Stamp organization_id from the parent job (shared trigger fn every other
-- job-child table uses). RAISES if the job is missing, so a bad job_id can't
-- produce a row with a null org.
drop trigger if exists trg_recurring_schedules_org on public.recurring_schedules;
create trigger trg_recurring_schedules_org before insert on public.recurring_schedules
  for each row execute function public.set_org_from_job();

-- RLS — mirrors the schedule_events blueprint:
--   office/admin/PM manage (insert/update/delete + read),
--   all management read,
--   assigned crew read,
--   owning customer read.
drop policy if exists "Office manage recurring schedules" on public.recurring_schedules;
create policy "Office manage recurring schedules" on public.recurring_schedules
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read recurring schedules" on public.recurring_schedules;
create policy "Management read recurring schedules" on public.recurring_schedules
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned recurring schedules" on public.recurring_schedules;
create policy "Crew read assigned recurring schedules" on public.recurring_schedules
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = recurring_schedules.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own recurring schedules" on public.recurring_schedules;
create policy "Customer read own recurring schedules" on public.recurring_schedules
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = recurring_schedules.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. lawn_visits — materialized visit instances (job-anchored)
--    One row per scheduled visit date per schedule. Lifecycle:
--    pending → done | skipped | paused. "Move" = update due_date. The Today's
--    Route board reads due_date <= today AND status = 'pending'.
--    job_id is denormalized so set_org_from_job can stamp org + route joins
--    don't need to hop through recurring_schedules.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.lawn_visits (
  id                    uuid primary key default gen_random_uuid(),
  recurring_schedule_id uuid not null references public.recurring_schedules(id) on delete cascade,
  job_id                uuid not null references public.jobs(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  due_date              date not null,
  status                text not null default 'pending',  -- 'pending'|'done'|'skipped'|'paused'
  crew_id               uuid references public.profiles(id) on delete set null,
  completed_at          timestamptz,
  notes                 text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_lawn_visits_schedule
  on public.lawn_visits(recurring_schedule_id);
create index if not exists idx_lawn_visits_org_due
  on public.lawn_visits(organization_id, due_date);
create index if not exists idx_lawn_visits_status
  on public.lawn_visits(status);

-- One visit per schedule per date. The app relies on this for "regenerate /
-- extend" (insert-or-skip) and to catch a "move to an already-occupied date"
-- collision as a 23505 in JS.
create unique index if not exists uniq_lawn_visits_schedule_due
  on public.lawn_visits(recurring_schedule_id, due_date);

alter table public.lawn_visits enable row level security;

drop trigger if exists trg_lawn_visits_org on public.lawn_visits;
create trigger trg_lawn_visits_org before insert on public.lawn_visits
  for each row execute function public.set_org_from_job();

-- RLS — same blueprint as schedule_events.
drop policy if exists "Office manage lawn visits" on public.lawn_visits;
create policy "Office manage lawn visits" on public.lawn_visits
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read lawn visits" on public.lawn_visits;
create policy "Management read lawn visits" on public.lawn_visits
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned lawn visits" on public.lawn_visits;
create policy "Crew read assigned lawn visits" on public.lawn_visits
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = lawn_visits.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own lawn visits" on public.lawn_visits;
create policy "Customer read own lawn visits" on public.lawn_visits
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = lawn_visits.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 4. photos.visit_id — nullable FK so before/after photos attach to a visit.
--    No new photo policies: existing photos RLS is job/org-scoped, so a visit
--    photo (inserted with both job_id = the visit's job AND visit_id) inherits
--    the same access. The visit page filters `photos where visit_id = :id`.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.photos
  add column if not exists visit_id uuid references public.lawn_visits(id) on delete set null;

create index if not exists idx_photos_visit
  on public.photos(visit_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Verification (run manually in SQL Editor after this file succeeds)
-- ════════════════════════════════════════════════════════════════════════════
-- select count(*) from public.lawn_services;            -- 0 ok
-- select count(*) from public.recurring_schedules;      -- 0 ok
-- select count(*) from public.lawn_visits;               -- 0 ok
-- select count(*) from public.photos where visit_id is not null;  -- 0 ok
-- select tgname from pg_trigger where tgname in ('trg_recurring_schedules_org','trg_lawn_visits_org');

commit;