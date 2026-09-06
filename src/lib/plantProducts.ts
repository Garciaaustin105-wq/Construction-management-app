// Plants and trees for the quick estimator — phase 2 of
// docs/quick-estimator-roadmap.md.
//
// THREE things live here and they are deliberately separate:
//
//   1. The SPECIES (`plant_products`) — "Dwarf Yaupon Holly". Identity only:
//      name, category, colour. No price.
//   2. The SIZES (`plant_product_sizes`) — "3 gal, costs me $9.50, I charge
//      $38". A species has several; each has its own cost and price, because a
//      30 gal tree is not a 1 gal shrub with a bigger number.
//   3. PLACEMENT — dropping a plant on the map. A placed plant is NOT a row in
//      either table; it is an `estimate_areas` row with kind="point", a
//      one-coordinate `polygon`, and a snapshot of the chosen size in `meta`.
//
// WHY A SNAPSHOT, NOT JUST IDS
//
// Re-pricing the catalogue in March must not silently change what a customer
// was quoted in January. This is the same call the chemical log makes when it
// denormalizes a product at log time. The ids are kept alongside the snapshot,
// so "which catalogue entry was this" is still answerable — they are just not
// the source of truth for price.
//
// MATERIAL AND LABOR ARE SEPARATE — read this before using any margin number
//
// `cost` is what the NURSERY charges you: material only. Labor is NOT in it
// and must never be faked into it.
//
// Lawn maintenance and landscape installs price labor differently, and only
// the first was modelled before. Maintenance prices the PROPERTY ($/sq ft) and
// crew size drives scheduling, not the quote. An install is a project priced
// in MAN-HOURS — two people for six hours is twelve — and a 30 gal tree is
// ~1.5 man-hours against five minutes for a 1 gal shrub. You cannot quote an
// install without estimating that up front, which is why `install_minutes`
// lives on the size.
//
// So there are two margins and they are not interchangeable:
//   plantLegendMargin  — MATERIAL only. Overstates profit worst on big trees,
//                        which is exactly where labor dominates.
//   estimateMargin     — material AND labor. The real number.
// Any UI showing the first has to label it material margin.
//
// Contract-first per the Claude-direct/local-AI split: the catalogue manager,
// the importer, the map's plant mode, and the legend all build against these
// exports rather than reaching into Supabase or re-deriving the math.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EstimateArea } from "@/lib/estimateAreas";

// App-validated, matching the DB comment. Not a CHECK constraint and not a
// TS enum — a plain list the picker renders and the writer validates against,
// so adding "vine" is a one-line change with no migration.
// Ordered canopy-down: buildPlantLegend sorts by this index so a legend reads
// the way a planting plan does. A vine sits after groundcover because it is
// the last thing installed and the last thing read.
export const PLANT_CATEGORIES = [
  "tree",
  "palm",
  "shrub",
  "perennial",
  "grass",
  "annual",
  "groundcover",
  "vine",
] as const;

export type PlantCategory = (typeof PLANT_CATEGORIES)[number];

