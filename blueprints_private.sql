-- H-1 fix: the blueprints bucket was PUBLIC, so floor plans / wiring diagrams
-- were world-readable by URL (no auth). Make it private and grant SELECT only
-- to office, assigned crew, and the owning customer — matching the receipts
-- model. Viewing is then done via signed URLs created client-side (createSignedUrl),
-- the same pattern ReceiptsSection already uses.

-- 1. Make the bucket private
update storage.buckets set public = false where id = 'blueprints';

-- 2. Replace the open "Public read blueprints" policy with an authenticated,
--    assignment/ownership-scoped read policy.
drop policy if exists "Public read blueprints" on storage.objects;
drop policy if exists "Authenticated read blueprints" on storage.objects;
create policy "Authenticated read blueprints" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'blueprints'
    and (
      public.is_office(auth.uid())
      or exists (
        select 1 from jobs
        where id::text = split_part(name, '/', 1)
        and auth.uid() = any(assigned_crew)
      )
      or exists (
        select 1 from jobs
        where id::text = split_part(name, '/', 1)
        and customer_id in (
          select customer_id from profiles where id = auth.uid()
        )
      )
    )
  );