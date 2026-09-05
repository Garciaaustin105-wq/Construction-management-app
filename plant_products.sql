-- Phase 2 of the estimator roadmap: a plant and tree catalogue.
-- Applied to prod 2026-09-05. See docs/quick-estimator-roadmap.md §3.
-- Verified after applying: 10 columns, 2 policies, RLS on, 2 indexes, and a
-- round-tripped insert on the test org taking the intended defaults.
--
-- Roadmap open question 1 was "catalogue, or typed per estimate?". Catalogue:
-- it is the thing that makes the second estimate faster than the first, and
-- this repo already has the pattern working in `chemical_products` — an
-- org-scoped list the office maintains, with a denormalized snapshot taken at
-- use time so editing the catalogue never rewrites history.
--
-- Placement does NOT live here. A placed plant is an `estimate_areas` row with
-- kind='point' and a one-coordinate `polygon`, carrying its snapshot in `meta`:
--
--   { plant_product_id, name, category, size, unit_price }
--
-- Storing the snapshot rather than only the id is deliberate and matches how
-- chemical applications are logged: re-pricing the catalogue in March must not
-- silently change what a customer was quoted in January.
--
-- `size` is free text, not an enum. Nurseries quote "30 gal", "#5", "45 box",
-- "2in cal", "B&B" and there is no closed set worth fighting over.
--
-- No CHECK on `category`: repo convention is that the app validates enum-ish
-- columns, so adding a value never needs a migration.
--
-- Idempotent and additive: IF NOT EXISTS throughout, no DROP, no TRUNCATE.

create table if not exists public.plant_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text not null default 'shrub',
  size text,
  unit_price numeric not null default 0,
  color text not null default '#16a34a',
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.plant_products is
  'Org-maintained catalogue of plants and trees for the quick estimator. Placed instances live in estimate_areas as kind=point with a snapshot in meta.';

comment on column public.plant_products.category is
  'tree | palm | shrub | perennial | grass | annual | groundcover. App-validated, deliberately not a CHECK.';

comment on column public.plant_products.size is
  'Container or caliper size as the nursery quotes it: "30 gal", "#5", "2in cal", "B&B". Free text on purpose.';

comment on column public.plant_products.unit_price is
  'Installed price the customer pays per plant. One number, not material + labor — this is a quick estimator, not a cost-accounting system.';

comment on column public.plant_products.color is
  'Marker color on the estimator map, so a legend reads at a glance. Hex, matching the existing area color convention.';

-- Every read is "the active catalogue for my org", which is also how the
-- picker loads. Nothing queries plants across orgs.
create index if not exists plant_products_org_active_idx
  on public.plant_products (organization_id, active);

alter table public.plant_products enable row level security;

-- Mirrors chemical_products exactly: office and PM maintain the catalogue,
-- everyone in the org can read it (a crew lead opening an estimate needs the
-- names to render).
drop policy if exists plant_product_office_all on public.plant_products;
create policy plant_product_office_all on public.plant_products
  for all using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

drop policy if exists plant_product_same_org_read on public.plant_products;
create policy plant_product_same_org_read on public.plant_products
  for select using (same_org((select auth.uid()), organization_id));
