-- Lawn estimate → separately-scheduled jobs (Track 3 of 4).
-- Lets a lawn estimate's line items each carry recurrence metadata so that, on
-- approval, the office can spawn one recurring_schedules row per schedulable
-- line onto the (existing or new) lawn job — no re-keying each service by hand.
--
-- No new table. Adds nullable scheduling columns to estimate_line_items (lawn
-- semantics; null on construction = "not scheduled") + a conversion stamp on
-- estimates. Idempotent (add column if not exists). No new RLS — the new
-- estimate_line_items columns ride the existing office_estimate_items_all /
-- crew_estimate_items_select / customer_estimate_items_select policies, and
-- estimates.converted_at rides office_estimates_all. No CHECK on
-- schedule_frequency (repo convention: no frequency whitelists, see
-- jobs_type.sql) so adding a frequency never needs a migration.
--
-- RUN LIVE via the Supabase SQL Editor (paste the whole file). Safe to re-run.

-- Per-line recurrence metadata (lawn only; construction leaves these null).
alter table public.estimate_line_items
  add column if not exists schedule_frequency text;        -- null | 'weekly' | 'biweekly' | 'monthly' | 'one-time'
alter table public.estimate_line_items
  add column if not exists schedule_interval_weeks int not null default 1;  -- 1=weekly, 2=biweekly, 4=monthly
alter table public.estimate_line_items
  add column if not exists schedule_days_of_week int[] not null default '{}';  -- 0=Sun..6=Sat, weekly/biweekly
alter table public.estimate_line_items
  add column if not exists schedule_day_of_month int;      -- 1..28, monthly
alter table public.estimate_line_items
  add column if not exists schedule_start_date date;       -- season start (recurring) or service date (one-time)
alter table public.estimate_line_items
  add column if not exists schedule_end_date date;         -- null = open-ended season

-- Stamped by the convert route when a line item becomes a recurring_schedules
-- row. on delete set null so deleting the schedule (rare) doesn't strand the
-- line item; the line keeps its cadence metadata either way.
alter table public.estimate_line_items
  add column if not exists recurring_schedule_id uuid
  references public.recurring_schedules(id) on delete set null;

-- Conversion stamp on the estimate. status already has 'converted' in its
-- CHECK (estimates.sql); converted_at records when the office spawned schedules.
alter table public.estimates
  add column if not exists converted_at timestamptz;

-- Helpful: index pending-conversion estimates by org (office "ready to
-- schedule" view). Cheap + only on approved rows.
create index if not exists idx_estimates_org_approved
  on public.estimates (organization_id, created_at desc)
  where status = 'approved';