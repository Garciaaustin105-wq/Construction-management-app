-- Everything between the water source and the heads — phase 4b of
-- docs/quick-estimator-roadmap.md. Spec: docs/handoff-ui-lane-d-controls-and-mainline.md.
--
-- WHY A SECOND TABLE rather than more rows in irrigation_products: that one is
-- model -> nozzle, two levels, and these are flat. More to the point they need
-- a `unit` column, which would be meaningless on a nozzle.
--
-- UNIT IS THE WHOLE POINT. Heads are per-each; wire, mainline and sleeving are
-- per-FOOT. Without this column a quantity of "2" is ambiguous — two valves or
-- two feet — and the estimator has no way to tell. It is also why dripline had
-- to ship flagged "priced per foot, not built yet": there was nowhere to say so.
--
-- SNAPSHOT RULE, same as plants, heads, sod and equipment: estimate_components
-- stores a COPY of the component in `snapshot`, so re-pricing the catalogue
-- never moves a quote that has already gone out.
--
-- SCOPE: this carries parts and prices. It does not decide how many zones a
-- property needs — that is available flow over head demand with pressure loss
-- along the run, and it is licensed design work. The only system-level check in
-- scope is arithmetic on what the estimator typed: do the controller's stations
-- cover the zone valves they entered.
--
-- BACKFLOW AND SENSORS: type, mounting height, permitting and annual testing
-- are set by local code and vary by jurisdiction; rain sensors are required by
-- statute in several states including Florida. The `notes` column exists so the
-- ORG can record what its own installers know. This app must not state a code
-- requirement as fact or imply a chosen device is compliant.
--
-- Idempotent and additive: IF NOT EXISTS throughout, no DROP.

create table if not exists public.irrigation_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  -- poc, backflow, master_valve, flow_sensor, mainline, lateral, drip,
  -- zone_valve, valve_box, controller, wire, connector, sensor, sleeve,
  -- fitting, trenching, other.
  -- App-validated, no CHECK — matching every other catalogue here, so adding a
  -- category is a code change and not a migration.
  category text not null default 'other',
  -- 'each' | 'foot'. THE reason this table exists separately.
  unit text not null default 'each',
  cost numeric not null default 0,
  unit_price numeric not null default 0,
  -- MAN-minutes PER UNIT. On a per-foot row that is per FOOT: 0.5 is trivial
  -- per foot and 100 man-minutes over a 200 ft run.
  install_minutes integer not null default 0,
  -- Free text the org writes, e.g. "PVB, typically 12in above the highest head;
  -- check local code and permitting".
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.irrigation_components is
  'Point of connection, backflow, mainline, valves, controller, wire and sleeving. Priced per each or per foot — see the unit column.';
comment on column public.irrigation_components.unit is
  'each | foot. A quantity means pieces or feet depending on this; the UI must label the field with it.';
comment on column public.irrigation_components.install_minutes is
  'Man-minutes per unit. Per FOOT on a foot-unit row.';

create index if not exists irrigation_components_org_idx
  on public.irrigation_components (organization_id, active, name);

alter table public.irrigation_components enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'irrigation_components'
      and policyname = 'irrigation_component_office_all') then
    create policy irrigation_component_office_all on public.irrigation_components
      for all using (tier_office_or_pm(organization_id))
      with check (tier_office_or_pm(organization_id));
  end if;
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'irrigation_components'
      and policyname = 'irrigation_component_same_org_read') then
    create policy irrigation_component_same_org_read on public.irrigation_components
      for select using (same_org((select auth.uid()), organization_id));
  end if;
end $$;

-- Components attached to one estimate.
create table if not exists public.estimate_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  -- Nullable on purpose: the catalogue row may later be deleted, and the
  -- snapshot is what prices the quote. The id is a back-reference, not the
  -- source of truth.
  irrigation_component_id uuid references public.irrigation_components(id) on delete set null,
  snapshot jsonb not null default '{}'::jsonb,
  -- Pieces or FEET, per snapshot.unit.
  quantity numeric not null default 1,
  created_at timestamptz not null default now()
);

comment on column public.estimate_components.snapshot is
  'Copy of the component at the time it was added. Re-pricing the catalogue must not move a sent quote.';
comment on column public.estimate_components.quantity is
  'Pieces or feet, per snapshot.unit. Meaningless without it.';

create index if not exists estimate_components_estimate_idx
  on public.estimate_components (estimate_id);

alter table public.estimate_components enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'estimate_components'
      and policyname = 'estimate_component_office_all') then
    create policy estimate_component_office_all on public.estimate_components
      for all using (tier_office_or_pm(organization_id))
      with check (tier_office_or_pm(organization_id));
  end if;
  if not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'estimate_components'
      and policyname = 'estimate_component_same_org_read') then
    create policy estimate_component_same_org_read on public.estimate_components
      for select using (same_org((select auth.uid()), organization_id));
  end if;
end $$;
