-- ============================================================================
-- Terra Vista — Professional GC features: Daily Logs, Punch List, Change
-- Orders, Submittals.
-- ----------------------------------------------------------------------------
-- Four net-new, job-scoped, RLS-gated, multi-tenant features that reuse the
-- app's existing patterns end-to-end and fold into budget + the office
-- notification feed. Run ONCE in the Supabase SQL Editor — paste from Notepad,
-- NOT the terminal (the Editor mangles pasted single quotes into double
-- quotes); single-quoted literals only.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE —
-- passes scripts/check-migrations.mjs). drop policy/trigger/index if exists +
-- create or replace function + alter table ... add column if not exists are
-- all safe and used below.
--
-- Run BEFORE deploying the app code that queries the new tables/columns (the
-- new UI would get PostgREST errors if the tables did not exist yet). Until
-- then the app degrades gracefully (supabase-js returns {error} not throw →
-- ?? []).
--
-- Reuses the SECURITY DEFINER helpers from multi_tenancy_a.sql / _b.sql:
--   tier_office_or_pm(org_id)   — office/admin/PM/super_admin AND same_org
--   tier_management(org_id)     — management/super_admin AND same_org
--   same_org(uid, org_id)        — uid is in that org (or super_admin)
--   set_org_from_job()          — BEFORE INSERT trigger: stamps org from job
--   storage_job_org(name)       — org of the jobId encoded in a <jobId>/.. path
--   storage_caller_assigned_to_job(name) / storage_caller_owns_job(name)
--
-- RLS is the four-tier pattern from schedule_events/calendar.sql:
--   office/PM manage (for all), management read, assigned-crew read, owning-
--   customer read. Per-table tiers are trimmed per feature (e.g. daily logs
--   are internal → no customer tier; change orders use the portal as the
--   channel → office/PM + management only).
-- ============================================================================

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. set_org_from_change_order() — sibling of set_org_from_estimate, stamps
--    change_order_lines.organization_id from the parent change order.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.set_org_from_change_order()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.change_orders where id = new.change_order_id;
  if v_org is null then
    raise exception 'Cannot insert change_order_lines: parent change order % missing or no org', new.change_order_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. daily_logs — per-job daily work log (weather, work, equipment, materials,
--    delays, safety, crew count) with photos attached via photos.daily_log_id.
--    Status: submitted → reviewed (office marks reviewed). Internal (no
--    customer access).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.daily_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  log_date        date not null,
  weather         text,
  work_performed  text,
  equipment       text,
  materials       text,
  delays          text,
  safety_notes    text,
  crew_count      int,
  status          text not null default 'submitted'
                  check (status in ('submitted','reviewed')),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_daily_logs_job on public.daily_logs(job_id);
create index if not exists idx_daily_logs_org_date on public.daily_logs(organization_id, log_date desc);
create unique index if not exists idx_daily_logs_job_date on public.daily_logs(job_id, log_date);

alter table public.daily_logs enable row level security;

drop trigger if exists trg_daily_logs_org on public.daily_logs;
create trigger trg_daily_logs_org before insert on public.daily_logs
  for each row execute function public.set_org_from_job();

-- office/PM manage; management read; assigned crew read + insert own + update own.
drop policy if exists "Office manage daily logs" on public.daily_logs;
create policy "Office manage daily logs" on public.daily_logs
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read daily logs" on public.daily_logs;
create policy "Management read daily logs" on public.daily_logs
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned daily logs" on public.daily_logs;
create policy "Crew read assigned daily logs" on public.daily_logs
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = daily_logs.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Crew insert daily logs" on public.daily_logs;
create policy "Crew insert daily logs" on public.daily_logs
  for insert to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and created_by = auth.uid()
    and exists (
      select 1 from public.jobs j
      where j.id = daily_logs.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Crew update own daily logs" on public.daily_logs;
create policy "Crew update own daily logs" on public.daily_logs
  for update to authenticated
  using (public.same_org(auth.uid(), organization_id) and created_by = auth.uid())
  with check (public.same_org(auth.uid(), organization_id) and created_by = auth.uid());

-- ════════════════════════════════════════════════════════════════════════════
-- 3. punch_items — per-job punch / closeout list. Status open → in_progress →
--    complete (void). Office/PM create + assign + close; crew advance their
--    assigned items. Photos via photos.punch_item_id. Customer can read (own
--    jobs) so owners can view closeout items.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.punch_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  title           text not null,
  description     text,
  location        text,
  assigned_to     uuid references public.profiles(id) on delete set null,
  status          text not null default 'open'
                  check (status in ('open','in_progress','complete','void')),
  priority        text not null default 'normal'
                  check (priority in ('low','normal','high')),
  due_date        date,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  completed_by    uuid references public.profiles(id) on delete set null
);

create index if not exists idx_punch_items_job on public.punch_items(job_id);
create index if not exists idx_punch_items_org_status on public.punch_items(organization_id, status);
create index if not exists idx_punch_items_assigned on public.punch_items(assigned_to) where assigned_to is not null;

alter table public.punch_items enable row level security;

