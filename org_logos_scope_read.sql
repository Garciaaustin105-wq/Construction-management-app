-- org_logos_scope_read.sql  (idempotent — safe to re-run)
-- ----------------------------------------------------------------------------
-- WHY: the `org-logos` bucket is PUBLIC, and its SELECT policy on
-- storage.objects was unscoped:
--
--     "Org logo read"  SELECT  to authenticated  USING (bucket_id = 'org-logos')
--
-- Any signed-in user of ANY org could therefore LIST every object in the
-- bucket. Object paths are `{organization_id}/...`, so listing enumerates every
-- tenant's organization UUID — a slow but real cross-tenant enumeration vector.
-- Flagged by the Supabase linter as `public_bucket_allows_listing`.
--
-- The sibling INSERT / UPDATE / DELETE policies are already correctly scoped:
--     is_super_admin(auth.uid())
--     OR (is_office(auth.uid()) AND name LIKE my_org_id(auth.uid()) || '/%')
-- Only SELECT was left wide open. This aligns it with the other three.
--
-- SAFE FOR LOGO DISPLAY. Every read path in the app is getPublicUrl() —
-- verified across all 6 call sites (useOrgBranding.ts, OrgSettingsForm.tsx,
-- estimates/[id], customer/estimates/[id]/sign, invoices/view/[token],
-- q/[token]). getPublicUrl() is a pure client-side string builder: it makes no
-- API call, and the resulting /storage/v1/object/public/... fetch does NOT
-- consult storage.objects RLS for a public bucket. Nothing in the codebase
-- calls .list() or .download() on this bucket, so no feature depends on the
-- broad SELECT.
--
-- Scoped rather than dropped outright: an office user listing their OWN org's
-- logos is legitimate and not a leak, and keeping a SELECT policy avoids
-- surprising any Supabase client operation that expects to resolve an object
-- inside the caller's own org. Cross-tenant listing is what gets closed.
-- ----------------------------------------------------------------------------

begin;

drop policy if exists "Org logo read" on storage.objects;

create policy "Org logo read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'org-logos'
    and (
      is_super_admin(auth.uid())
      or name like (my_org_id(auth.uid()) || '/%')
    )
  );

commit;

-- Verification — expect the USING clause to include my_org_id, not just bucket_id:
--
-- select policyname, cmd, qual
--   from pg_policies
--  where schemaname='storage' and tablename='objects' and policyname = 'Org logo read';
