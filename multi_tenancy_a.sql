-- ============================================================================
-- MULTI-TENANCY PART A: schema + backfill + helpers + triggers
-- ============================================================================
-- Purely ADDITIVE: adds an organization_id column to every business table,
-- backfills all existing single-company rows into one "owner" org, redefines
-- the role helpers to include the new `admin` role, adds org helper functions,
-- and installs BEFORE-INSERT triggers that stamp every child row with its
-- parent's org. EXISTING RLS POLICIES ARE NOT TOUCHED HERE → zero behavior
-- change, no breakage. The org boundary on policies comes in multi_tenancy_b.sql
-- (run AFTER the app deploy, see plan).
--
-- Idempotent. Run via Supabase SQL Editor — paste from Notepad, NOT the
-- terminal (the terminal mangles multiline SQL).
--
-- >>> BEFORE RUNNING: edit the two placeholders below <<<
--   :owner_org_uuid  — leave the default fixed UUID unless you already created
--                      the org; file B references this same literal.
--   'owner@example.com' — the email of YOUR existing account, which will be
--                      promoted to org `admin`. (super_admin is created later
--                      in file B, optionally.)
-- ============================================================================

-- ── 1. organizations table ─────────────────────────────────────────────────
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner_id    uuid references public.profiles(id) on delete set null,
  address     text,
  phone       text,
  email       text,
  logo_path   text,
  plan        text not null default 'trial',
  created_at  timestamptz not null default now()
);
alter table public.organizations enable row level security;

-- Fixed UUID so multi_tenancy_b.sql + the super_admin UPDATE can reference it.
-- Change the org name to your real company name if you like.
insert into public.organizations (id, name)
values ('7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', 'Terra Vista Construction')
on conflict (id) do nothing;

-- ── 2. add organization_id column to profiles + all 18 business tables ─────
alter table public.profiles               add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.jobs                   add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.customers              add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.cost_codes             add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.subcontractors         add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.photos                 add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.rfis                   add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.blueprints             add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.job_views              add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.time_entries           add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.receipts               add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.quotes                 add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.quote_line_items       add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.invoices               add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.invoice_line_items     add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.estimates              add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.estimate_line_items    add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.job_subcontractors     add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.subcontractor_attachments add column if not exists organization_id uuid references public.organizations(id) on delete cascade;

-- ── 3. backfill every existing row into the owner org (single-tenant → first tenant)
update public.profiles               set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.jobs                   set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.customers              set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.cost_codes             set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.subcontractors         set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.photos                 set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.rfis                   set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.blueprints             set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.job_views              set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.time_entries           set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.receipts               set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.quotes                 set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.quote_line_items       set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.invoices               set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.invoice_line_items     set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.estimates              set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.estimate_line_items    set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.job_subcontractors     set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;
update public.subcontractor_attachments set organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' where organization_id is null;

-- ── 4. promote your existing account to org admin ──────────────────────────
-- >>> EDIT this email to YOUR sign-in email <<<
update public.profiles
  set role = 'admin', organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
  where email = 'Austin@terravistabuilding.com';

update public.organizations
  set owner_id = (select id from public.profiles where email = 'Austin@terravistabuilding.com')
  where id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';

-- ── 5. helper functions ────────────────────────────────────────────────────
-- All SECURITY DEFINER + search_path=public (matches fix_recursion_v2.sql so
-- they bypass RLS on the profiles read — they only answer "role/org of uid",
-- which is safe). The existing role helpers are REDEFINED to include `admin`
-- so the ~56 existing policy references automatically treat admin as a
-- superset of office — no per-policy edit needed for that behavior. The org
-- boundary itself is added in multi_tenancy_b.sql via same_org().

create or replace function public.my_org_id(uid uuid)
returns uuid
language sql security definer set search_path = public stable
as $$
  select organization_id from public.profiles where id = uid;
$$;

-- super_admin MUST have a null org — a super_admin with an org is a
-- contradiction (would gain both platform + that-org access). Enforced here
-- and by a CHECK constraint in file B.
create or replace function public.is_super_admin(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role = 'super_admin' and organization_id is null
  );
$$;

-- Redefined: admin is treated as office everywhere (admin supersetes office).
create or replace function public.is_office(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin')
  );
$$;

create or replace function public.is_office_or_pm(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin', 'project_manager')
  );
$$;

create or replace function public.is_management(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin', 'superintendent', 'project_manager')
  );
$$;

