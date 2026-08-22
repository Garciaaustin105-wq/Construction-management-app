-- isp_module.sql
-- ----------------------------------------------------------------------------
-- ISP / fiber module — phase 1: the feature flag + the `installs` records.
--
-- CONTEXT: a hidden module for ONE construction organization (an internet /
-- fiber provider). Not a new app_variant — `organizations.app_variant` is
-- variant-level (construction vs lawn) and branches nav for every org of that
-- variant, which is the wrong mechanism for a single-customer feature. So this
-- adds a per-ORG boolean flag instead, defaulting to false, and every other
-- org is unaffected the moment this runs.
--
-- SCOPE OF THIS FILE: the flag, install types, and the installs table (office-
-- created, typed, flat-priced, crew-assigned, calendar-visible). Equipment /
-- inventory, permits / right-of-way, and the fiber-route map + KML import are
-- NOT in this file — they're later phases.
--
-- ── Calendar integration: read this before wondering where the trigger is ──
-- Installs deliberately do NOT write rows into `schedule_events`. That table's
-- `job_id` is NOT NULL, and — more importantly — every crew/customer
-- visibility rule in the app resolves THROUGH that job_id:
--   * RLS "Crew read assigned schedule events":
--       exists (select 1 from jobs j
--               where j.id = schedule_events.job_id
--                 and auth.uid() = any (j.assigned_crew))
--     A null job_id makes that EXISTS false — crew would silently never see
--     install events, which is the exact feature being asked for.
--   * RLS "Customer read own schedule events" — same shape, same failure.
--   * The iCal subscribe feed (src/app/api/calendar/feed/route.ts) scopes
--     crew/customer with `.in("job_id", visibleJobIds)`; a null job_id row is
--     never returned by an IN filter. Second silent failure, different surface.
--   * src/lib/calendarEvents.ts types job_id as non-null and builds
--     `href: /jobs/${e.job_id}` — a null yields dead /jobs/null links.
-- Instead, installs carry their OWN scheduled_at + assigned_crew, and get
-- merged into the calendar at read time. src/lib/calendarEvents.ts is already
-- a multi-source merge (jobs, schedule_events, job_subcontractors, invoices,
-- estimates, lawn_visits → one CalEvent[]), so installs become a 7th source
-- there and a parallel block in the feed route. Crew visibility is then
-- governed by this table's own RLS, directly and correctly, with zero surgery
-- on a table the lawn variant also depends on.
--
-- ── org stamping ──
-- Reuses the EXISTING `set_org_from_job_or_org()` trigger fn (already live,
-- already hardened in harden_function_execute.sql): if job_id is set the
-- parent job's org wins (so an install can never be attached to another org's
-- job with a mismatched org), otherwise the app-supplied organization_id is
-- used and RLS `with check (tier_office_or_pm(organization_id))` proves the
-- caller is office/PM in that org. No new trigger function is introduced.
--
-- ── plan limits ──
-- Installs are intentionally NOT capped. They do not consume `maxJobs` (that
-- was the point of not creating a job per install), and plans.ts has no
-- maxInstalls dimension. If a cap is ever wanted, add it to plans.ts first and
-- then a guard_install_create() BEFORE INSERT trigger matching the existing
-- guard_job_create / guard_customer_create / guard_crew_member_create pattern.
--
-- Idempotent: `if not exists` + `drop policy if exists`. No DROP TABLE.
-- Run in the Supabase SQL editor — paste from a text editor (Notepad), NOT the
-- web editor (it mangles single quotes).
-- ----------------------------------------------------------------------------


-- ── 1. Per-org feature flag ────────────────────────────────────────────────
-- Gates the hidden tab / nav item / pages in the app. Deliberately does NOT
-- appear in RLS below: the flag controls UI reachability, RLS controls data
-- access. Keeping those separate means a flag flip can never become a data
-- leak, and RLS stays readable.
alter table public.organizations
  add column if not exists isp_module_enabled boolean not null default false;

comment on column public.organizations.isp_module_enabled is
  'Per-org hidden ISP/fiber module (installs, equipment, permits, fiber map). Gates UI only; RLS is independent.';


-- ── 2. Install types (office-managed lookup) ───────────────────────────────
-- A lookup table rather than a CHECK constraint on a text column, so the
-- office can add/rename/retire install types in-app without a migration every
-- time. Org-scoped so each org's list is its own.
create table if not exists public.install_types (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  position        integer not null default 0,   -- display order in the picker
  active          boolean not null default true, -- retire without deleting history
  created_at      timestamptz not null default now()
);

-- One name per org. Retired types keep their row (installs still reference
-- them), so uniqueness is on the name regardless of active state.
create unique index if not exists install_types_org_name_key
  on public.install_types (organization_id, lower(name));

alter table public.install_types enable row level security;

drop policy if exists "office_manage_install_types" on public.install_types;
create policy "office_manage_install_types" on public.install_types for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- Everyone in the org may READ the type list — crew and customers need it to
-- render an install's type name. No write.
drop policy if exists "same_org_read_install_types" on public.install_types;
create policy "same_org_read_install_types" on public.install_types for select
  to authenticated
  using (public.same_org(auth.uid(), organization_id));

grant select, insert, update, delete on public.install_types to authenticated;


