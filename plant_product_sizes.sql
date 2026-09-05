-- Plant catalogue, take two: species and sizes are different things.
-- Supersedes the single-table shape in plant_products.sql (applied hours
-- earlier the same day, zero rows, no UI — which is why this restructures
-- rather than patches around it).
--
-- WHY THE SPLIT
--
-- A shrub is not one product. Dwarf Yaupon Holly is sold at 1 gal, 3 gal,
-- 7 gal and 15 gal, at four different costs and four different prices, and it
-- is one plant. Flattening that means:
--   * four rows to type, and four to fix when the name is misspelled
--   * a picker with 400 rows instead of 100
--   * no way to ask "what does this species cost me at each size"
-- So `plant_products` is now the SPECIES and holds no price at all, and
-- `plant_product_sizes` is what you actually buy and sell.
--
-- This also matches the shape of a nursery price list, which is exactly the
-- (species, size, cost) triple — so bulk import maps onto it directly instead
-- of having to invent the grouping.
--
-- WHY TWO MONEY COLUMNS
--
-- `cost` is what you pay the nursery. `unit_price` is what the customer pays,
-- installed. Both live on the SIZE because both differ by size — a 30 gal tree
-- is not a 1 gal shrub with a bigger number.
--
-- `cost` flows to `estimate_line_items.internal_cost`, which already exists and
-- which `jobProfitability` (src/lib/insights.ts) already reads. So plant margin
-- lands in the existing profitability report with no new machinery. Note what
-- that margin means: it is MATERIAL margin. Install labor is not in `cost` and
-- must not be faked into it — actual labor comes from crew time entries against
-- the job's labor_rate, which is how every other job in this app already works.
--
-- SAFETY: dropping `size` and `unit_price` off plant_products is safe here and
-- only here — verified 0 rows before running, and no deployed code reads them
-- (the only reader is src/lib/plantProducts.ts, updated in the same commit).
-- This is not a precedent for dropping columns on a live table.

alter table public.plant_products
  add column if not exists botanical_name text;

comment on column public.plant_products.botanical_name is
  'Latin name (Quercus virginiana). Optional — a landscape architect specs botanically, a homeowner does not. Also the reliable key when importing a nursery list, where common names vary by region.';

alter table public.plant_products drop column if exists size;
alter table public.plant_products drop column if exists unit_price;

comment on table public.plant_products is
  'The SPECIES. Identity only — name, category, colour. Carries no price: prices live on plant_product_sizes because they differ by size.';

create table if not exists public.plant_product_sizes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plant_product_id uuid not null references public.plant_products(id) on delete cascade,
  size text not null,
  cost numeric not null default 0,
  unit_price numeric not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.plant_product_sizes is
  'What an org actually buys and sells: one species at one container size, with its cost and its installed price.';

comment on column public.plant_product_sizes.organization_id is
  'Denormalized from the parent so RLS never needs a join. Matches how every other child table in this schema is scoped.';

comment on column public.plant_product_sizes.size is
  'As the nursery quotes it: "1 gal", "3 gal", "#5", "2in cal", "B&B", "45 box". Free text on purpose.';

comment on column public.plant_product_sizes.cost is
  'What you pay the nursery, per plant. Copied to estimate_line_items.internal_cost so the existing profitability report picks it up. MATERIAL cost only — install labor comes from crew time entries, not from here.';

comment on column public.plant_product_sizes.unit_price is
  'What the customer pays per plant, installed.';

comment on column public.plant_product_sizes.sort_order is
  'Sizes have a real order that alphabetical sorting destroys — "15 gal" sorts before "3 gal". Ascending, smallest first; ties fall back to created_at.';

-- Re-importing a nursery list must update the 3 gal row, not add a second one.
-- Without this the importer would need a read-then-branch per row, and would
-- still race. This is also the constraint an upsert targets.
create unique index if not exists plant_product_sizes_unique_size_idx
  on public.plant_product_sizes (plant_product_id, size);

-- "Every size for this species", which is how the picker and the size manager
-- both read.
create index if not exists plant_product_sizes_parent_idx
  on public.plant_product_sizes (plant_product_id, active);

-- "The org's whole size list", which is how import de-duplication reads.
create index if not exists plant_product_sizes_org_idx
  on public.plant_product_sizes (organization_id, active);

alter table public.plant_product_sizes enable row level security;

-- Identical to plant_products and to chemical_products before it: office and
-- PM maintain the catalogue, everyone in the org can read it.
drop policy if exists plant_size_office_all on public.plant_product_sizes;
create policy plant_size_office_all on public.plant_product_sizes
  for all using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

drop policy if exists plant_size_same_org_read on public.plant_product_sizes;
create policy plant_size_same_org_read on public.plant_product_sizes
  for select using (same_org((select auth.uid()), organization_id));
