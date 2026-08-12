-- Records HOW a captured location was obtained, so the office can tell a
-- precise GPS pin from an approximate network/IP estimate (used when GPS was
-- denied). Also stores GPS accuracy in meters when available.
--
--   location_source    'gps' = device GPS  |  'ip' = approximate IP geolocation
--   location_accuracy  GPS accuracy radius in meters (null for IP estimates)
--
-- Both nullable, so existing rows are unaffected. No RLS changes needed —
-- Postgres RLS policies are row-level, not column-level, so existing insert/
-- update policies automatically cover the new columns.
--
-- Idempotent: safe to re-run.

alter table public.photos
  add column if not exists location_source text,
  add column if not exists location_accuracy numeric(8,2);

alter table public.time_entries
  add column if not exists location_source text,
  add column if not exists location_accuracy numeric(8,2);