// Sprinkler heads for the quick estimator — phase 4 of
// docs/quick-estimator-roadmap.md.
//
// SCOPE — read before adding anything to this file. This DRAWS and PRICES what
// a professional places. It does not size a system. Head spacing, GPM,
// pressure loss, zone balancing and backflow are licensed engineering.
// Deliberately absent, and to stay absent: coverage percentages, gap warnings,
// spacing suggestions, "this zone is short" hints. Circles on a map already
// look like a design tool; the moment one reads "94% covered", liability for
// someone's irrigation system moves to this app.
//
// SHAPE: identical to plantProducts, because it is the same problem. A head
// MODEL comes in several NOZZLES at different radii and prices, exactly as a
// species comes in several container sizes. Same snapshot rule, same
// cost/price/install_minutes trio feeding the labor math already built.
//
// THE ARC LIVES ON THE PLACEMENT. The same nozzle is a 90 in a corner, a 180
// along a fence, a 360 mid-lawn — a property of where it is put, not of the
// part. So it is in the snapshot, not the catalogue.
//
// A placed head is an `estimate_areas` row with kind="point", exactly like a
// plant. `kind` describes GEOMETRY; `meta` says WHAT the thing is. Anything
// reading points must discriminate on meta and never on kind alone, or heads
// render as plants — see isIrrigationArea / isPlantArea.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EstimateArea, LatLng } from "@/lib/estimateAreas";

export const HEAD_CATEGORIES = [
  "rotor",
  "spray",
  "mp_rotator",
  "bubbler",
  "drip",
  "other",
] as const;

export type HeadCategory = (typeof HEAD_CATEGORIES)[number];

export function isHeadCategory(v: unknown): v is HeadCategory {
  return typeof v === "string" && (HEAD_CATEGORIES as readonly string[]).includes(v);
}

// The arcs a head is actually specified at. Free-form degrees would imply a
// precision this tool does not have and invite it to look like a design.
export const HEAD_ARCS = [90, 180, 270, 360] as const;
export type HeadArc = (typeof HEAD_ARCS)[number];