drop trigger if exists trg_punch_items_org on public.punch_items;
create trigger trg_punch_items_org before insert on public.punch_items
  for each row execute function public.set_org_from_job();

-- office/PM manage; management read; assigned crew read + insert + update own;
-- owning customer read.
drop policy if exists "Office manage punch items" on public.punch_items;
create policy "Office manage punch items" on public.punch_items
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read punch items" on public.punch_items;
create policy "Management read punch items" on public.punch_items
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned punch items" on public.punch_items;
create policy "Crew read assigned punch items" on public.punch_items
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and (
      assigned_to = auth.uid()
      or exists (
        select 1 from public.jobs j
        where j.id = punch_items.job_id
          and auth.uid() = any(j.assigned_crew)
      )
    )
  );

drop policy if exists "Crew insert punch items" on public.punch_items;
create policy "Crew insert punch items" on public.punch_items
  for insert to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and created_by = auth.uid()
    and exists (
      select 1 from public.jobs j
      where j.id = punch_items.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

-- Crew may advance the status of items assigned to them (open/in_progress/
-- complete) and stamp completed_at/completed_by. Office/PM already cover full
-- update via "Office manage punch items".
drop policy if exists "Crew update assigned punch items" on public.punch_items;
create policy "Crew update assigned punch items" on public.punch_items
  for update to authenticated
  using (public.same_org(auth.uid(), organization_id) and assigned_to = auth.uid())
  with check (public.same_org(auth.uid(), organization_id) and assigned_to = auth.uid());

drop policy if exists "Customer read own punch items" on public.punch_items;
create policy "Customer read own punch items" on public.punch_items
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = punch_items.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 4. change_orders — per-job change order with header amount + cost-code
--    lines. Status: draft → submitted → sent (emailed to owner via portal) →
--    approved/rejected (owner decides at /co/{token}) → void. The portal uses
--    the service role, so customer access here is office/PM + management only.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.change_orders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  co_number       text,
  title           text not null,
  description     text,
  reason          text,
  amount          numeric(12,2) not null default 0,
  is_credit       boolean not null default false,
  source_ref      text,
  share_token     uuid,
  status          text not null default 'draft'
                  check (status in ('draft','submitted','sent','approved','rejected','void')),
  created_by      uuid references public.profiles(id) on delete set null,
  sent_at         timestamptz,
  viewed_at       timestamptz,
  approved_at     timestamptz,
  rejected_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_change_orders_job on public.change_orders(job_id);
create index if not exists idx_change_orders_org_status on public.change_orders(organization_id, status);
create unique index if not exists idx_change_orders_co_number_org
  on public.change_orders(co_number, organization_id) where co_number is not null;
create unique index if not exists idx_change_orders_share_token
  on public.change_orders(share_token) where share_token is not null;

alter table public.change_orders enable row level security;

drop trigger if exists trg_change_orders_org on public.change_orders;
create trigger trg_change_orders_org before insert on public.change_orders
  for each row execute function public.set_org_from_job();

drop policy if exists "Office manage change orders" on public.change_orders;
create policy "Office manage change orders" on public.change_orders
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read change orders" on public.change_orders;
create policy "Management read change orders" on public.change_orders
  for select to authenticated
  using (public.tier_management(organization_id));

-- ════════════════════════════════════════════════════════════════════════════
-- 5. change_order_lines — cost-coded lines for a change order. Org stamped
--    from the parent change order (not the job). Approved lines raise/lower the
--    budget in JobBudget.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.change_order_lines (
  id               uuid primary key default gen_random_uuid(),
  change_order_id  uuid not null references public.change_orders(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  cost_code_id     uuid references public.cost_codes(id) on delete set null,
  description      text,
  quantity         numeric(12,2) not null default 1,
  unit             text,
  unit_price       numeric(12,2) not null default 0,
  position         integer not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists idx_change_order_lines_co on public.change_order_lines(change_order_id);

alter table public.change_order_lines enable row level security;

drop trigger if exists trg_change_order_lines_org on public.change_order_lines;
create trigger trg_change_order_lines_org before insert on public.change_order_lines
  for each row execute function public.set_org_from_change_order();

drop policy if exists "Office manage change order lines" on public.change_order_lines;
create policy "Office manage change order lines" on public.change_order_lines
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read change order lines" on public.change_order_lines;
create policy "Management read change order lines" on public.change_order_lines
  for select to authenticated
  using (public.tier_management(organization_id));

-- ════════════════════════════════════════════════════════════════════════════
-- 6. submittals — per-job submittal (shop drawings, product data, samples).
--    Status: draft → submitted (sent to architect/owner at /s/{token}) →
--    returned (disposition set by reviewer) → closed (office). Simplified to
--    one reviewer (architect/owner via portal) — NOT Procore's full sub→GC→
--    architect→distribution multi-hop.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.submittals (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  job_id            uuid not null references public.jobs(id) on delete cascade,
  submittal_number  text,
  title             text not null,
  description       text,
  csi_section       text,
  cost_code_id      uuid references public.cost_codes(id) on delete set null,
  status            text not null default 'draft'
                    check (status in ('draft','submitted','returned','closed')),
  disposition       text
                    check (disposition in ('approved','approved_as_noted','revise_resubmit','rejected')),
  ball_in_court     text not null default 'office'
                    check (ball_in_court in ('office','architect')),
  share_token       uuid,
  created_by        uuid references public.profiles(id) on delete set null,
  sent_at           timestamptz,
  viewed_at         timestamptz,
  returned_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_submittals_job on public.submittals(job_id);
create index if not exists idx_submittals_org_status on public.submittals(organization_id, status);
create unique index if not exists idx_submittals_number_org
  on public.submittals(submittal_number, organization_id) where submittal_number is not null;
create unique index if not exists idx_submittals_share_token
  on public.submittals(share_token) where share_token is not null;

alter table public.submittals enable row level security;

drop trigger if exists trg_submittals_org on public.submittals;
create trigger trg_submittals_org before insert on public.submittals
  for each row execute function public.set_org_from_job();

drop policy if exists "Office manage submittals" on public.submittals;
create policy "Office manage submittals" on public.submittals
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read submittals" on public.submittals;
create policy "Management read submittals" on public.submittals
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned submittals" on public.submittals;
create policy "Crew read assigned submittals" on public.submittals
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = submittals.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own submittals" on public.submittals;
create policy "Customer read own submittals" on public.submittals
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = submittals.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 7. submittal_files — file attachments for a submittal (PDFs / drawings). Org
--    stamped from the job. The file bytes live in the private `submittal-files`
--    bucket (created below) under <jobId>/<submittalId>/<file>; viewing is via
--    signed URLs. Storage policies reuse storage_job_org so paths keyed by the
--    first segment (jobId) resolve the org.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.submittal_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  submittal_id    uuid not null references public.submittals(id) on delete cascade,
  filename        text not null,
  storage_path    text not null,
  uploaded_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_submittal_files_submittal on public.submittal_files(submittal_id);

alter table public.submittal_files enable row level security;

drop trigger if exists trg_submittal_files_org on public.submittal_files;
create trigger trg_submittal_files_org before insert on public.submittal_files
  for each row execute function public.set_org_from_job();

drop policy if exists "Office manage submittal files" on public.submittal_files;
create policy "Office manage submittal files" on public.submittal_files
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "Management read submittal files" on public.submittal_files;
create policy "Management read submittal files" on public.submittal_files
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Crew read assigned submittal files" on public.submittal_files;
create policy "Crew read assigned submittal files" on public.submittal_files
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = submittal_files.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

drop policy if exists "Customer read own submittal files" on public.submittal_files;
create policy "Customer read own submittal files" on public.submittal_files
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.jobs j
      where j.id = submittal_files.job_id
        and j.customer_id in (
          select customer_id from public.profiles where id = auth.uid()
        )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 8. photos — nullable FKs so a daily log or punch item can attach photos from
--    the existing photos table (reuses photo RLS + storage; no new bucket).
--    on delete set null so deleting a log/punch item leaves the photo in place.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.photos
  add column if not exists daily_log_id uuid references public.daily_logs(id) on delete set null;
alter table public.photos
  add column if not exists punch_item_id uuid references public.punch_items(id) on delete set null;

create index if not exists idx_photos_daily_log on public.photos(daily_log_id) where daily_log_id is not null;
create index if not exists idx_photos_punch_item on public.photos(punch_item_id) where punch_item_id is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. submittal-files storage bucket + policies — mirrors blueprints (private;
--    office/PM manage, assigned crew + owning customer read). Paths are
--    <jobId>/<submittalId>/<file>; the helpers split the FIRST segment (jobId),
--    so storage_job_org / storage_caller_assigned_to_job / storage_caller_owns_job
--    resolve correctly with zero new helpers.
-- ════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('submittal-files', 'submittal-files', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Office upload submittal files" on storage.objects;
create policy "Office upload submittal files" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'submittal-files' and public.tier_office(public.storage_job_org(name))
  );

drop policy if exists "Authenticated read submittal files" on storage.objects;
create policy "Authenticated read submittal files" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'submittal-files' and (
      public.tier_office(public.storage_job_org(name))
      or public.storage_caller_assigned_to_job(name)
      or public.storage_caller_owns_job(name)
    )
  );

drop policy if exists "Office delete submittal files" on storage.objects;
create policy "Office delete submittal files" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'submittal-files' and public.tier_office(public.storage_job_org(name))
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Reload PostgREST schema so the new tables/columns are immediately visible
--     to the auto-gen API without a restart.
-- ════════════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verification (run manually in SQL Editor after this file succeeds):
--   select count(*) from public.daily_logs;          -- 0 ok
--   select count(*) from public.punch_items;         -- 0 ok
--   select count(*) from public.change_orders;       -- 0 ok
--   select count(*) from public.change_order_lines;  -- 0 ok
--   select count(*) from public.submittals;          -- 0 ok
--   select count(*) from public.submittal_files;     -- 0 ok
--   select daily_log_id, punch_item_id from public.photos limit 1;  -- null ok
--   select public from storage.buckets where id = 'submittal-files'; -- false ok
-- ════════════════════════════════════════════════════════════════════════════