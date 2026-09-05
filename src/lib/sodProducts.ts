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
