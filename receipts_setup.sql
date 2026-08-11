-- Receipts: job-scoped expense receipts, date-stamped for tax evidence.
-- Run this in the Supabase dashboard SQL Editor (like phase2_final.sql).
-- Only receipts a user chooses to "share" get a row here; unshared receipts
-- live only on the capturing device (IndexedDB) to save cloud storage.

-- ============================================================================
-- 1. Table: public.receipts
-- ============================================================================
create table if not exists public.receipts (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  storage_path text not null,            -- path in the private "receipts" bucket
  vendor      text,                       -- optional, for tax records
  amount      numeric(10,2),              -- optional, for tax records
  notes       text,
  captured_at timestamptz not null,       -- the date stamped on the image (tax date)
  created_at  timestamptz not null default now()
);

create index if not exists receipts_job_id_idx on public.receipts(job_id);

alter table public.receipts enable row level security;

-- ============================================================================
-- 2. Row-level security
-- ============================================================================
drop policy if exists "office_receipts_all" on public.receipts;
create policy "office_receipts_all" on public.receipts
  for all to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

drop policy if exists "crew_receipts_select" on public.receipts;
create policy "crew_receipts_select" on public.receipts
  for select to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = receipts.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "crew_receipts_insert" on public.receipts;
create policy "crew_receipts_insert" on public.receipts
  for insert to authenticated
  with check (
    exists (
      select 1 from public.jobs j
      where j.id = receipts.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "crew_receipts_delete_own" on public.receipts;
create policy "crew_receipts_delete_own" on public.receipts
  for delete to authenticated
  using (uploaded_by = auth.uid());

-- ============================================================================
-- 3. Private storage bucket: receipts  (signed URLs only, unlike job-photos)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = false;

-- Office: full access to the bucket
drop policy if exists "Office all receipts storage" on storage.objects;
create policy "Office all receipts storage" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_office(auth.uid())
  )
  with check (
    bucket_id = 'receipts'
    and public.is_office(auth.uid())
  );

-- Crew: read receipts in folders for jobs they're assigned to
drop policy if exists "Crew read receipts storage" on storage.objects;
create policy "Crew read receipts storage" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and exists (
      select 1 from public.jobs
      where id::text = split_part(name, '/', 1)
        and auth.uid() = any(assigned_crew)
    )
  );

-- Crew: upload receipts to folders for jobs they're assigned to
drop policy if exists "Crew upload receipts storage" on storage.objects;
create policy "Crew upload receipts storage" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and exists (
      select 1 from public.jobs
      where id::text = split_part(name, '/', 1)
        and auth.uid() = any(assigned_crew)
    )
  );

-- Crew: delete receipt files in folders for jobs they're assigned to
drop policy if exists "Crew delete receipts storage" on storage.objects;
create policy "Crew delete receipts storage" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'receipts'
    and exists (
      select 1 from public.jobs
      where id::text = split_part(name, '/', 1)
        and auth.uid() = any(assigned_crew)
    )
  );