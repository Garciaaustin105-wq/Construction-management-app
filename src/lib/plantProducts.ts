// Plants and trees for the quick estimator — phase 2 of
// docs/quick-estimator-roadmap.md.
//
// Two things live here and they are deliberately separate:
//
//   1. The CATALOGUE (`plant_products`) — an org-maintained list the office
//      edits once: "Live Oak, 30 gal, $450". Modeled on `chemical_products`,
//      down to the RLS policy shape.
//   2. PLACEMENT — dropping a plant on the map. A placed plant is NOT a row
//      here; it is an `estimate_areas` row with kind="point", a one-coordinate
//      `polygon`, and a snapshot of the catalogue entry in `meta`.
//
// Why a snapshot instead of just the id: re-pricing the catalogue in March
// must not silently change what a customer was quoted in January. This is the
// same call the chemical log makes when it denormalizes a product at log time.
// The id is kept alongside it, so "which catalogue entry was this" is still
// answerable — it just is not the source of truth for price.
//
// Contract-first per the Claude-direct/local-AI split: the catalogue manager,
// the map's plant mode, and the legend all build against these exports rather
// than reaching into Supabase or re-deriving the grouping math.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EstimateArea } from "@/lib/estimateAreas";

// App-validated, matching the DB comment. Not a CHECK constraint and not a
// TS enum — a plain list the picker renders and the writer validates against,
// so adding "vine" is a one-line change with no migration.
export const PLANT_CATEGORIES = [
  "tree",
  "palm",
  "shrub",
  "perennial",
  "grass",
  "annual",
  "groundcover",
] as const;

export type PlantCategory = (typeof PLANT_CATEGORIES)[number];

export function isPlantCategory(v: unknown): v is PlantCategory {
  return typeof v === "string" && (PLANT_CATEGORIES as readonly string[]).includes(v);
}

export type PlantProduct = {
  id: string;
  organization_id: string;
  name: string;
  category: PlantCategory;
  // Free text on purpose: nurseries quote "30 gal", "#5", "2in cal", "B&B",
  // and there is no closed set worth fighting over.
  size: string | null;
  // Installed price per plant. One number, not material + labor — this is a
  // quick estimator, not a cost-accounting system.
  unit_price: number;
  color: string;
  notes: string | null;
  active: boolean;
  created_at: string;
};

const PLANT_COLUMNS =
  "id, organization_id, name, category, size, unit_price, color, notes, active, created_at";

export type NewPlantProduct = {
  organization_id: string;
  name: string;
  category: PlantCategory;
  size?: string | null;
  unit_price: number;
  color?: string;
  notes?: string | null;
};

// `activeOnly` is the default because every UI that picks a plant wants the
// live catalogue; only the manager screen wants to see retired entries.
export async function listPlantProducts(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly = true
): Promise<{ data: PlantProduct[]; error: string | null }> {
  let q = supabase
    .from("plant_products")
    .select(PLANT_COLUMNS)
    .eq("organization_id", organizationId);
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("name", { ascending: true });
  return { data: (data as unknown as PlantProduct[]) ?? [], error: error?.message ?? null };
}

export async function createPlantProduct(
  supabase: SupabaseClient,
  product: NewPlantProduct
): Promise<{ data: PlantProduct | null; error: string | null }> {
  const { data, error } = await supabase
    .from("plant_products")
    .insert(product)
    .select(PLANT_COLUMNS)
    .single();
  return { data: (data as unknown as PlantProduct) ?? null, error: error?.message ?? null };
}

export async function updatePlantProduct(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      PlantProduct,
      "name" | "category" | "size" | "unit_price" | "color" | "notes" | "active"
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

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

// What gets written into `estimate_areas.meta` when a plant is dropped. Every
// field needed to price and label the plant is here, so rendering a saved
// estimate never has to join back to the catalogue.
export type PlantSnapshot = {
  plant_product_id: string;
  name: string;
  category: PlantCategory;
  size: string | null;
  unit_price: number;
  // Per-placement note ("specimen, face the street"), distinct from the
  // catalogue's own notes. Blank on drop.
  note?: string;
};

export function plantSnapshot(p: PlantProduct): PlantSnapshot {
  return {
    plant_product_id: p.id,
    name: p.name,
    category: p.category,
    size: p.size,
    unit_price: p.unit_price,
  };
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
  const price = m.unit_price;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    plant_product_id: id,
    name,
    category: isPlantCategory(m.category) ? m.category : "shrub",
    size: typeof m.size === "string" ? m.size : null,
    unit_price: typeof price === "number" && Number.isFinite(price) ? price : 0,
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
  // Groups by product AND by the snapshot price. Two placements of the same
  // plant at different prices (catalogue re-priced mid-estimate) are two rows,
  // because merging them would report a total nobody can reconcile.
  key: string;
  name: string;
  category: PlantCategory;
  size: string | null;
  unit_price: number;
  color: string;
  count: number;
  total: number;
};

export function buildPlantLegend(
  areas: Pick<EstimateArea, "kind" | "meta" | "color">[]
): PlantLegendRow[] {
  const rows = new Map<string, PlantLegendRow>();
  for (const area of areas) {
    const snap = readPlantSnapshot(area);
    if (!snap) continue;
    const key = `${snap.plant_product_id}|${snap.size ?? ""}|${snap.unit_price}`;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      existing.total = existing.count * existing.unit_price;
      continue;
    }
    rows.set(key, {
      key,
      name: snap.name,
      category: snap.category,
      size: snap.size,
      unit_price: snap.unit_price,
      color: area.color,
      count: 1,
      total: snap.unit_price,
    });
  }
  // Trees first, then by name: a legend reads the way a planting plan does,
  // canopy down to groundcover.
  const order = new Map<string, number>(PLANT_CATEGORIES.map((c, i) => [c, i]));
  return [...rows.values()].sort((a, b) => {
    const d = (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}

export function plantLegendTotal(rows: PlantLegendRow[]): number {
  return rows.reduce((s, r) => s + r.total, 0);
}

// One line item per legend row, not per plant: a quote reading "Live Oak
// 30 gal — 4 @ $450" is what a customer expects, and 40 identical rows is not.
// Shape matches what LawnMeasurementMap's `onAddLineItem` already takes.
export function plantLineItem(row: PlantLegendRow): {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
} {
  const size = row.size ? ` ${row.size}` : "";
  return {
    description: `${row.name}${size}`,
    quantity: row.count,
    unit: "EA",
    unit_price: row.unit_price,
  };
}
