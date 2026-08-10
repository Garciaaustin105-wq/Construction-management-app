drop policy if exists "Crew upload photos" on storage.objects;

create policy "Crew upload photos" on storage.objects for insert with check (
  bucket_id = 'job-photos'
  and exists (
    select 1 from profiles
    where id = auth.uid() and role = 'crew'
  )
);
