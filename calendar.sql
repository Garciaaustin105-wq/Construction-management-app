-- calendar.sql — Calendar integration v1 (iCal subscribe feed)
-- ----------------------------------------------------------------------------
-- Adds the date-bearing columns + tables the per-user iCal feed reads from.
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE) so
-- it passes scripts/check-migrations.mjs and is safe to re-run.
--
-- Run order: run THIS file in the Supabase SQL Editor BEFORE deploying the app
-- code that queries the new columns/tables (the new UI reads due_date /
-- valid_until / scheduled_date / schedule_events and would get PostgREST errors
-- if the columns did not exist yet).
--
-- Reuses the multi-tenancy helpers from multi_tenancy_a.sql / _b.sql:
--   same_org(uid, org_id)              — uid is in that org (or super_admin)
--   tier_office(org_id)                — office/admin/super_admin AND same_org
--   tier_office_or_pm(org_id)          — office/admin/PM/super_admin AND same_org
--   tier_management(org_id)            — management/super_admin AND same_org
--   set_org_from_job()                 — BEFORE INSERT trigger fn: stamps
--                                        organization_id from new.job_id
-- ----------------------------------------------------------------------------

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. New date columns on existing tables (all nullable — existing rows keep NULL)
-- ════════════════════════════════════════════════════════════════════════════

-- When a subcontractor is due on site for a job.
alter table public.job_subcontractors
  add column if not exists scheduled_date date;

-- Payment due date for an invoice.
alter table public.invoices
  add column if not exists due_date date;

-- Quote expiry / "valid until" date.
alter table public.quotes
  add column if not exists valid_until date;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. schedule_events — job-anchored meetings / inspections / deliveries /
--    milestones. Surfaced as timed VEVENTs in the iCal feed.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.schedule_events (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  title           text not null,
  start_at        timestamptz not null,
  end_at          timestamptz,                 -- null = point-in-time event
  kind            text not null default 'meeting',  -- meeting/inspection/delivery/milestone/other
  notes           text,
  created_by      uuid references public.profiles(id) on delete set null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create index if not exists idx_schedule_events_job
  on public.schedule_events(job_id);
create index if not exists idx_schedule_events_org_start
  on public.schedule_events(organization_id, start_at);

alter table public.schedule_events enable row level security;

-- Stamp organization_id from the parent job (same trigger fn every other
-- job-child table uses). RAISES if the job is missing, so a bad job_id can't
-- produce a row with a null org.
drop trigger if exists trg_schedule_events_org on public.schedule_events;
create trigger trg_schedule_events_org before insert on public.schedule_events
  for each row execute function public.set_org_from_job();

-- RLS — mirrors the blueprints pattern:
--   office/admin/PM manage (insert/update/delete + read),
--   all management read,
--   assigned crew read,
--   owning customer read.
drop policy if exists "Office manage schedule events" on public.schedule_events;
create policy "Office manage schedule events" on public.schedule_events
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read schedule events" on public.schedule_events;
create policy "Management read schedule events" on public.schedule_events
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned schedule events" on public.schedule_events;
create policy "Crew read assigned schedule events" on public.schedule_events
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = schedule_events.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own schedule events" on public.schedule_events;
create policy "Customer read own schedule events" on public.schedule_events
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = schedule_events.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. calendar_feeds — per-user subscribe token. The token in the feed URL is
--    the ONLY auth for /api/calendar/feed (calendar clients can't send headers
--    or cookies), so it must be unguessable (gen_random_uuid) and unique.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.calendar_feeds (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  token           uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  last_fetched_at timestamptz,
  created_at      timestamptz not null default now()
);

-- One feed row per user; the token is the lookup key for the public feed route.
create unique index if not exists idx_calendar_feeds_user
  on public.calendar_feeds(user_id);
create unique index if not exists idx_calendar_feeds_token
  on public.calendar_feeds(token);

alter table public.calendar_feeds enable row level security;

-- A user manages only their own feed row, within their own org. The feed route
-- itself uses the service role (no auth.uid()) and looks the row up by token,
-- so this policy only governs the in-app token management endpoints.
drop policy if exists "User manage own feed" on public.calendar_feeds;
create policy "User manage own feed" on public.calendar_feeds
  for all to authenticated
  using (public.same_org(auth.uid(), organization_id) and user_id = auth.uid())
  with check (public.same_org(auth.uid(), organization_id) and user_id = auth.uid());

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Verification (run manually in SQL Editor after this file succeeds)
-- ════════════════════════════════════════════════════════════════════════════
-- select scheduled_date from public.job_subcontractors limit 1;  -- null ok, no error
-- select due_date from public.invoices limit 1;                  -- null ok, no error
-- select valid_until from public.quotes limit 1;                 -- null ok, no error
-- select count(*) from public.schedule_events;                   -- 0 ok
-- select count(*) from public.calendar_feeds;                    -- 0 ok

commit;