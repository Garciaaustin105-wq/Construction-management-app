-- Belt-and-suspenders: explicit INSERT policies on the `photos` table.
-- The SQL files only defined select/delete/update on `photos`; no INSERT
-- policy was captured in the repo. Storage upload (job-photos bucket) now
-- works for office + crew, but if the table ever lacked a matching insert
-- policy, a successful storage upload would be followed by
-- "Save failed: new row violates row-level security policy".
-- These policies mirror the storage INSERT policies so the two layers
-- always agree on who can add a photo row.
--
-- Crew insert matches "Crew upload photos" on storage.objects (role-based,
-- not assignment-gated). Office insert matches "Office upload photos".

drop policy if exists "Crew insert photos" on photos;
drop policy if exists "Office insert photos" on photos;

create policy "Crew insert photos" on photos for insert
  to authenticated
  with check (
    exists (select 1 from profiles where id = auth.uid() and role = 'crew')
  );

create policy "Office insert photos" on photos for insert
  to authenticated
  with check (
    exists (select 1 from profiles where id = auth.uid() and role = 'office')
  );