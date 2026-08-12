-- ============================================================================
-- Terra Vista — Phase 3 schema.  Run ONCE in the Supabase dashboard SQL Editor.
-- Idempotent: every statement uses IF NOT EXISTS / drop-policy-if-exists, so it
-- is safe to re-run (e.g. if you already ran photos_gps.sql or receipts_extra_fields.sql).
--
-- Contains:
--   1. Photos GPS columns (lat, lng)
--   2. Receipts extra accounting rows (category, tax, payment_method, receipt_no)
--   3. Cost codes — the shared WBS backbone
--   4. Time entries — the timekeeper
-- ============================================================================

-- 1. Photos: GPS location at capture ----------------------------------------
alter table public.photos
  add column if not exists lat double precision,
  add column if not exists lng double precision;

create index if not exists photos_job_id_created_at_idx
  on public.photos (job_id, created_at desc);

-- 2. Receipts: extra accounting rows ----------------------------------------
alter table public.receipts
  add column if not exists category       text,            -- Materials / Fuel / Tools / Travel / Meals / Permits / Other
  add column if not exists tax             numeric(10,2),   -- sales tax
  add column if not exists payment_method  text,            -- Cash / Personal Card / Company Card / Account
  add column if not exists receipt_no      text;            -- vendor receipt / reference number

-- 3. Cost codes — the shared WBS backbone ----------------------------------
create table if not exists public.cost_codes (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,        -- e.g. "100" or "EL-100"
  name       text not null,                -- "Rough-in electrical"
  category   text,                         -- Labor / Material / Equipment / Subcontract / Other
  created_at timestamptz not null default now()
);

alter table public.cost_codes enable row level security;

-- Office: full CRUD on the code library.
drop policy if exists "office cost_codes_all" on public.cost_codes;
create policy "office cost_codes_all" on public.cost_codes
  for all to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

-- Everyone authenticated (crew, customer) can READ the code list so they can
-- tag time / receipts against it.
drop policy if exists "read cost_codes" on public.cost_codes;
create policy "read cost_codes" on public.cost_codes
  for select to authenticated using (true);

-- 4. Time entries — the timekeeper ------------------------------------------
create table if not exists public.time_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  job_id        uuid not null references public.jobs(id) on delete cascade,
  cost_code_id  uuid references public.cost_codes(id) on delete set null,
  clock_in_at   timestamptz not null default now(),
  clock_out_at  timestamptz,                              -- null = still on the clock
  lat           double precision,
  lng           double precision,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists time_entries_user_id_idx   on public.time_entries(user_id);
create index if not exists time_entries_job_id_idx    on public.time_entries(job_id);
-- Fast "who's on the clock right now" lookup:
create index if not exists time_entries_open_idx
  on public.time_entries(clock_in_at) where clock_out_at is null;

alter table public.time_entries enable row level security;

-- Office: full access to everyone's time.
drop policy if exists "office time_all" on public.time_entries;
create policy "office time_all" on public.time_entries
  for all to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

-- Crew: read only their own entries.
drop policy if exists "crew time_select_own" on public.time_entries;
create policy "crew time_select_own" on public.time_entries
  for select to authenticated using (user_id = auth.uid());

-- Crew: clock in (insert) only for themselves AND only on jobs they're assigned to.
drop policy if exists "crew time_insert_own" on public.time_entries;
create policy "crew time_insert_own" on public.time_entries
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.jobs j
      where j.id = job_id and auth.uid() = any(j.assigned_crew)
    )
  );

-- Crew: update (clock out / edit note) only their own rows. We intentionally do
-- NOT re-check assignment here, so a crew member who gets unassigned mid-shift
-- can still clock out their open entry.
drop policy if exists "crew time_update_own" on public.time_entries;
create policy "crew time_update_own" on public.time_entries
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Crew: delete only their own entries.
drop policy if exists "crew time_delete_own" on public.time_entries;
create policy "crew time_delete_own" on public.time_entries
  for delete to authenticated using (user_id = auth.uid());