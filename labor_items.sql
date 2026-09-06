-- Labor lines that are not plants, sod, heads or irrigation parts.
-- Research: docs/labor-production-rates.md.
--
-- WHY A FOURTH CATALOGUE AND NOT A FIFTH BESPOKE ONE: the app already prices
-- labor in three places, each correct for its domain — plants carry
-- install_minutes per size, sod carries install_minutes_per_1000_sqft, and
-- irrigation components carry install_minutes per each-or-foot. Everything
-- else in a landscape job — mulch, edging, bed prep, grading, demolition,
-- haul-off, drainage, cleanup — had NO line anywhere. Those tasks need six
-- more units between them, and building a table per unit is how you end up
-- with six tables. One table with a unit enum is the shape that stops.
--
-- THE DOUBLE-COUNT HAZARD, and it is the reason to read before adding rows:
-- this table must NOT contain sod installation, plant installation, or
-- irrigation part labor. Those are already priced by their own catalogues, and
-- a "sod install labor" row here bills the same man-hours twice. Removal is a
-- different task from installation and belongs here; installation does not.
-- LABOR_SCOPE_NOTE in src/lib/laborItems.ts carries this text for the UI.
--
-- SAME TRIO AS EVERY OTHER CATALOGUE: cost is material per unit (zero for pure
-- labor like weeding), unit_price is what the org charges per unit, and
-- install_minutes is MAN-minutes per unit. A mulch row carries both material
-- and labor; a hand-weeding row carries only labor. One shape, both cases.
--
-- INSTALL_MINUTES IS NUMERIC, NOT INTEGER, and that is deliberate. Per-area and
-- per-foot rates are inherently fractional: fertilizer at 43,000 sqft/hour is
-- 1.4 man-minutes per thousand square feet, and an integer column rounds that
-- to 1 — a 30% error that never surfaces. The same bug was live on
-- irrigation_components for per-foot rows and is fixed at the bottom of this
-- file.
--
-- Idempotent and additive: IF NOT EXISTS throughout, no DROP.

create table if not exists public.labor_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  -- bed_prep, mulch, edging, grading, demolition, haul_off, drainage,
  -- cleanup, weeding, seeding, mobilization, other.
  -- App-validated, no CHECK — matching every other catalogue here.
  category text not null default 'other',
  -- each | foot | sqft | msqft | cubic_yard | ton | hour | job
  -- msqft is per THOUSAND square feet, the unit turf work is already quoted in
  -- (see sod_products.install_minutes_per_1000_sqft). Without it, per-sqft turf
  -- rates are four-decimal numbers nobody can sanity-check.
  unit text not null default 'each',
  -- Material per unit. Zero on a pure-labor row, which is not the same as free.
  cost numeric not null default 0,
  unit_price numeric not null default 0,
  -- MAN-minutes per unit. Numeric, see the header.
  install_minutes numeric not null default 0,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.labor_items is
  'Mulch, edging, bed prep, grading, demolition, haul-off and the rest. NOT sod, plant or irrigation labor - those are priced by their own catalogues and duplicating them here bills the same hours twice.';
comment on column public.labor_items.unit is
  'each | foot | sqft | msqft | cubic_yard | ton | hour | job. A quantity is meaningless without it; the UI must label the field.';
comment on column public.labor_items.install_minutes is
  'Man-minutes per unit. Numeric because per-area and per-foot rates are fractional.';

create index if not exists labor_items_org_idx
  on public.labor_items (organization_id, active, name);

alter table public.labor_items enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'labor_items'
      and policyname = 'labor_item_office_all') then
    create policy labor_item_office_all on public.labor_items
      for all using (tier_office_or_pm(organization_id))
      with check (tier_office_or_pm(organization_id));
  end if;
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'labor_items'
      and policyname = 'labor_item_same_org_read') then
    create policy labor_item_same_org_read on public.labor_items
      for select using (same_org((select auth.uid()), organization_id));
  end if;
end $$;

-- Labor lines attached to one estimate.
create table if not exists public.estimate_labor_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  -- Nullable: the catalogue row may later be deleted, and the snapshot is what
  -- prices the quote.
  labor_item_id uuid references public.labor_items(id) on delete set null,
  snapshot jsonb not null default '{}'::jsonb,
  -- In whatever snapshot.unit says. Meaningless without it.
  quantity numeric not null default 1,
  created_at timestamptz not null default now()
);

comment on column public.estimate_labor_items.snapshot is
  'Copy of the labor item at the time it was added. Re-pricing the catalogue must not move a sent quote.';

create index if not exists estimate_labor_items_estimate_idx
  on public.estimate_labor_items (estimate_id);

alter table public.estimate_labor_items enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'estimate_labor_items'
      and policyname = 'estimate_labor_item_office_all') then
    create policy estimate_labor_item_office_all on public.estimate_labor_items
      for all using (tier_office_or_pm(organization_id))
      with check (tier_office_or_pm(organization_id));
  end if;
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'estimate_labor_items'
      and policyname = 'estimate_labor_item_same_org_read') then
    create policy estimate_labor_item_same_org_read on public.estimate_labor_items
      for select using (same_org((select auth.uid()), organization_id));
  end if;
end $$;

-- FIX, not a new feature: irrigation_components.install_minutes shipped as
-- integer, but that table has per-FOOT rows and per-foot labor is fractional.
-- 0.5 man-minutes per foot of wire is a real figure and the integer column
-- rounds it to 0 or 1 with no error. Widening is lossless.
alter table public.irrigation_components
  alter column install_minutes type numeric using install_minutes::numeric;

comment on column public.irrigation_components.install_minutes is
  'Man-minutes per unit, per FOOT on a foot-unit row. Numeric because per-foot rates are fractional.';
