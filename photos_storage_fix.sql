-- Fix: crew could not view private-bucket objects (job-photos, receipts, blueprints)
-- via signed URLs even when assigned to the job. Office viewing worked (the
-- is_office() branch), but the crew "exists (...)" branch silently never matched,
-- so createSignedUrl/list/download returned "Object not found" / EMPTY for crew.
--
-- Root cause: the inline `exists (select 1 from jobs where id::text = split_part(name,'/',1)
-- and auth.uid() = any(assigned_crew))` clause does not evaluate reliably INSIDE a
-- storage.objects RLS policy (the nested jobs subquery + auth.uid() don't resolve
-- the way they do in TABLE policies, where the identical pattern works fine).
-- Fix: move the assignment/ownership check into SECURITY DEFINER helper functions
-- (they run as the owner, bypass RLS on jobs, and resolve auth.uid() in their own
-- context) and have the storage SELECT policies call them. This restores signed-URL
-- viewing for assigned crew across ALL THREE private buckets — and fixes the same
-- latent bug in receipts + blueprints that had never been click-through verified.
--
-- Idempotent (drop-if-exists + create-or-replace). INSERT/UPDATE/DELETE storage
-- policies and the photos TABLE policies are untouched.

-- 1. Helper: is the caller an assigned crew member on the job whose id begins the
--    storage object path (the "<jobId>/<file>" folder convention used everywhere)?
create or replace function public.storage_caller_assigned_to_job(p_name text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jobs
    where id::text = split_part(p_name, '/', 1)
      and auth.uid() = any(assigned_crew)
  );
$$;

-- 2. Helper: is the caller the owning customer of the job whose id begins the path?
create or replace function public.storage_caller_owns_job(p_name text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jobs
    where id::text = split_part(p_name, '/', 1)
      and customer_id in (select customer_id from public.profiles where id = auth.uid())
  );
$$;

-- 3. job-photos: replace the broken inline crew/customer branches with the helpers.
--    (Bucket was already made private + RLS-enabled on photos table by photos_private.sql.)
drop policy if exists "Authenticated read job-photos" on storage.objects;
create policy "Authenticated read job-photos" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'job-photos'
    and (
      public.is_office(auth.uid())
      or public.storage_caller_assigned_to_job(name)
      or public.storage_caller_owns_job(name)
    )
  );

-- 4. receipts: crew viewing was likewise broken (only office "for all" policy worked).
--    Customers don't view receipts, so no customer branch here.
drop policy if exists "Crew read receipts storage" on storage.objects;
create policy "Crew read receipts storage" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'receipts'
    and (
      public.is_office(auth.uid())
      or public.storage_caller_assigned_to_job(name)
    )
  );

-- 5. blueprints: same fix (office/crew/customer all use the helpers now).
drop policy if exists "Authenticated read blueprints" on storage.objects;
create policy "Authenticated read blueprints" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'blueprints'
    and (
      public.is_office(auth.uid())
      or public.storage_caller_assigned_to_job(name)
      or public.storage_caller_owns_job(name)
    )
  );