export function isHeadArc(v: unknown): v is HeadArc {
  return typeof v === "number" && (HEAD_ARCS as readonly number[]).includes(v);
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type IrrigationProduct = {
  id: string;
  organization_id: string;
  name: string;
  category: HeadCategory;
  color: string;
  notes: string | null;
  active: boolean;
  created_at: string;
};

export type IrrigationNozzle = {
  id: string;
  organization_id: string;
  irrigation_product_id: string;
  nozzle: string;
  // THROW DISTANCE from the head outward, in feet — the number the
  // manufacturer's chart calls "radius". A 30 ft head wets a circle 60 ft
  // ACROSS. Entering the diameter here draws twice the real coverage and
  // nothing downstream can detect it, so the field label must say "from the
  // head", not just "radius".
  //
  // 0 means NOT RECORDED — render as unset and draw no coverage, never a
  // zero-radius circle.
  radius_ft: number;
  cost: number;
  unit_price: number;
  install_minutes: number;
  sort_order: number;
  active: boolean;
  created_at: string;
};

export type IrrigationWithNozzles = IrrigationProduct & { nozzles: IrrigationNozzle[] };

const PRODUCT_COLUMNS =
  "id, organization_id, name, category, color, notes, active, created_at";

// Must list every field on IrrigationNozzle — a column missing here arrives as
// undefined while the type still claims it is present.
const NOZZLE_COLUMNS =
  "id, organization_id, irrigation_product_id, nozzle, radius_ft, cost, unit_price, install_minutes, sort_order, active, created_at";

export type NewIrrigationProduct = {
  organization_id: string;
  name: string;
  category: HeadCategory;
  color?: string;
  notes?: string | null;
};

export type NewIrrigationNozzle = {
  organization_id: string;
  irrigation_product_id: string;
  nozzle: string;
  radius_ft: number;
  cost: number;
  unit_price: number;
  install_minutes?: number;
  sort_order?: number;
};

export async function listIrrigationCatalogue(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly = true
): Promise<{ data: IrrigationWithNozzles[]; error: string | null }> {
  let q = supabase
    .from("irrigation_products")
    .select(`${PRODUCT_COLUMNS}, irrigation_product_nozzles(${NOZZLE_COLUMNS})`)
    .eq("organization_id", organizationId);
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("name", { ascending: true });
  if (error) return { data: [], error: error.message };

  const rows = (data ?? []) as unknown as (IrrigationProduct & {
    irrigation_product_nozzles: IrrigationNozzle[] | null;
  })[];
  return {
    data: rows.map(({ irrigation_product_nozzles, ...product }) => ({
      ...product,
      nozzles: sortNozzles(
        (irrigation_product_nozzles ?? []).filter((n) => !activeOnly || n.active)
      ),
    })),
    error: null,
  };
}

// sort_order then insertion order — never alphabetical, for the same reason
// plant sizes are not: "15-VAN" would sort before "3.0".
export function sortNozzles(nozzles: IrrigationNozzle[]): IrrigationNozzle[] {
  return [...nozzles].sort(
    (a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)
  );
}

export async function createIrrigationProduct(
  supabase: SupabaseClient,
  product: NewIrrigationProduct
): Promise<{ data: IrrigationProduct | null; error: string | null }> {
  const { data, error } = await supabase
    .from("irrigation_products")
    .insert(product)
    .select(PRODUCT_COLUMNS)
    .single();
  return { data: (data as unknown as IrrigationProduct) ?? null, error: error?.message ?? null };
}

export async function updateIrrigationProduct(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<IrrigationProduct, "name" | "category" | "color" | "notes" | "active">>
): Promise<string | null> {
  const { error } = await supabase.from("irrigation_products").update(patch).eq("id", id);
  return error?.message ?? null;
}

export async function createIrrigationNozzle(
  supabase: SupabaseClient,
  nozzle: NewIrrigationNozzle
): Promise<{ data: IrrigationNozzle | null; error: string | null }> {
  const { data, error } = await supabase
    .from("irrigation_product_nozzles")
    .insert(nozzle)
    .select(NOZZLE_COLUMNS)
    .single();
  return { data: (data as unknown as IrrigationNozzle) ?? null, error: error?.message ?? null };
}

export async function updateIrrigationNozzle(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      IrrigationNozzle,
      "nozzle" | "radius_ft" | "cost" | "unit_price" | "install_minutes" | "sort_order" | "active"
    >
  >
): Promise<string | null> {
  const { error } = await supabase.from("irrigation_product_nozzles").update(patch).eq("id", id);
  return error?.message ?? null;
}

export async function deleteIrrigationNozzle(
  supabase: SupabaseClient,
  id: string
): Promise<string | null> {
  const { error } = await supabase.from("irrigation_product_nozzles").delete().eq("id", id);
  return error?.message ?? null;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export type HeadSnapshot = {
  irrigation_product_id: string;
  irrigation_nozzle_id: string;
  name: string;
  category: HeadCategory;
  nozzle: string;
  radius_ft: number;
  // Chosen when placed, not from the catalogue.
  arc_deg: HeadArc;
  // Compass bearing the arc STARTS from, degrees clockwise from north. Only
  // meaningful when arc_deg < 360; a full circle ignores it.
  heading_deg: number;
  cost: number;
  unit_price: number;
  install_minutes: number;
  note?: string;
};

export function headSnapshot(
  product: IrrigationProduct,
  nozzle: IrrigationNozzle,
  arc: HeadArc = 360,
  heading = 0
): HeadSnapshot {
  return {
    irrigation_product_id: product.id,
    irrigation_nozzle_id: nozzle.id,
    name: product.name,
    category: product.category,
    nozzle: nozzle.nozzle,
    radius_ft: nozzle.radius_ft,
    arc_deg: arc,
    heading_deg: heading,
    cost: nozzle.cost,
    unit_price: nozzle.unit_price,
    install_minutes: nozzle.install_minutes,
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

// Narrow, do not cast. A plant, a pipe or a row written before this shape
// existed must read as "not a head" rather than as a head with NaN values.
export function readHeadSnapshot(
  area: Pick<EstimateArea, "kind" | "meta">
): HeadSnapshot | null {
  if (area.kind !== "point") return null;
  const m = area.meta as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return null;
  const id = m.irrigation_product_id;
  const name = m.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    irrigation_product_id: id,
    irrigation_nozzle_id: typeof m.irrigation_nozzle_id === "string" ? m.irrigation_nozzle_id : "",
    name,
    category: isHeadCategory(m.category) ? m.category : "other",
    nozzle: typeof m.nozzle === "string" ? m.nozzle : "",
    radius_ft: num(m.radius_ft),
    arc_deg: isHeadArc(num(m.arc_deg)) ? (num(m.arc_deg) as HeadArc) : 360,
    heading_deg: num(m.heading_deg),
    cost: num(m.cost),
    unit_price: num(m.unit_price),
    install_minutes: num(m.install_minutes),
    note: typeof m.note === "string" ? m.note : undefined,
  };
}

export function isIrrigationArea(area: Pick<EstimateArea, "kind" | "meta">): boolean {
  return readHeadSnapshot(area) !== null;
}

// ---------------------------------------------------------------------------
// Coverage geometry
// ---------------------------------------------------------------------------

const EARTH_R_M = 6371008.8;
const M_PER_FT = 0.3048;

// One point on the circle of `radiusFt` around `center`, at compass `bearing`
// (degrees clockwise from north).
//
// Planar approximation in metres, matching areaSqftFromPoints and
// lengthFtFromPoints elsewhere in this app: at sprinkler scale (tens of feet)
// the error against a great-circle solution is far below the accuracy of a
// finger tap on satellite imagery, and mixing two earth models across the same
// map would be worse than either.
// `radiusFt` is throw distance from the head, matching the manufacturer chart.
export function pointAtBearing(center: LatLng, radiusFt: number, bearingDeg: number): LatLng {
  const d = radiusFt * M_PER_FT;
  const br = (bearingDeg * Math.PI) / 180;
  const dNorth = d * Math.cos(br);
  const dEast = d * Math.sin(br);
  const dLat = (dNorth / EARTH_R_M) * (180 / Math.PI);
  // Longitude degrees shrink with latitude — the same cos(lat) term the rest
  // of the geometry in this app uses.
  const dLng =
    (dEast / (EARTH_R_M * Math.cos((center.lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat: center.lat + dLat, lng: center.lng + dLng };
}

// The polygon ring for a head's coverage.
//
// A 360 head is better drawn with google.maps.Circle — callers should check
// arc_deg === 360 first and use that. This exists for PART circles, which
// Google Maps has no primitive for: the ring is centre -> arc -> back to
// centre, i.e. a pie slice.
//
// Returns [] when there is nothing to draw, which includes radius 0 — an
// unrecorded radius must render as no coverage, never as a dot at the head.
export function coverageRing(
  center: LatLng,
  radiusFt: number,
  arcDeg: number,
  headingDeg: number,
  steps = 48
): LatLng[] {
  if (!Number.isFinite(radiusFt) || radiusFt <= 0) return [];
  if (!Number.isFinite(arcDeg) || arcDeg <= 0) return [];
  const arc = Math.min(arcDeg, 360);
  const n = Math.max(8, Math.round((steps * arc) / 360));
  const pts: LatLng[] = [];
  // A part-circle is a slice: start at the head itself so the two straight
  // edges are drawn, which is what makes a 90 read as a corner head.
  if (arc < 360) pts.push({ ...center });
  for (let i = 0; i <= n; i++) {
    pts.push(pointAtBearing(center, radiusFt, headingDeg + (arc * i) / n));
  }
  return pts;
}

// Spells out both numbers so the commonest data-entry error is visible at the
// moment of entry: "30 ft from the head - 60 ft across". Someone who meant the
// diameter sees 60 and corrects themselves. No validation can catch this,
// because 30 and 60 are both perfectly plausible radii.
export function describeThrow(radiusFt: number): string {
  if (!Number.isFinite(radiusFt) || radiusFt <= 0) return "throw not recorded";
  const r = Math.round(radiusFt * 10) / 10;
  return `${r} ft from the head · ${Math.round(r * 2 * 10) / 10} ft across`;
}

// Ground area a head covers, in square feet. A wedge of a circle.
//
// This is what the head WETS, and it is NOT a substitute for measuring the
// lawn: overlapping heads double-count, and that is correct here because two
// heads really do cost two heads. Never sum these and present the result as
// "area covered" — that is the design claim this tool does not make.
export function coverageSqft(radiusFt: number, arcDeg: number): number {
  if (!Number.isFinite(radiusFt) || radiusFt <= 0) return 0;
  const arc = Math.min(Math.max(arcDeg, 0), 360);
  return Math.round(Math.PI * radiusFt * radiusFt * (arc / 360) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

// Grouped by model + nozzle + arc: a 90 and a 360 of the same nozzle are
// different line items to a supplier only in quantity, but different to the
// installer in placement, and showing them apart is what makes the legend
// match what is on the plan.
export type HeadLegendRow = {
  key: string;
  name: string;
  category: HeadCategory;
  nozzle: string;
  radius_ft: number;
  arc_deg: HeadArc;
  cost: number;
  unit_price: number;
  install_minutes: number;
  color: string;
  count: number;
  total: number;
  total_cost: number;
  total_minutes: number;
};

export function buildHeadLegend(
  areas: Pick<EstimateArea, "kind" | "meta" | "color">[]
): HeadLegendRow[] {
  const rows = new Map<string, HeadLegendRow>();
  for (const area of areas) {
    const s = readHeadSnapshot(area);
    if (!s) continue;
    const key = `${s.irrigation_product_id}|${s.nozzle}|${s.arc_deg}|${s.unit_price}`;
    const found = rows.get(key);
    if (found) {
      found.count += 1;
      found.total = found.count * found.unit_price;
      found.total_cost = found.count * found.cost;
      found.total_minutes = found.count * found.install_minutes;
      continue;
    }
    rows.set(key, {
      key,
      name: s.name,
      category: s.category,
      nozzle: s.nozzle,
      radius_ft: s.radius_ft,
      arc_deg: s.arc_deg,
      cost: s.cost,
      unit_price: s.unit_price,
      install_minutes: s.install_minutes,
      color: area.color,
      count: 1,
      total: s.unit_price,
      total_cost: s.cost,
      total_minutes: s.install_minutes,
    });
  }
  const order = new Map<string, number>(HEAD_CATEGORIES.map((c, i) => [c, i]));
  return [...rows.values()].sort((a, b) => {
    const d = (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99);
    if (d !== 0) return d;
    const n = a.name.localeCompare(b.name);
    if (n !== 0) return n;
    return a.arc_deg - b.arc_deg;
  });
}

export function headLegendTotal(rows: HeadLegendRow[]): number {
  return rows.reduce((s, r) => s + r.total, 0);
}

export function headLegendCost(rows: HeadLegendRow[]): number {
  return rows.reduce((s, r) => s + r.total_cost, 0);
}

// MAN-hours to install every head placed. Feeds the same labor total as
// plants — trenching and mainline are separate line items, not this.
export function headLegendManHours(rows: HeadLegendRow[]): number {
  const minutes = rows.reduce((s, r) => s + r.total_minutes, 0);
  return Math.round((minutes / 60) * 100) / 100;
}

// True when nothing placed has a recorded radius. The UI must not draw
// coverage in that case, and should say the catalogue is missing radii rather
// than silently showing bare markers.
export function radiusUnset(rows: HeadLegendRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.radius_ft <= 0);
}

// One line per legend row. internal_cost is PER-UNIT, matching how
// jobProfitability reads it (quantity x internal_cost).
export function headLineItem(row: HeadLegendRow): {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  internal_cost: number;
} {
  const arc = row.arc_deg === 360 ? "full" : `${row.arc_deg}°`;
  const radius = row.radius_ft > 0 ? ` ${row.radius_ft}ft` : "";
  return {
    description: `${row.name} ${row.nozzle} ${arc}${radius}`.replace(/\s+/g, " ").trim(),
    quantity: row.count,
    unit: "EA",
    unit_price: row.unit_price,
    internal_cost: row.cost,
  };
}

// ---------------------------------------------------------------------------
// Pipe
// ---------------------------------------------------------------------------

// Straight-line ground distance between two points, in feet. Same planar model
// as the rest of this app's geometry (lengthFtFromPoints, areaSqftFromPoints):
// metres with a cos(lat) term on longitude.
export function distanceFt(a: LatLng, b: LatLng): number {
  const dLatM = ((b.lat - a.lat) * Math.PI / 180) * EARTH_R_M;
  const dLngM =
    ((b.lng - a.lng) * Math.PI / 180) * EARTH_R_M * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLatM, dLngM) / M_PER_FT;
}

export type PipeAllowances = {
  // How much longer the real trench is than a straight line: following beds,
  // skirting drives and hardscape, splitting into zones off a manifold.
  // Typically the LARGER of the two and the one people forget.
  routingPct?: number;
  // Cut-offs, breakage, mistakes — the ordinary material allowance.
  wastePct?: number;
};

export type PipeEstimate = {
  // Shortest total length that connects every head, straight line, no
  // obstacles. A FLOOR, not a prediction — see below.
  straightLineFt: number;
  // The straight line after the routing allowance: an estimate of the trench
  // that will actually be dug.
  routedFt: number;
  // routedFt after the waste allowance: the pipe to actually buy.
  totalFt: number;
  routingPct: number;
  wastePct: number;
  headCount: number;
  // The connections chosen, so the map can draw exactly what was measured
  // rather than leaving the number unexplained.
  segments: { from: LatLng; to: LatLng; ft: number }[];
};

// Connects every head with the least total pipe (Prim's minimum spanning
// tree over straight-line distances).
//
// WHAT THIS IS AND IS NOT — the UI must carry this, not just the code:
//
// It is the SHORTEST POSSIBLE pipe to link the heads placed. Real trench
// follows beds, skirts drives and hardscape, and splits into zones from a
// manifold, so the installed length is always LONGER. This is a floor to
// estimate from, never a claim about how the system will be plumbed.
//
// It also does NOT include the mainline from the point of connection, the
// backflow, or any run to the controller — none of those are placed on the
// map, so none of them are in this number.
//
// TWO allowances, kept apart on purpose. They are different quantities and
// folding them into one number is how pipe gets under-bought:
//
//   routingPct — how much longer the real trench is than the straight line.
//                Often 20-40%, and the one estimators forget.
//   wastePct   — cut-offs and breakage. The familiar 5-10% figure.
//
// They COMPOUND rather than add: routing lengthens the run that actually gets
// dug, and waste is then the over-buy on that longer run. 30% and 10% is
// 1.30 x 1.10 = 1.43, not 1.40.
//
// Passed as an object, not two numbers, because (30, 10) and (10, 30) are
// both plausible and swapping them silently under-buys by a third.
export function pipeEstimate(heads: LatLng[], allowances: PipeAllowances = {}): PipeEstimate {
  const clean = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const routingPct = clean(allowances.routingPct);
  const wastePct = clean(allowances.wastePct);
  const empty: PipeEstimate = {
    straightLineFt: 0, routedFt: 0, totalFt: 0, routingPct, wastePct,
    headCount: heads.length, segments: [],
  };
  if (heads.length < 2) return empty;

  const inTree = new Array(heads.length).fill(false);
  const segments: PipeEstimate["segments"] = [];
  inTree[0] = true;
  let total = 0;

  for (let added = 1; added < heads.length; added++) {
    let best = { from: -1, to: -1, ft: Infinity };
    for (let i = 0; i < heads.length; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < heads.length; j++) {
        if (inTree[j]) continue;
        const ft = distanceFt(heads[i], heads[j]);
        if (ft < best.ft) best = { from: i, to: j, ft };
      }
    }
    if (best.to === -1) break;
    inTree[best.to] = true;
    total += best.ft;
    segments.push({ from: heads[best.from], to: heads[best.to], ft: Math.round(best.ft * 10) / 10 });
  }

  const straight = Math.round(total * 10) / 10;
  const routed = straight * (1 + routingPct / 100);
  return {
    straightLineFt: straight,
    routedFt: Math.round(routed * 10) / 10,
    totalFt: Math.round(routed * (1 + wastePct / 100) * 10) / 10,
    routingPct,
    wastePct,
    headCount: heads.length,
    segments,
  };
}

// The head coordinates on an estimate, in placement order, ready for
// pipeEstimate. Ignores plants and polygons by reading the meta.
export function headPoints(
  areas: Pick<EstimateArea, "kind" | "meta" | "polygon">[]
): LatLng[] {
  const pts: LatLng[] = [];
  for (const a of areas) {
    if (!readHeadSnapshot(a)) continue;
    const p = Array.isArray(a.polygon) ? a.polygon[0] : null;
    if (p) pts.push(p);
  }
  return pts;
}
