-- H-2 fix: crew photo uploads must be gated to jobs the crew is assigned to.
-- The prior "Crew upload photos" / "Crew insert photos" policies only checked
-- role = 'crew', so any crew member could upload to ANY job (cross-tenant).
-- This restores assignment-gating, matching the receipts pattern. Office
-- policies (office_photo_upload.sql / photo_insert_rls.sql) are untouched —
-- office is admin and may upload to any job.

-- 1. Storage bucket INSERT: crew may upload only into a job folder they're on.
drop policy if exists "Crew upload photos" on storage.objects;
create policy "Crew upload photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and exists (
      select 1 from jobs
      where id::text = split_part(name, '/', 1)
      and auth.uid() = any(assigned_crew)
    )
  );

-- 2. photos table INSERT: crew may insert a row only for an assigned job.
drop policy if exists "Crew insert photos" on photos;
create policy "Crew insert photos" on photos for insert
  to authenticated
  with check (
    exists (
      select 1 from jobs
      where id = job_id
      and auth.uid() = any(assigned_crew)
    )
  );