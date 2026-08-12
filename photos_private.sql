-- M-4 fix: the job-photos bucket is PUBLIC, so every job photo is world-readable
-- by URL (no auth required) — anyone who guesses/leaks a path can view a customer's
-- property photos. Make the bucket private and grant SELECT only to office,
-- assigned crew, and the owning customer — matching the blueprints/receipts model.
-- Viewing is then done via signed URLs created client-side (createSignedUrl),
-- the same pattern BlueprintsSection / CustomerBlueprints / ReceiptsSection use.
--
-- ALSO enables RLS on the photos TABLE. It was previously disabled, so every
-- authenticated user could read ALL photo rows globally — a crew member saw photos
-- for jobs they aren't assigned to. With RLS enabled + scoped SELECT, crew only
-- see photos for jobs they're assigned to. This is a behavior tightening (more
-- restrictive) and the intended secure default; office still sees all via is_office().
--
-- Idempotent: safe to re-run. INSERT / UPDATE / DELETE policies on photos and
-- the storage INSERT/DELETE policies on job-photos are intentionally LEFT UNTOUCHED.

-- 1. Make the bucket private
update storage.buckets set public = false where id = 'job-photos';

-- 2. Replace the open "Public read photos" storage policy with an authenticated,
--    assignment/ownership-scoped read policy (mirrors blueprints_private.sql).
drop policy if exists "Public read photos" on storage.objects;
drop policy if exists "Authenticated read job-photos" on storage.objects;
create policy "Authenticated read job-photos" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'job-photos'
    and (
      public.is_office(auth.uid())
      or exists (
        select 1 from jobs
        where id::text = split_part(name, '/', 1)
        and auth.uid() = any(assigned_crew)
      )
      or exists (
        select 1 from jobs
        where id::text = split_part(name, '/', 1)
        and customer_id in (
          select customer_id from profiles where id = auth.uid()
        )
      )
    )
  );

-- 3. Enable RLS on the photos table (was disabled → everyone read all rows).
--    Enabling is a no-op if already enabled.
alter table public.photos enable row level security;

-- 4. Scoped SELECT policies on the photos table. Drop existing first so this
--    re-runs cleanly. The customer policy is recreated (it existed already from
--    customer_rls.sql) so the scoped set is complete and owned by this file.
drop policy if exists "Office photos select" on photos;
drop policy if exists "Crew photos assigned" on photos;
drop policy if exists "Customer see own photos" on photos;

create policy "Office photos select" on photos for select
  to authenticated
  using (public.is_office(auth.uid()));

create policy "Crew photos assigned" on photos for select
  to authenticated
  using (
    exists (
      select 1 from jobs
      where id = job_id
      and auth.uid() = any(assigned_crew)
    )
  );

create policy "Customer see own photos" on photos for select
  to authenticated
  using (
    job_id in (
      select id from jobs where customer_id in (
        select customer_id from profiles where id = auth.uid()
      )
    )
  );