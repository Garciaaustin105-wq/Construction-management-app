-- super_admin_readonly_orgs.sql
-- ----------------------------------------------------------------------------
-- Lock the `organizations` table so super_admin CANNOT mutate tenant identity
-- (name / address / phone / email / logo). super_admin is a platform-overview
-- role: it may READ every org (for /admin/dev analytics + /admin/orgs list),
-- but it must not be able to edit or create org business info.
--
-- Before this, the UPDATE policy had an explicit `is_super_admin(auth.uid())`
-- OR-branch, and `same_org()` short-circuits true for super_admin — so a
-- super_admin session could UPDATE ANY org row. Combined with /api/org PATCH
-- (also super_admin-allowed) + the /admin/org edit form, that let the platform
-- account rewrite every tenant's name/info. This closes the RLS half.
-- (The /api/org route + /admin/org page are gated admin-only in the app code.)
--
-- Effect:
--   org admin (role='admin', own org)  → UPDATE still allowed (own org only)
--   super_admin (role='super_admin')   → UPDATE denied (same_org=true, but
--                                         role<>'admin' → policy false)
--   everyone else                      → UPDATE denied (unchanged)
--
-- SELECT policy is unchanged (super_admin still reads all orgs via same_org).
-- No INSERT policy is added — orgs are still created service-role in /api/signup
-- only; super_admin cannot create orgs via the session client.
--
-- Run once in the Supabase SQL editor (dashboard or psql).
-- ----------------------------------------------------------------------------

drop policy if exists "Org admin update org" on public.organizations;

create policy "Org admin update org" on public.organizations for update
  to authenticated
  using (
    public.same_org(auth.uid(), id)
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    public.same_org(auth.uid(), id)
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ----------------------------------------------------------------------------
-- Verify: the UPDATE policy qualifier should NO LONGER contain is_super_admin.
--   select policyname, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename = 'organizations';
-- ----------------------------------------------------------------------------