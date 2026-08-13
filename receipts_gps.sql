-- receipts_gps.sql — GPS location at receipt capture time
-- ----------------------------------------------------------------------------
-- Mirrors the photos / time_entries GPS pattern (photos_gps.sql +
-- location_source.sql) so a captured receipt can record WHERE it was taken,
-- which the office Receipts report surfaces as the "Location" column.
--
--   lat / lng           capture coordinates (null until a fix is obtained)
--   location_source     'gps' = device GPS  |  'ip' = approximate IP geolocation
--   location_accuracy   GPS accuracy radius in meters (null for IP estimates)
--
-- All nullable, so existing receipts are unaffected (they show "—" in the
-- report until a new capture populates them). No RLS changes needed —
-- Postgres RLS policies are row-level, not column-level, so the existing
-- receipts insert/update policies automatically cover the new columns.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE)
-- so it passes scripts/check-migrations.mjs and is safe to re-run.
--
-- Run order: run THIS file in the Supabase SQL Editor BEFORE deploying the app
-- code that inserts/reads the new columns (the share route + receipts report
-- would get PostgREST errors if the columns did not exist yet).
-- ----------------------------------------------------------------------------

begin;

alter table public.receipts
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists location_source text,
  add column if not exists location_accuracy numeric(8,2);

commit;

-- ── Verification (run manually in SQL Editor after this file succeeds) ───────
-- select lat, lng, location_source, location_accuracy
--   from public.receipts limit 1;   -- null ok, no error