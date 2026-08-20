-- lawn_seasonal_window.sql
-- Persist the seasonal pause window on recurring_schedules so the UI can show
-- "Paused through <date>" and the nightly generate cron can AUTO-RESUME on the
-- scheduled date (set-and-forget seasonal scheduling). Additive + idempotent.
--
-- Columns:
--   paused_from  date  -- start of the off-season (mirrors bulk-pause pause_from)
--   paused_until date  -- the resume date; null = no auto-resume (manual hold)
--
-- The existing `active` flag stays the pause signal; these columns record the
-- *intended window*. bulk-pause sets them; bulk-resume + the cron auto-resume
-- clear them. No RLS change (columns ride existing recurring_schedules
-- policies). No data backfill needed (null = no window, the pre-feature state).
--
-- Run via Supabase SQL Editor, pasted from a TEXT EDITOR (the web editor
-- mangles single quotes into double quotes). Idempotent — safe to re-run.
-- Passes the migration guard (additive only, no destructive ops).

alter table public.recurring_schedules
  add column if not exists paused_from date;

alter table public.recurring_schedules
  add column if not exists paused_until date;