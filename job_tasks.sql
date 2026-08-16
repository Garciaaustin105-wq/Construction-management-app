-- ============================================================================
-- Terra Vista — Gantt / project-breakdown scheduling (job_tasks WBS table).
-- ----------------------------------------------------------------------------
-- A work-breakdown-structure table for a job: tasks, phases, milestones with
-- start/end dates, % complete, optional cost-code tie-in, and FS dependencies
-- stored as a uuid[] of predecessor ids. Powers the hand-rolled editable drag
-- Gantt (src/components/GanttChart.tsx) + the CPM critical-path calc
-- (src/lib/criticalPath.ts).
--
-- Run ONCE in the Supabase SQL Editor — paste from Notepad, NOT the terminal
-- (the Editor mangles pasted single quotes into double quotes); single-quoted
-- literals only.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE —
-- passes scripts/check-migrations.mjs). drop policy/trigger/index if exists +
-- create table if not exists / add column if not exists are safe and used below.
--
-- Run BEFORE deploying the app code that queries job_tasks (the Gantt UI would
-- get PostgREST errors if the table did not exist yet). Until then the app
-- degrades gracefully (supabase-js returns {error} not throw -> [] / null).
--
-- Reuses the SECURITY DEFINER helpers from multi_tenancy_a.sql / _b.sql:
--   tier_office_or_pm(org_id)   -- office/admin/PM/super_admin AND same_org
--   tier_management(org_id)     -- management/super_admin AND same_org
--   same_org(uid, org_id)       -- uid is in that org (or super_admin)
--   set_org_from_job()          -- BEFORE INSERT trigger: stamps org from job
--
-- RLS is the four-tier pattern from schedule_events (calendar.sql): office/PM
-- manage (for all), management read, assigned-crew read, owning-customer read.
-- job_tasks policies join `jobs` (not other job_tasks) -> no RLS recursion.
-- ============================================================================
begin;

-- ════════════════════════════════════════════════════════════════════════════
-- job_tasks — per-job WBS rows (task / phase / milestone).
--   kind='task'      -> a scheduled bar with start_date + end_date (>= start).
--   kind='phase'     -> a summary bar (start/end); rollup of children is a v1
--                       follow-up (v1 = styled bar only).
--   kind='milestone' -> a point in time; end_date is NULL, the diamond sits on
--                       start_date.
--   predecessor_ids  -> uuid[] of FS predecessors (app validates existence +
--                       acyclicity; no FK on the array -> can't FK uuid[]).
--   dependency_type  -> stored FS/SS/FF/SF for future; v1 calc treats all as FS.
--   baseline_start/end -> reserved for a planned-vs-actual snapshot (v1 UI does
--                       not populate; columns exist so a later feature needs no
--                       migration).
--   No DB CHECK on `kind`/`dependency_type` (repo convention: app validates
--   enums, avoids CHECK whitelists so adding a value needs no migration).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.job_tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  title           text not null,
  kind            text not null default 'task',
  cost_code_id    uuid references public.cost_codes(id) on delete set null,
  start_date      date not null,
  end_date        date,
  position        integer not null default 0,
  percent_complete integer not null default 0 check (percent_complete between 0 and 100),
  predecessor_ids uuid[] not null default '{}',
  dependency_type text default 'FS',
  assigned_to     uuid references public.profiles(id) on delete set null,
  baseline_start  date,
  baseline_end    date,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- milestone = point in time (no end_date); task/phase require an end_date.
  check (kind = 'milestone' or end_date is not null),
  check (kind <> 'milestone' or end_date is null),
  -- task/phase: end must not precede start.
  check (kind = 'milestone' or end_date >= start_date)
);

create index if not exists idx_job_tasks_job
  on public.job_tasks(job_id);
create index if not exists idx_job_tasks_org_position
  on public.job_tasks(organization_id, job_id, position);

alter table public.job_tasks enable row level security;

-- Stamp organization_id from the parent job (same trigger fn every other
-- job-child table uses). RAISES if the job is missing, so a bad job_id can't
-- produce a row with a null org.
drop trigger if exists trg_job_tasks_org on public.job_tasks;
create trigger trg_job_tasks_org before insert on public.job_tasks
  for each row execute function public.set_org_from_job();

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — mirror the schedule_events pattern (calendar.sql):
--   office/admin/PM manage (insert/update/delete + read),
--   all management read,
--   assigned crew read,
--   owning customer read.
-- Drag edits are office/PM only by construction (no insert/update/delete
-- policy for crew/management/customer -> their writes no-op; the UI hides
-- drag handles for non-Office/PM).
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists "Office manage job tasks" on public.job_tasks;
create policy "Office manage job tasks" on public.job_tasks
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read job tasks" on public.job_tasks;
create policy "Management read job tasks" on public.job_tasks
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned job tasks" on public.job_tasks;
create policy "Crew read assigned job tasks" on public.job_tasks
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = job_tasks.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own job tasks" on public.job_tasks;
create policy "Customer read own job tasks" on public.job_tasks
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = job_tasks.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- Verification (run manually in SQL Editor after this file succeeds)
-- ════════════════════════════════════════════════════════════════════════════
-- select count(*) from public.job_tasks;   -- 0 ok

notify pgrst, 'reload schema';

commit;