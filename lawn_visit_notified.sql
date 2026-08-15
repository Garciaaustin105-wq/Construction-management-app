-- Lawn visit "notified" tracking.
-- Goal: add a notified_at timestamp on lawn_visits so the visit-status API
-- route can email the customer a one-shot notice when a visit becomes done /
-- skipped or is moved, and avoid re-emailing on subsequent actions. This is
-- additive only — no CHECK, no RPC, no DROP TABLE/COLUMN.
--
-- Run in Supabase SQL Editor (paste via Notepad). Idempotent — safe to run
-- before OR after deploy; re-running is a no-op. Run order: after the lawn
-- maintenance + jobs_type schema is in place (those already shipped). No
-- dependency on any other pending migration.

alter table public.lawn_visits
  add column if not exists notified_at timestamptz;

-- Partial index so the "has this visit been notified?" gate is cheap.
create index if not exists idx_lawn_visits_notified
  on public.lawn_visits(notified_at)
  where notified_at is not null;