-- Lawn chemical application tracking (Track 2 of the lawn competitive roadmap).
-- Idempotent — safe to re-run. Run live via the SQL Editor (or paste from a
-- plain-text editor first; the Editor mangles curly quotes, see leads.sql).
--
-- WHAT: lawn operators apply fertilizer / herbicide / pesticide and must keep
-- application records (most US states require licensed applicators to retain
-- 2 years). This adds TWO tables:
--   1. chemical_products  — org-scoped product catalog (name, EPA reg #, active
--      ingredient, default rate, re-entry interval). Office/PM build it once.
--   2. chemical_applications — the application log, job-anchored + org-stamped
--      via the shared set_org_from_job() trigger. A crew member logs an
--      application in the field on a visit assigned to them (applicator =
--      themselves); office/PM can log anything. Compliance records are
--      SELF-CONTAINED (product name + EPA # + active ingredient are snapshotted
--      onto the application row at log time, so editing/deleting a product
--      never corrupts historical records).
--
-- RLS: office_or_pm full CRUD + management read + crew read/insert their own
-- (mirrors lawn_visits, incl. the crew_id = auth.uid() trick which works
-- because crew_members.id = profiles.id for linked crew). NO public/anon
-- policy; NO customer-read policy for launch (customer "stay off lawn" notice
-- = fast-follow). Reuses the SECURITY DEFINER tier_ helpers + set_org_from_job
-- (no recursion). Repo convention: NO CHECK constraints on enum-ish columns
-- (the app validates units / status).

-- ============================================================================
-- 1. chemical_products — org-scoped product catalog (root table, like
--    lawn_services: organization_id supplied by the app, no set_org_from_job
--    trigger).
-- ============================================================================
create table if not exists public.chemical_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  epa_reg_number text,                 -- EPA registration number (compliance field)
  active_ingredient text,              -- e.g. "Glyphosate 41%"
  default_rate numeric(12,4),          -- pre-fill for the log form (rate per area_unit)
  rate_unit text,                      -- "oz/1000sqft", "lb/acre", etc. (app-validated)
  re_entry_hours integer,             -- re-entry interval (hours to stay off the lawn)
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chemical_products_org
  on public.chemical_products (organization_id, name);

alter table public.chemical_products enable row level security;

-- All same-org members can READ the catalog (crew need it to pick a product
-- when logging in the field; office need it to manage).
drop policy if exists "chem_product_same_org_read" on public.chemical_products;
create policy "chem_product_same_org_read" on public.chemical_products
  for select to authenticated
  using (public.same_org(auth.uid(), organization_id));

-- Office/PM manage the catalog.
drop policy if exists "chem_product_office_all" on public.chemical_products;
create policy "chem_product_office_all" on public.chemical_products
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- ============================================================================
-- 2. chemical_applications — the application log (job-anchored, org-stamped
--    from the job via set_org_from_job, like lawn_visits).
-- ============================================================================
create table if not exists public.chemical_applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  visit_id uuid references public.lawn_visits(id) on delete set null,  -- nullable: ad-hoc applications outside a visit
  product_id uuid references public.chemical_products(id) on delete set null, -- nullable: manual/one-off products
  -- Compliance snapshot — denormalized at log time so historical records
  -- survive product edits/deletes (self-contained audit record).
  product_name text not null,
  epa_reg_number text,
  active_ingredient text,
  applicator_id uuid references public.crew_members(id) on delete set null, -- crew_members.id (== profiles.id for linked crew)
  quantity_used numeric(12,3),
  quantity_unit text,                   -- "oz", "lb", "gal" (app-validated)
  rate numeric(12,4),
  area_treated_sqft numeric(12,2),
  target_pest text,                     -- "weeds", "grubs", "broadleaf"…
  wind_mph numeric(5,1),                -- drift-compliance weather
  temp_f numeric(5,1),
  applied_at timestamptz not null default now(),
  re_entry_hours integer,              -- copied from the product at log time, editable
  re_entry_until timestamptz,           -- computed: applied_at + re_entry_hours
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chem_app_org_date
  on public.chemical_applications (organization_id, applied_at desc);
create index if not exists idx_chem_app_job on public.chemical_applications (job_id);
create index if not exists idx_chem_app_visit on public.chemical_applications (visit_id);
create index if not exists idx_chem_app_applicator on public.chemical_applications (applicator_id);

-- Org stamp from the job (reuses the shared generic trigger function — it only
-- reads new.job_id and writes new.organization_id, so it works on any
-- job-anchored table). Mirrors lawn_visits / recurring_schedules / photos.
drop trigger if exists trg_chem_app_org on public.chemical_applications;
create trigger trg_chem_app_org before insert on public.chemical_applications
  for each row execute function public.set_org_from_job();

alter table public.chemical_applications enable row level security;

-- Office/PM full CRUD.
drop policy if exists "chem_app_office_all" on public.chemical_applications;
create policy "chem_app_office_all" on public.chemical_applications
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- Management (admin/owner) read.
drop policy if exists "chem_app_management_read" on public.chemical_applications;
create policy "chem_app_management_read" on public.chemical_applications
  for select to authenticated
  using (public.tier_management(organization_id));

-- Crew read applications they logged OR applications on a visit assigned to
-- them. applicator_id = auth.uid() works because crew_members.id = profiles.id
-- for linked crew (the same trick lawn_visits.crew_id uses). The visit subquery
-- is safe — lawn_visits isn't referenced by a chemical_applications policy, so
-- no recursion.
drop policy if exists "chem_app_crew_read_own" on public.chemical_applications;
create policy "chem_app_crew_read_own" on public.chemical_applications
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and (
      applicator_id = auth.uid()
      or exists (
        select 1 from public.lawn_visits lv
        where lv.id = chemical_applications.visit_id
          and lv.crew_id = auth.uid()
      )
    )
  );

-- Crew insert their own (the POST route forces applicator_id = auth.uid() for
-- crew callers). Office inserts via the office_all policy above. Crew can
-- INSERT only; no crew update/delete policy (insert-only, audit integrity).
drop policy if exists "chem_app_crew_insert_own" on public.chemical_applications;
create policy "chem_app_crew_insert_own" on public.chemical_applications
  for insert to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and applicator_id = auth.uid()
  );