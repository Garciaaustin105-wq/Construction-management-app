-- lawn_time_model.sql — add a time model to the lawn side
-- ----------------------------------------------------------------------------
-- WHY: the lawn side captures WHEN a visit is due (lawn_visits.due_date, a
-- date) and THAT it finished (completed_at), but nothing about HOW LONG a visit
-- takes or WHEN during the day it should happen. Three concrete consequences
-- (from the GorillaDesk competitive review, 2026-08-23):
--
--   1. Route optimization is solving the wrong problem. /api/lawn/route-optimize
--      accepts only {lat,lng} and returns a Google Distance Matrix duration
--      matrix — it minimises TRAVEL with zero per-stop service time, so it
--      cannot build a feasible day. It needs a service duration per stop.
--   2. No estimate-vs-actual. completed_at without started_at = no crew
--      productivity, no on-site time, no per-visit profitability.
--   3. No appointment windows. Reminders can only say "today", never "9-11am".
--
-- This migration adds only nullable, additive columns — nothing existing
-- breaks, due_date keeps its current meaning, and every existing RLS policy on
-- these tables continues to cover the new columns (a new column inherits its
-- table's existing FOR ALL / FOR SELECT policies; no policy redefinition needed
-- — the same way later migrations already added notified_at, invoice_id,
-- route_order, share_token, notified_skipped_at, skip_reason to lawn_visits
-- without touching RLS).
--
-- NAMING PRECEDENT: the ISP installs module already solved this shape in prod —
-- installs.duration_minutes (int) and installs.started_at (timestamptz). This
-- migration mirrors those column names/types so the two sides read the same.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE) so
-- it passes scripts/check-migrations.mjs and is safe to re-run.
--
-- Run order: run THIS file in the Supabase SQL Editor BEFORE deploying app code
-- that reads/writes the new columns. The columns are nullable, so the live app
-- keeps working with NULLs until the UI in Slice 1 Step 2 starts populating them.
-- ----------------------------------------------------------------------------
-- Ownership: Claude-direct drafted + owns this file (SQL sign-off required
-- before it is run — project absolute rule). Slice 1 Step 2 (UI capture) and
-- Step 3 (route-optimize + reminder + insights consumers) are separate units.
-- ----------------------------------------------------------------------------

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. lawn_services.default_duration_minutes
--    Per-service default visit length (e.g. "Mow & edge" = 45 min). Nullable so
--    existing catalog rows are unaffected; the service manager UI populates it.
--    Falls through to recurring_schedules.estimated_duration_minutes when the
--    schedule overrides it, otherwise the visit inherits the service default.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.lawn_services
  add column if not exists default_duration_minutes int;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. recurring_schedules.estimated_duration_minutes
--    Optional per-schedule override of the service default. A biweekly mow on a
--    big lot can take longer than the catalog default; the schedule records it
--    so generated visits carry a duration without per-visit data entry.
--    Nullable = "use the service default".
-- ════════════════════════════════════════════════════════════════════════════

alter table public.recurring_schedules
  add column if not exists estimated_duration_minutes int;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. lawn_visits — started_at + appointment window
--    started_at: stamped by a "Start" action in the visit detail UI (Slice 1
--      Step 2). Paired with the existing completed_at, this gives on-site
--      duration = completed_at - started_at (crew productivity, estimate vs
--      actual). Stamping started_at does NOT change visit status — the
--      pending → [done, skipped] lifecycle in src/lib/lifecycles/lawn-visit.ts
--      is untouched (lower-risk than adding an in_progress status + editing
--      every lifecycle consumer).
--    scheduled_window_start / _end: optional time-of-day appointment window
--      ("between 9 and 11"). `time` type — a wall-clock time with no date/tz,
--      since the date is already due_date. NULL = "any time today" (the
--      current behaviour, so existing rows are unaffected). The reminder cron
--      and on-my-way ETA read these to say "between 9 and 11" / to judge early
--      or late instead of guessing.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.lawn_visits
  add column if not exists started_at timestamptz,
  add column if not exists scheduled_window_start time,
  add column if not exists scheduled_window_end   time;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Verification (run manually in the SQL Editor after this file succeeds)
-- ════════════════════════════════════════════════════════════════════════════
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('lawn_services','recurring_schedules','lawn_visits')
--    and column_name in ('default_duration_minutes','estimated_duration_minutes',
--                        'started_at','scheduled_window_start','scheduled_window_end')
--  order by table_name, column_name;
-- -- expect 5 rows:
-- --   lawn_services.default_duration_minutes  integer
-- --   lawn_visits.scheduled_window_end        time
-- --   lawn_visits.scheduled_window_start      time
-- --   lawn_visits.started_at                  timestamp with time zone
-- --   recurring_schedules.estimated_duration_minutes integer

commit;