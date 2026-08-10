-- Restrict jobs update to office only. Crew must not be able to change
-- job status (or any other job fields).
drop policy if exists "Crew update assigned job status" on jobs;

create policy "Office update jobs"
on jobs for update
to authenticated
using (
  exists (select 1 from profiles where id = auth.uid() and role = 'office')
)
with check (
  exists (select 1 from profiles where id = auth.uid() and role = 'office')
);