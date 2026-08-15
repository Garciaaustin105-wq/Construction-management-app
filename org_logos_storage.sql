-- ============================================================================
-- org_logos_storage.sql  (idempotent / additive — safe to re-run)
-- ----------------------------------------------------------------------------
-- White-label logo storage. A PUBLIC bucket so the org logo renders on
-- unauthenticated customer-facing documents (the /q/{token} estimate portal)
-- and in app chrome without minting signed URLs that would expire.
--
-- Path convention: <organization_id>/logo-<uuid>.<ext>
--   • Org admin (role office/admin) may write ONLY inside their own org's
--     folder (name like '<my_org_id>/%').
--   • super_admin may write anywhere in the bucket (they can edit any org).
--   • Reads are public (the bucket is public; getPublicUrl needs no policy).
--
-- No table changes — organizations.logo_path text already exists
-- (multi_tenancy_a.sql line 31). This file only creates the bucket + storage
-- RLS. Run in Supabase SQL Editor (Notepad paste).
-- ============================================================================

-- 1. Public bucket -----------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('org-logos', 'org-logos', true)
on conflict (id) do update set public = true;

-- 2. Write policies (insert / update / delete) -------------------------------
-- A helper-free prefix check: the object name must start with the caller's own
-- org id followed by '/'. UUIDs contain no LIKE wildcards, so `like` is safe.
-- super_admin (no org_id) bypasses the prefix check and may write any path.

drop policy if exists "Org logo insert" on storage.objects;
create policy "Org logo insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'org-logos'
    and (
      public.is_super_admin(auth.uid())
      or (
        public.is_office(auth.uid())
        and name like (public.my_org_id(auth.uid()) || '/%')
      )
    )
  );

drop policy if exists "Org logo update" on storage.objects;
create policy "Org logo update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'org-logos'
    and (
      public.is_super_admin(auth.uid())
      or (
        public.is_office(auth.uid())
        and name like (public.my_org_id(auth.uid()) || '/%')
      )
    )
  )
  with check (
    bucket_id = 'org-logos'
    and (
      public.is_super_admin(auth.uid())
      or (
        public.is_office(auth.uid())
        and name like (public.my_org_id(auth.uid()) || '/%')
      )
    )
  );

drop policy if exists "Org logo delete" on storage.objects;
create policy "Org logo delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'org-logos'
    and (
      public.is_super_admin(auth.uid())
      or (
        public.is_office(auth.uid())
        and name like (public.my_org_id(auth.uid()) || '/%')
      )
    )
  );

-- 3. Read policy -------------------------------------------------------------
-- The bucket is public, so getPublicUrl works for anyone with no policy. Add a
-- permissive authenticated SELECT too so the JS client can also read via the
-- API if needed (harmless; the public URL path is the primary render path).
drop policy if exists "Org logo read" on storage.objects;
create policy "Org logo read" on storage.objects
  for select to authenticated
  using (bucket_id = 'org-logos');