-- Lawn Phase 2: route optimization + zone grouping — persistence column.
--
-- Adds lawn_visits.route_order so the office route planner
-- (/lawn/routes) can save an optimized stop sequence for a given day. My Route
-- (/lawn/my-route) then sorts a crew's own visits by route_order (nulls last)
-- within each day section so the dispatcher's optimized order reaches the
-- crew. Crew can also reorder their own day (harmless — display only); the
-- office re-optimizes + re-saves as needed.
--
-- Additive + idempotent. No CHECK, no RPC, no RLS/trigger change (the office
-- update policy is column-agnostic, so office can set route_order; the crew
-- guard trigger's blocklist does not include route_order, so crew updates to
-- it pass — acceptable since it only reorders a crew's own My Route list).
--
-- Run order: this is the LAST of the five lawn pre-deploy SQL files
--   (jobs_type.sql → lawn_visit_notified.sql → lawn_crew_route.sql →
--    lawn_cycle_billing.sql → lawn_route_order.sql).
-- Paste via Notepad (the Supabase SQL Editor mangles pasted single quotes).

alter table public.lawn_visits
  add column if not exists route_order int;

-- Helps My Route + the planner fetch a crew's/day's ordered visits cheaply.
create index if not exists idx_lawn_visits_route_order
  on public.lawn_visits (due_date, crew_id, route_order);

-- Smoke test:
--   select column_name from information_schema.columns
--   where table_name='lawn_visits' and column_name='route_order';