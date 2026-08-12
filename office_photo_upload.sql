-- Fix: office users could not upload job photos.
-- The only INSERT policy on the `job-photos` storage bucket was
-- "Crew upload photos" (role = 'crew'), so an office user uploading
-- from /crew/photo got: "new row violates row-level security policy".
-- This adds the matching office INSERT policy. Crew policy is untouched.

create policy "Office upload photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and exists (
      select 1 from profiles
      where id = auth.uid() and role = 'office'
    )
  );