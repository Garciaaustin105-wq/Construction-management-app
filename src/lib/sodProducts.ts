// Sod for the quick estimator.
//
// Sod is the odd one out among the catalogues: it is MEASURED in square feet,
// which the map already gives, but it is BOUGHT in whole pallets. That gap is
// the whole reason this file exists — a job needing 4,620 sq ft does not order
// 4,620 sq ft, it orders 11 pallets and pays for 4,950.
//
// Two numbers therefore matter and both must reach the estimator:
//   grossSqft   what has to be covered, after cutting waste
//   pallets     what to actually order, always rounded UP
// and the difference between them is leftover the org has already paid for.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EstimateArea } from "@/lib/estimateAreas";

export const GRASS_TYPES = [
  "st_augustine",
  "bermuda",
  "zoysia",
  "centipede",
  "bahia",
  "fescue",
  "bluegrass",
  "other",
] as const;

export type GrassType = (typeof GRASS_TYPES)[number];

export function isGrassType(v: unknown): v is GrassType {
  return typeof v === "string" && (GRASS_TYPES as readonly string[]).includes(v);
}

export type SodProduct = {
  id: string;
  organization_id: string;
  name: string;
  grass_type: GrassType;
  // VARIES BY FARM, commonly 400-500. It drives the order directly: at 4,620
  // sq ft, 400/pallet is 12 pallets and 500/pallet is 10. 0 means not
  // recorded, and sodEstimate refuses to guess a pallet count rather than
  // inventing one.
  sqft_per_pallet: number;
  cost_per_sqft: number;
  price_per_sqft: number;
  // MAN-minutes per 1000 sq ft, matching manMinutesPer1000Sqft in
  // src/lib/manHours.ts — the unit this app already reasons in for turf.
  install_minutes_per_1000_sqft: number;
  notes: string | null;
  active: boolean;
  created_at: string;
};

const SOD_COLUMNS =
  "id, organization_id, name, grass_type, sqft_per_pallet, cost_per_sqft, price_per_sqft, install_minutes_per_1000_sqft, notes, active, created_at";

export type NewSodProduct = {
  organization_id: string;
  name: string;
  grass_type: GrassType;
  sqft_per_pallet: number;
  cost_per_sqft: number;
  price_per_sqft: number;
  install_minutes_per_1000_sqft?: number;
  notes?: string | null;
};

export async function listSodProducts(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly = true
): Promise<{ data: SodProduct[]; error: string | null }> {
  let q = supabase.from("sod_products").select(SOD_COLUMNS).eq("organization_id", organizationId);
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("name", { ascending: true });
  return { data: (data as unknown as SodProduct[]) ?? [], error: error?.message ?? null };
}

export async function createSodProduct(
  supabase: SupabaseClient,
  product: NewSodProduct
): Promise<{ data: SodProduct | null; error: string | null }> {
  const { data, error } = await supabase
    .from("sod_products")
    .insert(product)
    .select(SOD_COLUMNS)
    .single();
  return { data: (data as unknown as SodProduct) ?? null, error: error?.message ?? null };
}

export async function updateSodProduct(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      SodProduct,
      | "name"
      | "grass_type"
      | "sqft_per_pallet"
      | "cost_per_sqft"
      | "price_per_sqft"
      | "install_minutes_per_1000_sqft"
      | "notes"
      | "active"
    >
  >
): Promise<string | null> {
  const { error } = await supabase.from("sod_products").update(patch).eq("id", id);
  return error?.message ?? null;
}

// ---------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------

export type SodEstimate = {
  // What the map measured.
  netSqft: number;
  // Extra to cover cuts around beds, curves and edges.
  wastePct: number;
  wasteSqft: number;
  // What has to be covered once cutting waste is allowed for.
  grossSqft: number;
  // Whole pallets to order — always rounded UP. Null when sqft_per_pallet is
  // not recorded: a pallet count guessed from an assumed farm size is worse
  // than no number, because it looks orderable.
  pallets: number | null;
  sqftPerPallet: number;
  // Sod actually bought (pallets x sqft each) and the surplus that leaves.
  purchasedSqft: number | null;
  // Paid for and not laid. Real money, and invisible unless it is shown.
  leftoverSqft: number | null;
  revenue: number;
  cost: number;
  manHours: number;
};

// Turns a measured area into an order.
//
// Priced on GROSS square feet, not on pallets: the customer is quoted the area
// covered plus the cutting allowance, which is how sod is normally sold. The
// pallet count is what to BUY. Those are deliberately different numbers, and
// the leftover between them is the org's, not the customer's.
export function sodEstimate(
  netSqft: number,
  product: Pick<
    SodProduct,
    "sqft_per_pallet" | "cost_per_sqft" | "price_per_sqft" | "install_minutes_per_1000_sqft"
  >,
  wastePct = 0
): SodEstimate {
  const net = Number.isFinite(netSqft) && netSqft > 0 ? netSqft : 0;
  const pct = Number.isFinite(wastePct) && wastePct > 0 ? wastePct : 0;
  const waste = Math.round(net * (pct / 100) * 100) / 100;
  const gross = Math.round((net + waste) * 100) / 100;

  const per = product.sqft_per_pallet;
  const hasPallet = Number.isFinite(per) && per > 0;
  const pallets = hasPallet && gross > 0 ? Math.ceil(gross / per) : null;
  const purchased = pallets != null ? Math.round(pallets * per * 100) / 100 : null;

  return {
    netSqft: net,
    wastePct: pct,
    wasteSqft: waste,
    grossSqft: gross,
    pallets,
    sqftPerPallet: hasPallet ? per : 0,
    purchasedSqft: purchased,
    leftoverSqft: purchased != null ? Math.round((purchased - gross) * 100) / 100 : null,
    revenue: Math.round(gross * product.price_per_sqft * 100) / 100,
    cost: Math.round(gross * product.cost_per_sqft * 100) / 100,
    manHours:
      Math.round(((gross / 1000) * product.install_minutes_per_1000_sqft / 60) * 100) / 100,
  };
}

