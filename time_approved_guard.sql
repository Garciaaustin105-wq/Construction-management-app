-- §3.2 Guard approved time entries (feature-completeness audit 2026-08-26)
--
-- Crew must not be able to edit or delete a time entry once it has been
-- approved. `approved_at` / `approved_by` otherwise remain stamped on
-- numbers the crew can still mutate, so the approval attests to values
-- that may no longer be the values.
--
-- Office (office time_all) and field-mgmt review policies are intentionally
-- untouched — management can still correct an approved row. Only the two
-- crew self-service policies are tightened.
--
-- `status is distinct from 'approved'` is null-safe: blocks approved rows
-- only, lets pending / rejected / null through. WITH CHECK also carries the
-- guard so a crew member cannot self-approve by setting status='approved'
-- through a direct API write.

drop policy if exists "crew time_update_own" on time_entries;
drop policy if exists "crew time_delete_own" on time_entries;

create policy "crew time_update_own" on time_entries
  for update to authenticated
  using (
    same_org((select auth.uid()), organization_id)
    and user_id = (select auth.uid())
    and status is distinct from 'approved'
  )
  with check (
    same_org((select auth.uid()), organization_id)
    and user_id = (select auth.uid())
    and status is distinct from 'approved'
  );

create policy "crew time_delete_own" on time_entries
  for delete to authenticated
  using (
    same_org((select auth.uid()), organization_id)
    and user_id = (select auth.uid())
    and status is distinct from 'approved'
  );