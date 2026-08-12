-- Photos: GPS location at capture time.
-- Run in the Supabase dashboard SQL Editor.
-- Adds optional lat/lng to photos so the lightbox can show "view on map".
-- Optional columns; existing + new photos without a fix simply stay null.

alter table public.photos
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Helpful for office filtering "where was this taken" later.
create index if not exists photos_job_id_created_at_idx
  on public.photos (job_id, created_at desc);