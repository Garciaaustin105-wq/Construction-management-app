-- Subcontractor management + tabbed customer file + management roles.
-- Idempotent. Run via Supabase SQL Editor (paste from Notepad, not the terminal).
--
-- Access model:
--   READ (subcontractors / customers / attachments / job_subcontractors / files):
--       office + superintendent + project_manager  ("management")
--   WRITE (add/edit/delete subs + customers + attach + upload files):
--       office only
--   crew + customer: NO access to subcontractor or customer info.

-- ── management helper ─────────────────────────────────────────────────────
-- Trusted supervisory/management roles that may VIEW subcontractor + customer
-- info (office, superintendent, project manager). Office alone may edit.
create or replace function public.is_management(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = uid and role in ('office', 'superintendent', 'project_manager')
  );
$$;

-- ── customers: extra columns for the complete customer file ───────────────
alter table public.customers add column if not exists phone text;
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists notes text;

alter table public.customers enable row level security;

-- Office: full CRUD.
drop policy if exists "Office all customers" on public.customers;
create policy "Office all customers" on public.customers for all
  to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

-- Superintendent + project manager: read-only.
drop policy if exists "Management read customers" on public.customers;
create policy "Management read customers" on public.customers for select
  to authenticated
  using (public.is_management(auth.uid()) and not public.is_office(auth.uid()));

-- (Customer-self SELECT already exists from customer_rls.sql.)

-- ── subcontractors ────────────────────────────────────────────────────────
create table if not exists public.subcontractors (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  contact_name text,
  trade        text,
  phone        text,
  email        text,
  notes        text,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.subcontractors enable row level security;

drop policy if exists "Office all subcontractors" on public.subcontractors;
create policy "Office all subcontractors" on public.subcontractors for all
  to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

drop policy if exists "Management read subcontractors" on public.subcontractors;
create policy "Management read subcontractors" on public.subcontractors for select
  to authenticated
  using (public.is_management(auth.uid()) and not public.is_office(auth.uid()));

-- ── job_subcontractors (attach a sub to a job, optional role on that job) ─
create table if not exists public.job_subcontractors (
  job_id          uuid not null references public.jobs(id) on delete cascade,
  subcontractor_id uuid not null references public.subcontractors(id) on delete cascade,
  role_on_job     text,
  created_at      timestamptz not null default now(),
  primary key (job_id, subcontractor_id)
);
alter table public.job_subcontractors enable row level security;

drop policy if exists "Office all job_subcontractors" on public.job_subcontractors;
create policy "Office all job_subcontractors" on public.job_subcontractors for all
  to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

drop policy if exists "Management read job_subcontractors" on public.job_subcontractors;
create policy "Management read job_subcontractors" on public.job_subcontractors for select
  to authenticated
  using (public.is_management(auth.uid()) and not public.is_office(auth.uid()));

-- ── subcontractor_attachments (file metadata; file lives in storage) ──────
create table if not exists public.subcontractor_attachments (
  id              uuid primary key default gen_random_uuid(),
  subcontractor_id uuid not null references public.subcontractors(id) on delete cascade,
  filename        text not null,
  storage_path    text not null,
  uploaded_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
alter table public.subcontractor_attachments enable row level security;

drop policy if exists "Office all sub attachments" on public.subcontractor_attachments;
create policy "Office all sub attachments" on public.subcontractor_attachments for all
  to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

drop policy if exists "Management read sub attachments" on public.subcontractor_attachments;
create policy "Management read sub attachments" on public.subcontractor_attachments for select
  to authenticated
  using (public.is_management(auth.uid()) and not public.is_office(auth.uid()));

-- ── private bucket for sub files ──────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('subcontractor-files', 'subcontractor-files', false)
on conflict (id) do update set public = false;

-- Office: full access (upload + read + delete).
drop policy if exists "Office all subcontractor-files storage" on storage.objects;
create policy "Office all subcontractor-files storage" on storage.objects for all
  to authenticated
  using (bucket_id = 'subcontractor-files' and public.is_office(auth.uid()))
  with check (bucket_id = 'subcontractor-files' and public.is_office(auth.uid()));

-- Superintendent + project manager: read-only (signed URLs bypass RLS, but
-- list/download go through here).
drop policy if exists "Management read subcontractor-files storage" on storage.objects;
create policy "Management read subcontractor-files storage" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'subcontractor-files'
      and public.is_management(auth.uid())
      and not public.is_office(auth.uid())
  );