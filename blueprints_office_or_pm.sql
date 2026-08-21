-- blueprints_office_or_pm.sql
-- ----------------------------------------------------------------------------
-- Companion to the BlueprintsSection.tsx UI fix (widened to admit PM,
-- matching the api/jobs/[jobId]/view/route.ts fix). The UI now renders the
-- upload form + delete button for OFFICE_OR_PM (office/admin/project_manager/
-- super_admin), but the underlying RLS was left at the narrower tier_office
-- (office/admin/super_admin — no PM) — confirmed live via pg_policies:
--   public.blueprints    "Office blueprints all"     (ALL)    tier_office(organization_id)
--   storage.objects      "Office upload blueprints"  (INSERT) tier_office(storage_job_org(name))
--   storage.objects      "Office delete blueprints"  (DELETE) tier_office(storage_job_org(name))
-- Without this migration, a PM sees the now-visible upload/delete controls
-- but gets a silent RLS-denied error on click — worse than the button not
-- rendering at all. This file switches those three policies to
-- tier_office_or_pm(...), which is exactly OFFICE_OR_PM at the DB layer
-- (is_office_or_pm(uid) OR is_super_admin(uid)) AND same_org — matching what
-- PM already has on jobs (multi_tenancy_b.sql "Office update jobs") and
-- invoices/payments (payments.sql).
--
-- NOT auto-applied. Review before running in the Supabase SQL editor.
-- Idempotent (drop-if-exists + create).
-- ----------------------------------------------------------------------------

drop policy if exists "Office blueprints all" on public.blueprints;
create policy "Office blueprints all" on public.blueprints for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Office upload blueprints" on storage.objects;
create policy "Office upload blueprints" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'blueprints'
    and public.tier_office_or_pm(public.storage_job_org(name))
  );

drop policy if exists "Office delete blueprints" on storage.objects;
create policy "Office delete blueprints" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'blueprints'
    and public.tier_office_or_pm(public.storage_job_org(name))
  );

-- ----------------------------------------------------------------------------
-- Verify:
--   select tablename, policyname, cmd, qual, with_check
--   from pg_policies
--   where (schemaname='public' and tablename='blueprints')
--      or (schemaname='storage' and tablename='objects' and policyname like 'Office%blueprints%');
-- Expect all three qual/with_check strings to reference tier_office_or_pm,
-- not tier_office.
-- ----------------------------------------------------------------------------
