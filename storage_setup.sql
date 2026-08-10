-- Storage bucket for job photos
insert into storage.buckets (id, name, public)
values ('job-photos', 'job-photos', true)
on conflict (id) do nothing;

-- Allow crew to upload to their assigned job folders
create policy "Crew upload photos" on storage.objects for insert with check (
  bucket_id = 'job-photos'
  and exists (
    select 1 from jobs
    where id::text = split_part(name, '/', 1)
    and auth.uid() = any(assigned_crew)
  )
);

-- Allow anyone to read photos (they're public so customer portal can show them)
create policy "Public read photos" on storage.objects for select using (
  bucket_id = 'job-photos'
);