export function isPlantCategory(v: unknown): v is PlantCategory {
  return typeof v === "string" && (PLANT_CATEGORIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export type PlantProduct = {
  id: string;
  organization_id: string;
  name: string;
  // Latin name. Optional — a landscape architect specs botanically, a
  // homeowner does not. Also the reliable key when importing a nursery list,
  // where common names vary by region.
  botanical_name: string | null;
  category: PlantCategory;
  color: string;
  notes: string | null;
  active: boolean;
  created_at: string;
};

export type PlantSize = {
  id: string;
  organization_id: string;
  plant_product_id: string;
  // As the nursery quotes it: "1 gal", "3 gal", "#5", "2in cal", "B&B".
  // Free text on purpose.
  size: string;
  // What you pay the nursery, per plant. Material only — see the header.
  cost: number;
  // What the customer pays per plant, installed.
  unit_price: number;
  // MAN-minutes to install one, not clock-minutes: two people for ten
  // minutes is 20. Per size because a 30 gal tree and a 1 gal shrub are not
  // remotely the same job. 0 means NOT ESTIMATED — render it as unset, never
  // as free.
  install_minutes: number;
  // Sizes have a real order that alphabetical sorting destroys ("15 gal"
  // sorts before "3 gal"). Ascending, smallest first.
  sort_order: number;
  active: boolean;
  created_at: string;
};

export type PlantWithSizes = PlantProduct & { sizes: PlantSize[] };

const PRODUCT_COLUMNS =
  "id, organization_id, name, botanical_name, category, color, notes, active, created_at";

// Must list every field on `PlantSize`. A column missing here arrives as
// undefined while the type still claims it is present — the exact silent bug
// that AREA_COLUMNS had with kind/length_ft/meta.
const SIZE_COLUMNS =
  "id, organization_id, plant_product_id, size, cost, unit_price, install_minutes, sort_order, active, created_at";

export type NewPlantProduct = {
  organization_id: string;
  name: string;
  category: PlantCategory;
  botanical_name?: string | null;
  color?: string;
  notes?: string | null;
};

export type NewPlantSize = {
  organization_id: string;
  plant_product_id: string;
  size: string;
  cost: number;
  unit_price: number;
  install_minutes?: number;
  sort_order?: number;
};

// One round trip, not one-per-species: the picker needs the whole catalogue
// and an N+1 here would be a query per plant on every estimate open.
export async function listPlantCatalogue(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly = true
): Promise<{ data: PlantWithSizes[]; error: string | null }> {
  let q = supabase
    .from("plant_products")
    .select(`${PRODUCT_COLUMNS}, plant_product_sizes(${SIZE_COLUMNS})`)
    .eq("organization_id", organizationId);
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("name", { ascending: true });
  if (error) return { data: [], error: error.message };

  const rows = (data ?? []) as unknown as (PlantProduct & {
    plant_product_sizes: PlantSize[] | null;
  })[];

  return {
    data: rows.map(({ plant_product_sizes, ...product }) => ({
      ...product,
      sizes: sortSizes((plant_product_sizes ?? []).filter((s) => !activeOnly || s.active)),
    })),
    error: null,
  };
}

// sort_order first, then insertion order. Deliberately NOT alphabetical by
// size — that is the bug this exists to avoid.
export function sortSizes(sizes: PlantSize[]): PlantSize[] {
  return [...sizes].sort(
    (a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)
  );
}

export async function createPlantProduct(
  supabase: SupabaseClient,
  product: NewPlantProduct
): Promise<{ data: PlantProduct | null; error: string | null }> {
  const { data, error } = await supabase
    .from("plant_products")
    .insert(product)
    .select(PRODUCT_COLUMNS)
    .single();
  return { data: (data as unknown as PlantProduct) ?? null, error: error?.message ?? null };
}

export async function updatePlantProduct(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      PlantProduct,
      "name" | "botanical_name" | "category" | "color" | "notes" | "active"
    >
  >
): Promise<string | null> {
  const { error } = await supabase.from("plant_products").update(patch).eq("id", id);
  return error?.message ?? null;
}

// Retire rather than delete. Placed plants carry their own snapshot so a hard
// delete would not corrupt any estimate — but the catalogue is also a record
// of what the org sells, and "we stopped carrying this" is worth keeping.
export async function deactivatePlantProduct(
  supabase: SupabaseClient,
  id: string
): Promise<string | null> {
  return updatePlantProduct(supabase, id, { active: false });
}

export async function createPlantSize(
  supabase: SupabaseClient,
  size: NewPlantSize
): Promise<{ data: PlantSize | null; error: string | null }> {
  const { data, error } = await supabase
    .from("plant_product_sizes")
    .insert(size)
    .select(SIZE_COLUMNS)
    .single();
  return { data: (data as unknown as PlantSize) ?? null, error: error?.message ?? null };
}

export async function updatePlantSize(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      PlantSize,
      "size" | "cost" | "unit_price" | "install_minutes" | "sort_order" | "active"
    >
  >
): Promise<string | null> {
  const { error } = await supabase.from("plant_product_sizes").update(patch).eq("id", id);
  return error?.message ?? null;
}

export async function deletePlantSize(
  supabase: SupabaseClient,
  id: string
): Promise<string | null> {
  const { error } = await supabase.from("plant_product_sizes").delete().eq("id", id);
  return error?.message ?? null;
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

// A nursery list gives you COST. Price is your markup on it. This is the
// multiplier form (2.5 = "two and a half times cost") because that is how the
// trade actually talks about it, not a percentage.
export function priceFromCost(cost: number, markupMultiple: number): number {
  if (!Number.isFinite(cost) || !Number.isFinite(markupMultiple)) return 0;
  return Math.round(cost * markupMultiple * 100) / 100;
}

// Material margin as a fraction of price. Returns null rather than 0 when
// there is no price to divide by — a caller must not render "0% margin" for
// "we do not know".
export function marginPct(cost: number, price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return (price - cost) / price;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

// What gets written into `estimate_areas.meta` when a plant is dropped.
// Everything needed to price and label the plant is here, so rendering a saved
// estimate never has to join back to the catalogue.
export type PlantSnapshot = {
  plant_product_id: string;
  plant_size_id: string;
  name: string;
  botanical_name: string | null;
  category: PlantCategory;
  size: string;
  cost: number;
  unit_price: number;
  // Snapshotted like the money is, and for the same reason: re-estimating the
  // install time next season must not change the man-hours on a quote already
  // sent.
  install_minutes: number;
  // Per-placement note ("specimen, face the street"), distinct from the
  // species' own notes. Blank on drop.
  note?: string;
};

export function plantSnapshot(product: PlantProduct, size: PlantSize): PlantSnapshot {
  return {
    plant_product_id: product.id,
    plant_size_id: size.id,
    name: product.name,
    botanical_name: product.botanical_name,
    category: product.category,
    size: size.size,
    cost: size.cost,
    unit_price: size.unit_price,
    install_minutes: size.install_minutes,
  };
}

function num(v: unknown): number {
  // `meta` is jsonb, so a number can arrive in either form: supabase-js hands
  // back a real number for a numeric COLUMN (verified in e2e-labor-settings),
  // but a value written into meta from a form field can land as a string.
  // Accept both, and refuse anything that is not a real number rather than
  // letting NaN into a price.
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

// `meta` is jsonb, so anything could be in it — including rows written before
// this shape existed, and rows belonging to a sprinkler head. Narrow, do not
// cast: a bad row must read as "not a plant", never as a plant priced NaN.
export function readPlantSnapshot(
  area: Pick<EstimateArea, "kind" | "meta">
): PlantSnapshot | null {
  if (area.kind !== "point") return null;
  const m = area.meta as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return null;
  const id = m.plant_product_id;
  const name = m.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    plant_product_id: id,
    plant_size_id: typeof m.plant_size_id === "string" ? m.plant_size_id : "",
    name,
    botanical_name: typeof m.botanical_name === "string" ? m.botanical_name : null,
    category: isPlantCategory(m.category) ? m.category : "shrub",
    size: typeof m.size === "string" ? m.size : "",
    cost: num(m.cost),
    unit_price: num(m.unit_price),
    install_minutes: num(m.install_minutes),
    note: typeof m.note === "string" ? m.note : undefined,
  };
}

export function isPlantArea(area: Pick<EstimateArea, "kind" | "meta">): boolean {
  return readPlantSnapshot(area) !== null;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

// The roadmap's requirement: "a legend built from what is actually placed —
// not a separate list to maintain." So the legend is derived, never stored.
export type PlantLegendRow = {
  // Groups by size AND by the snapshot price. Two placements of the same size
  // at different prices (catalogue re-priced mid-estimate) are two rows,
  // because merging them would report a total nobody can reconcile.
  key: string;
  name: string;
  botanical_name: string | null;
  category: PlantCategory;
  size: string;
  cost: number;
  unit_price: number;
  install_minutes: number;
  color: string;
  count: number;
  total: number;
  total_cost: number;
  // count x install_minutes. MAN-minutes, so this is directly summable across
  // rows regardless of how many people are on the crew.
  total_minutes: number;
};

export function buildPlantLegend(
  areas: Pick<EstimateArea, "kind" | "meta" | "color">[]
): PlantLegendRow[] {
  const rows = new Map<string, PlantLegendRow>();
  for (const area of areas) {
    const snap = readPlantSnapshot(area);
    if (!snap) continue;
    const key = `${snap.plant_product_id}|${snap.size}|${snap.unit_price}`;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      existing.total = existing.count * existing.unit_price;
      existing.total_cost = existing.count * existing.cost;
      existing.total_minutes = existing.count * existing.install_minutes;
      continue;
    }
    rows.set(key, {
      key,
      name: snap.name,
      botanical_name: snap.botanical_name,
      category: snap.category,
      size: snap.size,
      cost: snap.cost,
      unit_price: snap.unit_price,
      install_minutes: snap.install_minutes,
      color: area.color,
      count: 1,
      total: snap.unit_price,
      total_cost: snap.cost,
      total_minutes: snap.install_minutes,
    });
  }
  // Trees first, then by name: a legend reads the way a planting plan does,
  // canopy down to groundcover.
  const order = new Map<string, number>(PLANT_CATEGORIES.map((c, i) => [c, i]));
  return [...rows.values()].sort((a, b) => {
    const d = (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99);
    if (d !== 0) return d;
    const n = a.name.localeCompare(b.name);
    return n !== 0 ? n : a.size.localeCompare(b.size);
  });
}

export function plantLegendTotal(rows: PlantLegendRow[]): number {
  return rows.reduce((s, r) => s + r.total, 0);
}

export function plantLegendCost(rows: PlantLegendRow[]): number {
  return rows.reduce((s, r) => s + r.total_cost, 0);
}

// MATERIAL margin across the whole planting — see the header before showing
// this to anyone. Null when there is no price to divide by.
export function plantLegendMargin(rows: PlantLegendRow[]): number | null {
  return marginPct(plantLegendCost(rows), plantLegendTotal(rows));
}

// ---------------------------------------------------------------------------
// Install labor
// ---------------------------------------------------------------------------

// The three numbers a landscape estimate needs beyond the catalogue. Nothing
// here is computed — a person types them, and the org default exists only so
// they are typed once instead of once per quote.
export type LaborSettings = {
  // Billed per man-hour. Customer-facing.
  labor_rate: number | null;
  // Burdened cost per man-hour. Internal only.
  labor_cost_rate: number | null;
  // Fixed man-hours per job: drive both ways, unload, setup, cleanup,
  // haul-off. Null = not estimated (warn); 0 = genuinely none.
  mobilization_hours: number | null;
};

export type OrgLaborDefaults = {
  default_labor_rate: number | null;
  default_labor_cost_rate: number | null;
  default_mobilization_hours: number | null;
};

// Seed a NEW estimate from the org defaults.
//
// PREFILL, NOT REFERENCE — the caller writes the result onto the estimate's
// own columns, so changing the org default later never reprices a quote that
// already went out. Same snapshot rule the plant catalogue follows, and for
// the same reason: a customer's signed number must not move.
//
// Only for estimate CREATION. Calling it on an existing estimate would
// overwrite deliberate per-job overrides with the org default, which is the
// one way this could destroy real work.
export function laborSettingsFromDefaults(org: OrgLaborDefaults | null): LaborSettings {
  return {
    labor_rate: org?.default_labor_rate ?? null,
    labor_cost_rate: org?.default_labor_cost_rate ?? null,
    mobilization_hours: org?.default_mobilization_hours ?? null,
  };
}

// True when this estimate's numbers differ from the org default, i.e. the
// estimator deliberately changed something for this job. Drives the "save as
// my default" affordance — offering it when nothing changed is noise.
//
// Defaults are never auto-updated from the last estimate: one three-day
// out-of-town install would silently become the starting point for the next
// mow-and-go quote. Saving a default is a deliberate act.
export function laborDiffersFromDefaults(
  settings: LaborSettings,
  org: OrgLaborDefaults | null
): boolean {
  const d = laborSettingsFromDefaults(org);
  return (
    settings.labor_rate !== d.labor_rate ||
    settings.labor_cost_rate !== d.labor_cost_rate ||
    settings.mobilization_hours !== d.mobilization_hours
  );
}

// MAN-hours of planting alone, excluding mobilization. Man-hours, not
// clock-hours: how many people you send changes how long the day is, not how
// much labor the job contains, and the quote is priced on the latter.
//
// This is NOT the number to bill. See totalManHours.
export function plantLegendManHours(rows: PlantLegendRow[]): number {
  const minutes = rows.reduce((s, r) => s + r.total_minutes, 0);
  return Math.round((minutes / 60) * 100) / 100;
}

// The number to bill: planting PLUS mobilization.
//
// Mobilization is the fixed labor a job costs before anyone plants anything —
// drive out, unload, set up, clean up, haul off, drive back. Per-plant time
// alone quoted a one-shrub job at eight minutes, which is the failure this
// exists to close. At 200 shrubs the overhead vanishes into the noise; at one
// shrub it IS the job, and no per-item rate can express that.
export function totalManHours(
  rows: PlantLegendRow[],
  mobilizationHours: number | null
): number {
  const mob =
    mobilizationHours != null && Number.isFinite(mobilizationHours) && mobilizationHours > 0
      ? mobilizationHours
      : 0;
  return Math.round((plantLegendManHours(rows) + mob) * 100) / 100;
}

// Null mobilization means nobody estimated it — NOT that the job has none.
// Zero is a real answer (a crew already on site for another job); null is a
// missing one. Collapsing the two is how the small-job under-quote returns, so
// the UI must warn on this rather than coalescing silently.
export function mobilizationUnset(mobilizationHours: number | null): boolean {
  return mobilizationHours == null;
}

// How much of the billed labor is fixed overhead. Above ~50% the job is mostly
// driving and setup, which is the signal that a minimum charge should apply
// rather than an hourly quote — the classic "drove across town to plant one
// shrub" job. Null when there are no hours to divide by.
export function mobilizationShare(
  rows: PlantLegendRow[],
  mobilizationHours: number | null
): number | null {
  const total = totalManHours(rows, mobilizationHours);
  if (total <= 0) return null;
  const mob = mobilizationHours != null && mobilizationHours > 0 ? mobilizationHours : 0;
  return mob / total;
}

// True when nothing placed carries an install estimate. The caller must not
// render "0 hours" for this — it means nobody has filled in install_minutes,
// not that the work is free, and quoting labor at zero is how you lose the
// margin this whole feature exists to protect.
export function installTimeUnset(rows: PlantLegendRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.install_minutes <= 0);
}

// The customer-facing labor line. Separate from the plants by design: plants
// quote at their installed price, labor gets its own line so the customer sees
// what they are paying for.
//
// quantity = man-hours, unit_price = billed rate, internal_cost = burdened cost
// rate. That pairing is what makes jobProfitability compute labor margin with
// no new machinery — it already sums quantity x internal_cost.
//
// Returns null when there is nothing to bill, so a caller cannot accidentally
// put a $0 labor line on a quote.
export function laborLineItem(
  manHours: number,
  billRate: number | null,
  costRate: number | null
): { description: string; quantity: number; unit: string; unit_price: number; internal_cost: number } | null {
  if (!Number.isFinite(manHours) || manHours <= 0) return null;
  if (billRate == null || !Number.isFinite(billRate) || billRate <= 0) return null;
  const cost = costRate != null && Number.isFinite(costRate) && costRate > 0 ? costRate : 0;
  return {
    description: `Installation labor — ${manHours} man-hours`,
    quantity: manHours,
    unit: "HR",
    unit_price: billRate,
    internal_cost: cost,
  };
}

// The number that actually matters: margin across material AND labor.
//
// Deliberately returns the parts too. A single percentage hides which side is
// thin, and "your trees are underpriced" is the useful answer, not "62%".
// `mobilizationHours` is REQUIRED, not defaulted to 0. A caller that forgets
// it should fail to compile rather than silently under-quote every small job —
// which is exactly the bug this parameter was added to fix.
export function estimateMargin(
  rows: PlantLegendRow[],
  billRate: number | null,
  costRate: number | null,
  mobilizationHours: number | null
): {
  revenue: number;
  cost: number;
  materialRevenue: number;
  materialCost: number;
  laborRevenue: number;
  laborCost: number;
  manHours: number;
  plantManHours: number;
  mobilizationHours: number;
  mobilizationUnset: boolean;
  margin: number | null;
  laborPriced: boolean;
} {
  const materialRevenue = plantLegendTotal(rows);
  const materialCost = plantLegendCost(rows);
  const plantHours = plantLegendManHours(rows);
  const mob =
    mobilizationHours != null && Number.isFinite(mobilizationHours) && mobilizationHours > 0
      ? mobilizationHours
      : 0;
  const manHours = Math.round((plantHours + mob) * 100) / 100;
  const laborPriced = billRate != null && billRate > 0 && manHours > 0;
  const laborRevenue = laborPriced ? Math.round(manHours * billRate * 100) / 100 : 0;
  const laborCost =
    costRate != null && costRate > 0 && manHours > 0
      ? Math.round(manHours * costRate * 100) / 100
      : 0;
  const revenue = materialRevenue + laborRevenue;
  const cost = materialCost + laborCost;
  return {
    revenue,
    cost,
    materialRevenue,
    materialCost,
    laborRevenue,
    laborCost,
    manHours,
    plantManHours: plantHours,
    mobilizationHours: mob,
    // Surfaced so the UI can warn. Null is "not estimated", not "none".
    mobilizationUnset: mobilizationHours == null,
    margin: marginPct(cost, revenue),
    // False means the margin above is material-only and must be labelled as
    // such — either no rate is set or nothing carries an install estimate.
    laborPriced,
  };
}

// One line item per legend row, not per plant: a quote reading "Live Oak
// 30 gal — 4 @ $450" is what a customer expects, and 40 identical rows is not.
// `internal_cost` is PER-UNIT, not the row total: jobProfitability sums
// `quantity × internal_cost` (src/lib/insights.ts), so putting the extended
// cost here would multiply it by the count a second time.
export function plantLineItem(row: PlantLegendRow): {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  internal_cost: number;
} {
  const size = row.size ? ` ${row.size}` : "";
  return {
    description: `${row.name}${size}`,
    quantity: row.count,
    unit: "EA",
    unit_price: row.unit_price,
    internal_cost: row.cost,
  };
}