-- ── 3. Installs ────────────────────────────────────────────────────────────
create table if not exists public.installs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,

  -- The "integrated with jobs but a separate item" link. NULLABLE on purpose:
  -- a service call or a one-off drop needn't belong to a construction job.
  -- When set, set_org_from_job_or_org() takes the org from the job.
  job_id           uuid references public.jobs(id) on delete set null,
  customer_id      uuid references public.customers(id) on delete set null,

  install_type_id  uuid references public.install_types(id) on delete restrict,

  title            text not null,
  -- Flat price per install (confirmed decision — not line items). numeric(12,2)
  -- matches invoices/payments money columns.
  price            numeric(12,2) not null default 0 check (price >= 0),

  status           text not null default 'scheduled'
                   check (status in ('scheduled','in_progress','completed','cancelled')),

  address          text,
  -- Own schedule + crew: this is what puts an install on the calendar without
  -- touching schedule_events. Nullable so the office can draft an install
  -- before it's scheduled.
  scheduled_at     timestamptz,
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  assigned_crew    uuid[] not null default '{}',  -- mirrors jobs.assigned_crew

  notes            text,
  completed_at     timestamptz,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists installs_org_scheduled_idx
  on public.installs (organization_id, scheduled_at);
create index if not exists installs_job_id_idx      on public.installs (job_id);
create index if not exists installs_customer_id_idx on public.installs (customer_id);
create index if not exists installs_status_idx      on public.installs (organization_id, status);

-- Org stamping + updated_at, both reusing already-live hardened trigger fns.
drop trigger if exists trg_set_org_from_install on public.installs;
create trigger trg_set_org_from_install
  before insert on public.installs
  for each row execute function public.set_org_from_job_or_org();

drop trigger if exists trg_touch_installs on public.installs;
create trigger trg_touch_installs
  before update on public.installs
  for each row execute function public.touch_updated_at();

alter table public.installs enable row level security;

-- Office / admin / PM / super_admin, same org: full control. Mirrors
-- "Office manage schedule events" and office_payments_all.
drop policy if exists "office_manage_installs" on public.installs;
create policy "office_manage_installs" on public.installs for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- Management read (superintendent etc.) — mirrors "Management read schedule
-- events".
drop policy if exists "management_read_installs" on public.installs;
create policy "management_read_installs" on public.installs for select
  to authenticated
  using (public.tier_management(organization_id));

-- Crew read their OWN assigned installs — READ ONLY. This is the policy that
-- makes the crew calendar work; note it reads assigned_crew on THIS row, with
-- no dependency on a parent job, which is exactly why installs don't ride on
-- schedule_events.
--
-- NO crew UPDATE policy, deliberately. Crew cannot change anything on a job on
-- the construction side and installs follow that same rule. Verified against
-- the live policies rather than assumed: `jobs` has only "Office update jobs"
-- (tier_office_or_pm) and `job_tasks` only "Office manage job tasks" — there is
-- no crew-write policy on either. The one crew-write policy that exists
-- anywhere is "Crew update my route lawn visits" on lawn_visits, which is the
-- LAWN variant's route-completion flow and does not apply here.
--
-- Consequence to design around in the app: a crew member CANNOT mark an install
-- in progress or complete from the field. Status changes are office-only. If
-- field status updates are wanted later, do NOT add a crew UPDATE policy (it
-- would also expose price, address, assigned_crew to edits) — add a
-- SECURITY DEFINER RPC that touches only status/completed_at and verifies
-- `auth.uid() = any (assigned_crew)` internally, mirroring approve_estimate /
-- assign_job_crew, and revoke EXECUTE from public + anon per
-- harden_function_execute.sql.
drop policy if exists "crew_read_assigned_installs" on public.installs;
create policy "crew_read_assigned_installs" on public.installs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and auth.uid() = any (assigned_crew)
  );

-- Explicitly remove the crew UPDATE policy if an earlier draft of this file
-- was ever run. Safe no-op otherwise.
drop policy if exists "crew_update_assigned_installs" on public.installs;

-- Customer reads their own installs. Mirrors "Customer read own schedule
-- events" but resolves ownership directly off customer_id.
drop policy if exists "customer_read_own_installs" on public.installs;
create policy "customer_read_own_installs" on public.installs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (
      select customer_id from public.profiles where id = auth.uid()
    )
  );

grant select, insert, update, delete on public.installs to authenticated;
-- No sequence grant: id is uuid default gen_random_uuid() (a function default,
-- not serial/identity), so no installs_id_seq exists. RLS gates all access.

notify pgrst, 'reload schema';


-- ----------------------------------------------------------------------------
-- VERIFY (expect: flag column present; 2 policies on install_types; 4 on
-- installs — office ALL, management SELECT, crew SELECT, customer SELECT, and
-- NO crew UPDATE; 2 triggers on installs):
--
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='organizations'
--     and column_name='isp_module_enabled';
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname='public' and tablename in ('installs','install_types')
--   order by tablename, cmd, policyname;
--
--   select tgname from pg_trigger
--   where tgrelid='public.installs'::regclass and not tgisinternal;
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- NOT RUN AUTOMATICALLY — enabling the module + seeding types.
--
-- Nothing above turns the module on for anybody (flag defaults to false), and
-- no install types exist yet. Once you tell me which organization this is for,
-- run something like the following (replace the org name), or I'll write it as
-- its own small file:
--
--   update public.organizations
--      set isp_module_enabled = true
--    where name = 'REPLACE WITH THE ISP ORG NAME';
--
--   insert into public.install_types (organization_id, name, position)
--   select o.id, t.name, t.pos
--     from public.organizations o
--     cross join (values
--       ('Aerial drop',        10),
--       ('Underground drop',   20),
--       ('Trunk line',         30),
--       ('Splice',             40),
--       ('Service call',       50),
--       ('Repair',             60),
--       ('Equipment swap',     70),
--       ('Disconnect',         80)
--     ) as t(name, pos)
--    where o.name = 'REPLACE WITH THE ISP ORG NAME'
--   on conflict do nothing;
--
-- That seed list is a first guess at fiber/ISP install types — rename, reorder,
-- or drop any of them. Because they're rows and not a CHECK constraint,
-- changing the list later never needs another migration.
-- ----------------------------------------------------------------------------
