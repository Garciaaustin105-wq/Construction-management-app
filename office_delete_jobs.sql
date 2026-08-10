-- Office-only DELETE on jobs and related tables.
-- Crew cannot delete projects, photos, RFIs, blueprints, or job views.

drop policy if exists "Office delete jobs" on jobs;
create policy "office_delete_jobs" on jobs for delete to authenticated using (exists (select 1 from profiles where id = auth.uid() and role = 'office'));

drop policy if exists "Office delete photos" on photos;
create policy "office_delete_photos" on photos for delete to authenticated using (exists (select 1 from profiles where id = auth.uid() and role = 'office'));

drop policy if exists "Office delete rfis" on rfis;
create policy "office_delete_rfis" on rfis for delete to authenticated using (exists (select 1 from profiles where id = auth.uid() and role = 'office'));

drop policy if exists "Office delete blueprints db" on blueprints;
create policy "office_delete_blueprints_db" on blueprints for delete to authenticated using (exists (select 1 from profiles where id = auth.uid() and role = 'office'));

drop policy if exists "Office delete job views" on job_views;
create policy "office_delete_job_views" on job_views for delete to authenticated using (exists (select 1 from profiles where id = auth.uid() and role = 'office'));

drop policy if exists "Office delete job photos" on storage.objects;
create policy "office_delete_job_photos" on storage.objects for delete to authenticated using (bucket_id = 'job-photos' and exists (select 1 from profiles where id = auth.uid() and role = 'office'));