// True when the pallet count could not be worked out. The UI must say the
// pallet size is missing rather than showing a blank where a number belongs.
export function palletSizeUnset(product: Pick<SodProduct, "sqft_per_pallet">): boolean {
  return !(product.sqft_per_pallet > 0);
}

// One line for the sod. Quantity is GROSS square feet — what the customer is
// billed for. internal_cost is per square foot, matching how jobProfitability
// reads it (quantity x internal_cost). Returns null when there is nothing to
// bill so a $0 sod line cannot reach a quote.
export function sodLineItem(
  name: string,
  est: SodEstimate,
  costPerSqft: number
): { description: string; quantity: number; unit: string; unit_price: number; internal_cost: number } | null {
  if (est.grossSqft <= 0) return null;
  const unitPrice = est.netSqft > 0 ? est.revenue / est.grossSqft : 0;
  if (!(unitPrice > 0)) return null;
  const waste = est.wastePct > 0 ? ` incl. ${est.wastePct}% cutting waste` : "";
  return {
    description: `${name} sod — ${est.grossSqft.toLocaleString()} sq ft${waste}`,
    quantity: est.grossSqft,
    unit: "SF",
    unit_price: Math.round(unitPrice * 10000) / 10000,
    internal_cost: costPerSqft,
  };
}

// ---------------------------------------------------------------------------
// Sod on an estimate
// ---------------------------------------------------------------------------

// Sod is attached to a MEASURED AREA — the polygon already drawn on the map —
// rather than placed as a point. The snapshot lives in that area's meta, same
// rule as plants and heads: re-pricing the catalogue must not move a quote
// already sent.
//
// sqft_per_pallet is COPIED here rather than read from the catalogue every
// time, and that is the point of this type. The catalogue holds what the org
// usually buys; the snapshot holds what THIS delivery actually was. A farm
// that ships 500 one week and 400 the next changes the order by two pallets on
// a 4,600 sq ft job, so the estimator has to be able to correct it per job
// without editing the catalogue for every future estimate.
export type SodSnapshot = {
  sod_product_id: string;
  name: string;
  grass_type: GrassType;
  // The assumption in force FOR THIS JOB. Seeded from the catalogue, editable.
  sqft_per_pallet: number;
  cost_per_sqft: number;
  price_per_sqft: number;
  install_minutes_per_1000_sqft: number;
  waste_pct: number;
};

export function sodSnapshot(
  product: SodProduct,
  wastePct = 0,
  sqftPerPalletOverride?: number
): SodSnapshot {
  const override =
    typeof sqftPerPalletOverride === "number" &&
    Number.isFinite(sqftPerPalletOverride) &&
    sqftPerPalletOverride > 0
      ? sqftPerPalletOverride
      : product.sqft_per_pallet;
  return {
    sod_product_id: product.id,
    name: product.name,
    grass_type: product.grass_type,
    sqft_per_pallet: override,
    cost_per_sqft: product.cost_per_sqft,
    price_per_sqft: product.price_per_sqft,
    install_minutes_per_1000_sqft: product.install_minutes_per_1000_sqft,
    waste_pct: Number.isFinite(wastePct) && wastePct > 0 ? wastePct : 0,
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

// Narrow, do not cast. A plant point, a bare measured area or a row written
// before this shape existed must read as "no sod", never as sod priced NaN.
export function readSodSnapshot(
  area: Pick<EstimateArea, "kind" | "meta">
): SodSnapshot | null {
  if (area.kind !== "area") return null;
  const m = area.meta as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return null;
  const id = m.sod_product_id;
  const name = m.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    sod_product_id: id,
    name,
    grass_type: isGrassType(m.grass_type) ? m.grass_type : "other",
    sqft_per_pallet: num(m.sqft_per_pallet),
    cost_per_sqft: num(m.cost_per_sqft),
    price_per_sqft: num(m.price_per_sqft),
    install_minutes_per_1000_sqft: num(m.install_minutes_per_1000_sqft),
    waste_pct: num(m.waste_pct),
  };
}

export function isSodArea(area: Pick<EstimateArea, "kind" | "meta">): boolean {
  return readSodSnapshot(area) !== null;
}

// The calculator for an area that already carries sod, using the pallet size
// recorded on THAT job rather than whatever the catalogue says today.
export function sodEstimateForArea(
  area: Pick<EstimateArea, "kind" | "meta" | "area_sqft">
): { snapshot: SodSnapshot; estimate: SodEstimate } | null {
  const snap = readSodSnapshot(area);
  if (!snap) return null;
  return { snapshot: snap, estimate: sodEstimate(area.area_sqft, snap, snap.waste_pct) };
}

// Says the assumption out loud. The pallet count is the number an estimator
// acts on, and it is only as good as this figure — so the UI shows this
// beside the count rather than leaving it implied.
//
// Never returns "0 sq ft per pallet": an unrecorded size is a missing answer,
// not a pallet that holds nothing.
export function describePallet(sqftPerPallet: number): string {
  if (!(sqftPerPallet > 0)) return "pallet size not set — enter what your farm ships";
  return `assuming ${Math.round(sqftPerPallet).toLocaleString()} sq ft per pallet`;
}
