-- Customers — service_plan field.
-- A free-text plan the office records against a customer (e.g. "1G fiber /
-- 12mo") so it's visible when scheduling an install without retyping it, and
-- so the install create form can surface it as a reference for the caller.
--
-- Run in Supabase SQL Editor. Idempotent (add column if not exists).
-- No RLS change: customers are already org-scoped and office-managed.
--
-- Verify live after running:
--   select column_name from information_schema.columns
--   where table_name='customers' and column_name='service_plan';  -- expect 1 row

alter table customers add column if not exists service_plan text;