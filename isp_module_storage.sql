-- isp_module_storage.sql
-- ----------------------------------------------------------------------------
-- ISP / fiber module — storage policies for install photos.
--
-- ⚠️ RUN isp_module.sql AND isp_module_b.sql FIRST. Guarded below.
--
-- WHY THIS FILE EXISTS (a trap isp_module_b.sql alone does NOT close):
-- isp_module_b.sql made the `photos` TABLE accept install photos. But the
-- actual image bytes live in the `job-photos` storage bucket, and that bucket's
-- RLS is keyed entirely off the OBJECT PATH:
--
--   storage_job_org(name)                 -> jobs where id::text = split_part(name,'/',1)
--   storage_caller_assigned_to_job(name)  -> same, plus auth.uid() = any(assigned_crew)
--
-- i.e. the FIRST path segment must be a job UUID. An install can have no job at
-- all, so an install photo has no valid job-shaped path — every upload would be
-- rejected by storage RLS even though the `photos` row insert succeeded. The
-- result would be orphan photo rows pointing at objects that were never stored.
--
-- PATH CONVENTION introduced here:   installs/<install_id>/<filename>
-- Segment 1 is the literal 'installs', segment 2 is the install id — deliberately
-- mirroring the existing lawn-visit policies, which already resolve their parent
-- from split_part(name,'/',2). It cannot collide with a job path, whose first
-- segment is a bare UUID.
--
-- The app MUST upload install photos to that exact shape. src/components/
-- InstallFieldActions.tsx builds it.
--
-- Existing job and lawn-visit photo policies are NOT touched. These are
-- additional policies; Postgres ORs permissive policies together, so job photos
-- keep working exactly as before.
--
-- Idempotent. Run in the Supabase SQL editor — paste from a text editor
-- (Notepad), NOT the web editor (it mangles single quotes).
-- ----------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.installs') is null then
    raise exception 'Run isp_module.sql first';
  end if;
  if to_regclass('public.install_time_entries') is null then
    raise exception 'Run isp_module_b.sql first';
  end if;
end $$;


-- ── Path helpers (mirror storage_job_org / storage_caller_assigned_to_job) ──
-- Both resolve the install from segment 2 of the object path.

create or replace function public.storage_install_org(p_name text)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select organization_id
  from public.installs
  where split_part(p_name, '/', 1) = 'installs'
    and id::text = split_part(p_name, '/', 2);
$$;

create or replace function public.storage_caller_assigned_to_install(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.installs i
    where split_part(p_name, '/', 1) = 'installs'
      and i.id::text = split_part(p_name, '/', 2)
      and auth.uid() = any (i.assigned_crew)
      and public.same_org(auth.uid(), i.organization_id)
  );
$$;

-- These are POLICY HELPERS — they are evaluated inside storage RLS at query
-- time, so `authenticated` MUST keep EXECUTE. Revoking it would break the
-- policies outright. Same reasoning harden_function_execute.sql documents for
-- tier_*/is_*/same_org/storage_*: only anon and PUBLIC lose direct-call rights.
revoke execute on function public.storage_install_org(text)                from public, anon;
revoke execute on function public.storage_caller_assigned_to_install(text) from public, anon;
grant  execute on function public.storage_install_org(text)                to authenticated;
grant  execute on function public.storage_caller_assigned_to_install(text) to authenticated;


-- ── Storage policies ───────────────────────────────────────────────────────
-- Crew upload to installs they're assigned to. Mirrors "Crew upload photos".
drop policy if exists "Crew upload install photos" on storage.objects;
create policy "Crew upload install photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and public.storage_caller_assigned_to_install(name)
  );

-- Office/admin/super_admin (same org) upload. Mirrors "Office upload photos".
drop policy if exists "Office upload install photos" on storage.objects;
create policy "Office upload install photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and public.tier_office(public.storage_install_org(name))
  );

-- Read: office in the install's org, or assigned crew. Mirrors
-- "Authenticated read job-photos". Customers are intentionally NOT included —
-- install photos are internal for now, matching the photos-table policy note in
-- isp_module_b.sql. Add a customer branch here AND a photos-row policy together
-- if that ever changes; adding only one of the two produces a half-broken view.
drop policy if exists "Read install photos" on storage.objects;
create policy "Read install photos" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'job-photos'
    and (
      public.tier_office(public.storage_install_org(name))
      or public.storage_caller_assigned_to_install(name)
    )
  );

-- Delete: office only, same as office_delete_job_photos. Crew cannot delete
-- what they uploaded — consistent with the field record being append-only.
drop policy if exists "Office delete install photos" on storage.objects;
create policy "Office delete install photos" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'job-photos'
    and public.tier_office(public.storage_install_org(name))
  );


-- ----------------------------------------------------------------------------
-- VERIFY (expect 4 rows):
--   select policyname, cmd from pg_policies
--   where schemaname='storage' and tablename='objects'
--     and policyname ilike '%install photos%'
--   order by cmd, policyname;
--
-- Sanity-check the helpers resolve a real install (replace the id):
--   select public.storage_install_org('installs/<install-uuid>/x.jpg');
--   -- expect that install's organization_id, not null
--   select public.storage_install_org('not-an-install-path.jpg');
--   -- expect null
-- ----------------------------------------------------------------------------
