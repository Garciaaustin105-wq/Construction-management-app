-- Sprinkler heads for the quick estimator — phase 4 of
-- docs/quick-estimator-roadmap.md.
--
-- SCOPE, and it is a business constraint not a technical one: this DRAWS and
-- PRICES what a professional places. It does not size a system. Head spacing,
-- GPM, pressure loss, zone balancing and backflow are licensed engineering.
-- Nothing here computes whether a system will actually work, and nothing in
-- the UI may imply it does — no coverage score, no gap warnings, no spacing
-- suggestions. Circles on a map look like a design tool; the moment one says
-- "94% covered", the liability for someone's system moves to this app.
--
-- SHAPE: deliberately identical to plant_products + plant_product_sizes,
-- because it is the same problem. A head MODEL comes in several NOZZLES, each
-- throwing a different radius at a different price — exactly as a species
-- comes in several container sizes. Same two-level editor, same snapshot rule,
-- same cost/price/install_minutes trio feeding the existing labor math.
--
-- WHERE THE ARC LIVES: on the PLACEMENT, not the catalogue. The same nozzle is
-- a 90 in a corner, a 180 along a fence and a 360 mid-lawn — it is a property
-- of where you put it, so it belongs in estimate_areas.meta, not here.
--
-- A placed head is an estimate_areas row with kind='point' and a snapshot in
-- meta, exactly like a plant. `kind` describes GEOMETRY; `meta` says what the
-- thing is. Anything reading points must therefore discriminate on meta and
-- never on kind alone.
--
-- Idempotent and additive: IF NOT EXISTS throughout, no DROP.

create table if not exists public.irrigation_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text not null default 'rotor',
  color text not null default '#0ea5e9',
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.irrigation_products is
  'Head MODELS an org installs (Rain Bird 5000, Hunter PGP, MP Rotator). Carries no radius or price: those differ per nozzle, which is what irrigation_product_nozzles holds.';

comment on column public.irrigation_products.category is
  'rotor | spray | mp_rotator | bubbler | drip | other. App-validated, deliberately not a CHECK, matching plant_products.';

create table if not exists public.irrigation_product_nozzles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  irrigation_product_id uuid not null references public.irrigation_products(id) on delete cascade,
  nozzle text not null,
  radius_ft numeric not null default 0,
  cost numeric not null default 0,
  unit_price numeric not null default 0,
  install_minutes integer not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.irrigation_product_nozzles is
  'What an org actually buys and installs: one head model with one nozzle, its throw radius, its cost and its installed price.';

comment on column public.irrigation_product_nozzles.nozzle is
  'As the manufacturer labels it: "3.0", "MP2000", "15-VAN", "#4". Free text, same reasoning as plant size.';

comment on column public.irrigation_product_nozzles.radius_ft is
  'THROW DISTANCE from the head outward, in feet - the number the manufacturer chart calls "radius", measured at the pressure the org designs for. A 30 ft head wets a circle 60 ft ACROSS. Entering the diameter here draws twice the real coverage and nothing downstream can detect it, so the UI label must say "from the head", not just "radius". 0 means not recorded: render as unset and draw no coverage.';

comment on column public.irrigation_product_nozzles.install_minutes is
  'MAN-minutes to install one head. Feeds the same labor math as plant install time — trenching and mainline are separate line items, not this.';

create unique index if not exists irrigation_nozzles_unique_idx
  on public.irrigation_product_nozzles (irrigation_product_id, nozzle);

create index if not exists irrigation_nozzles_parent_idx
  on public.irrigation_product_nozzles (irrigation_product_id, active);

create index if not exists irrigation_products_org_active_idx
  on public.irrigation_products (organization_id, active);

alter table public.irrigation_products enable row level security;
alter table public.irrigation_product_nozzles enable row level security;

-- Identical to plant_products and chemical_products before it.
drop policy if exists irrigation_product_office_all on public.irrigation_products;
create policy irrigation_product_office_all on public.irrigation_products
  for all using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

drop policy if exists irrigation_product_same_org_read on public.irrigation_products;
create policy irrigation_product_same_org_read on public.irrigation_products
  for select using (same_org((select auth.uid()), organization_id));

drop policy if exists irrigation_nozzle_office_all on public.irrigation_product_nozzles;
create policy irrigation_nozzle_office_all on public.irrigation_product_nozzles
  for all using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

drop policy if exists irrigation_nozzle_same_org_read on public.irrigation_product_nozzles;
create policy irrigation_nozzle_same_org_read on public.irrigation_product_nozzles
  for select using (same_org((select auth.uid()), organization_id));