-- Row-org check: super_admin bypasses; otherwise the row's org must equal the
-- caller's org. Every tier_* helper below MUST route through this — never call
-- my_org_id() directly in a policy.
create or replace function public.same_org(uid uuid, org_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select public.is_super_admin(uid)
      or (org_id is not null and org_id = public.my_org_id(uid));
$$;

-- Tier helpers = role check AND same_org, with super_admin explicit (super_admin
-- is not is_office, so it must be OR'd in to retain platform-wide access).
create or replace function public.tier_office(org_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (public.is_office(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$$;

create or replace function public.tier_office_or_pm(org_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (public.is_office_or_pm(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$$;

create or replace function public.tier_management(org_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (public.is_management(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$$;

-- ── 6. BEFORE-INSERT triggers: stamp child rows with the parent's org ──────
-- Each trigger sets NEW.organization_id UNCONDITIONALLY from the parent
-- (ignoring any client-supplied value) and RAISES if the parent is missing or
-- has a null org. This cannot be bypassed — triggers fire even for service-
-- role writes, so a cross-org service-role insert is rejected at the trigger.
-- SECURITY DEFINER so the parent-org read is not blocked by RLS on the parent.

-- Shared function for every job-anchored child (all have a job_id column).
-- NEW is a generic trigger RECORD; new.job_id / new.organization_id resolve at
-- runtime, so one function serves all 10 job-anchored tables.
create or replace function public.set_org_from_job()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.jobs where id = new.job_id;
  if v_org is null then
    raise exception 'Cannot insert %: parent job % not found or has no organization',
      TG_TABLE_NAME, new.job_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

create or replace function public.set_org_from_quote()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.quotes where id = new.quote_id;
  if v_org is null then
    raise exception 'Cannot insert quote_line_items: parent quote % missing or no org', new.quote_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

create or replace function public.set_org_from_invoice()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.invoices where id = new.invoice_id;
  if v_org is null then
    raise exception 'Cannot insert invoice_line_items: parent invoice % missing or no org', new.invoice_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

create or replace function public.set_org_from_estimate()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.estimates where id = new.estimate_id;
  if v_org is null then
    raise exception 'Cannot insert estimate_line_items: parent estimate % missing or no org', new.estimate_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

create or replace function public.set_org_from_subcontractor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.subcontractors where id = new.subcontractor_id;
  if v_org is null then
    raise exception 'Cannot insert subcontractor_attachments: parent sub % missing or no org', new.subcontractor_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

-- Triggers (drop-if-exists so re-running is safe).
drop trigger if exists trg_photos_org on public.photos;
create trigger trg_photos_org before insert on public.photos
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_rfis_org on public.rfis;
create trigger trg_rfis_org before insert on public.rfis
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_blueprints_org on public.blueprints;
create trigger trg_blueprints_org before insert on public.blueprints
  for each row execute function public.set_org_from_job();

-- job_views is upserted (onConflict) from the dashboard, so the UPDATE branch
-- must also stamp the org → BEFORE INSERT OR UPDATE.
drop trigger if exists trg_job_views_org on public.job_views;
create trigger trg_job_views_org before insert or update on public.job_views
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_receipts_org on public.receipts;
create trigger trg_receipts_org before insert on public.receipts
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_time_entries_org on public.time_entries;
create trigger trg_time_entries_org before insert on public.time_entries
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_job_subcontractors_org on public.job_subcontractors;
create trigger trg_job_subcontractors_org before insert on public.job_subcontractors
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_quotes_org on public.quotes;
create trigger trg_quotes_org before insert on public.quotes
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_invoices_org on public.invoices;
create trigger trg_invoices_org before insert on public.invoices
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_estimates_org on public.estimates;
create trigger trg_estimates_org before insert on public.estimates
  for each row execute function public.set_org_from_job();

drop trigger if exists trg_quote_line_items_org on public.quote_line_items;
create trigger trg_quote_line_items_org before insert on public.quote_line_items
  for each row execute function public.set_org_from_quote();

drop trigger if exists trg_invoice_line_items_org on public.invoice_line_items;
create trigger trg_invoice_line_items_org before insert on public.invoice_line_items
  for each row execute function public.set_org_from_invoice();

drop trigger if exists trg_estimate_line_items_org on public.estimate_line_items;
create trigger trg_estimate_line_items_org before insert on public.estimate_line_items
  for each row execute function public.set_org_from_estimate();

drop trigger if exists trg_subcontractor_attachments_org on public.subcontractor_attachments;
create trigger trg_subcontractor_attachments_org before insert on public.subcontractor_attachments
  for each row execute function public.set_org_from_subcontractor();

-- Root tables (jobs, customers, subcontractors, cost_codes, profiles) get NO
-- trigger — the app supplies organization_id on insert (enforced by
-- with-check policies in file B).
--
-- EXISTING RLS POLICIES ARE INTENTIONALLY UNCHANGED IN THIS FILE.
-- Run multi_tenancy_b.sql AFTER deploying the app changes.