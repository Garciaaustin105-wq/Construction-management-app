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
import { readPlantSnapshot, type PlantCategory } from "@/lib/plantProducts";

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
//
// 120 is here because it is real hardware, not a rounding: Rain Bird MPR rotor
// nozzle trees ship Q/T/H/F = 90/120/180/360, so a "T" nozzle has nowhere else
// to go. 270 stays for adjustable nozzles (R-VAN adjusts 45-270).
export const HEAD_ARCS = [90, 120, 180, 270, 360] as const;
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
  // PRESSURE. radius_ft is quoted AT a pressure; these say which, and where the
  // nozzle stops working. adjustedRadius() reads all three, and every one must
  // appear in NOZZLE_COLUMNS or it arrives undefined and the below-minimum
  // refusal never fires — see the comment there.
  rated_psi: number | null;
  min_psi: number | null;
  performance: PerfPoint[] | null;
  sort_order: number;
  active: boolean;
  created_at: string;
};

export type IrrigationWithNozzles = IrrigationProduct & { nozzles: IrrigationNozzle[] };

const PRODUCT_COLUMNS =
  "id, organization_id, name, category, color, notes, active, created_at";

// Must list every field on IrrigationNozzle — a column missing here arrives as
// undefined while the type still claims it is present.
//
// THIS COMMENT WAS ALREADY HERE AND THE LIST DRIFTED ANYWAY. rated_psi, min_psi
// and performance were live in the database for days while this string omitted
// them, so adjustedRadius() saw `undefined` for the minimum — and
// `undefined < min_psi` is false, so the below-minimum guard passed silently and
// returned a radius where it is required to refuse. That is the most dangerous
// outcome in this file and it was produced by three missing words in a string.
// e2e-irrigation-geometry.mjs now ASSERTS this list covers them; a comment was
// not enough, twice (see AREA_COLUMNS in estimateAreas.ts for the first time).
export const NOZZLE_COLUMNS =
  "id, organization_id, irrigation_product_id, nozzle, radius_ft, cost, unit_price, install_minutes, rated_psi, min_psi, performance, sort_order, active, created_at";

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
/**
 * Heads grouped the way a RATE is keyed: one row per nozzle in the catalogue.
 *
 * Deliberately NOT buildHeadLegend. That groups by arc and price because the
 * legend is what gets quoted, and a 90-degree head and a 360-degree head of the
 * same nozzle are two lines on a proposal. A rate does not care: the same
 * nozzle takes the same time to fit either way, and leaving them split would
 * hand the crew-feedback sample gate two observations for one job.
 */
export function headRateLines(
  areas: Pick<EstimateArea, "kind" | "meta">[]
): { nozzleId: string; label: string; count: number; minutes: number }[] {
  const rows = new Map<string, { nozzleId: string; label: string; count: number; minutes: number }>();
  for (const area of areas) {
    const s = readHeadSnapshot(area);
    if (!s) continue;
    const found = rows.get(s.irrigation_nozzle_id);
    if (found) {
      found.count += 1;
      found.minutes += s.install_minutes;
      continue;
    }
    rows.set(s.irrigation_nozzle_id, {
      nozzleId: s.irrigation_nozzle_id,
      label: `${s.name} — ${s.nozzle}`,
      count: 1,
      minutes: s.install_minutes,
    });
  }
  return [...rows.values()];
}

export function headLegendManHours(rows: HeadLegendRow[]): number {
  const minutes = rows.reduce((s, r) => s + r.total_minutes, 0);
  return Math.round((minutes / 60) * 100) / 100;
}

/**
 * Categories that throw water outward, and so have a radius at all.
 *
 * Drip and bubblers do NOT. Dripline emits along the tube and an emitter wets
 * the ground it sits on, so a radius of 0 on those rows is the correct value
 * rather than a missing one — 12 of the seeded rows are in exactly that state
 * on purpose.
 */
const THROWING_CATEGORIES: readonly HeadCategory[] = [
  "rotor",
  "spray",
  "mp_rotator",
  "other",
];

export function throwsWater(category: HeadCategory): boolean {
  return THROWING_CATEGORIES.includes(category);
}

/**
 * True when nothing that SHOULD have a radius has one. The UI must not draw
 * coverage then, and should say the catalogue is missing throw distances rather
 * than showing bare markers with no explanation.
 *
 * Drip and bubbler rows are excluded from the judgement entirely. Counting them
 * would make a drip-only plan report "no throw distances recorded" forever — a
 * warning that can never be actioned, because there is nothing to record. A
 * plan of nothing but dripline returns false: nothing is missing.
 */
export function radiusUnset(rows: HeadLegendRow[]): boolean {
  const relevant = rows.filter((r) => throwsWater(r.category));
  return relevant.length > 0 && relevant.every((r) => r.radius_ft <= 0);
}

// Heads placed at a price of zero. A starter catalogue ships with real
// manufacturer radii but NO prices — those are per-distributor and per-region,
// and inventing them would quote a job at nothing while looking complete.
// Unlike radius, a price of 0 is indistinguishable from a genuine freebie, so
// the UI has to surface this rather than the data model encoding it.
export function unpricedHeads(rows: HeadLegendRow[]): HeadLegendRow[] {
  return rows.filter((r) => r.unit_price <= 0);
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

// ---------------------------------------------------------------------------
// Drip at plants
// ---------------------------------------------------------------------------

// Drip is not a head with a small radius. It wets a basin, not an arc, so it
// draws NO coverage — and it is counted per plant rather than placed, because
// nobody is going to click four emitters around each of forty trees.
//
// The rule is per plant CATEGORY ("every tree gets 4, every shrub 1"), applied
// to what is already on the map. Placing a tree therefore prices its drip with
// no extra clicks, which is the whole point of a quick estimator. A specimen
// that needs more carries meta.emitter_count and overrides the rule.

export type DripEmitter = {
  irrigation_product_id: string;
  irrigation_nozzle_id: string;
  name: string;
  nozzle: string;
  cost: number;
  unit_price: number;
  // MAN-minutes per EMITTER, not per plant.
  install_minutes: number;
};

export type DripConfig = {
  emitter: DripEmitter | null;
  perCategory: Partial<Record<PlantCategory, number>>;
};

// estimates.drip_config is jsonb, so narrow it rather than casting. A job with
// no drip is the empty object and must read as "no drip", never as an emitter
// priced NaN.
export function readDripConfig(raw: unknown): DripConfig {
  const none: DripConfig = { emitter: null, perCategory: {} };
  if (!raw || typeof raw !== "object") return none;
  const o = raw as Record<string, unknown>;
  const e = o.emitter as Record<string, unknown> | undefined;
  const emitter: DripEmitter | null =
    e && typeof e === "object" && typeof e.irrigation_nozzle_id === "string"
      ? {
          irrigation_product_id:
            typeof e.irrigation_product_id === "string" ? e.irrigation_product_id : "",
          irrigation_nozzle_id: e.irrigation_nozzle_id,
          name: typeof e.name === "string" ? e.name : "Emitter",
          nozzle: typeof e.nozzle === "string" ? e.nozzle : "",
          cost: num(e.cost),
          unit_price: num(e.unit_price),
          install_minutes: num(e.install_minutes),
        }
      : null;
  const per: Partial<Record<PlantCategory, number>> = {};
  const rawPer = o.per_category as Record<string, unknown> | undefined;
  if (rawPer && typeof rawPer === "object") {
    for (const [k, v] of Object.entries(rawPer)) {
      const n = num(v);
      // A zero or negative count is "no drip on this category", which is the
      // same as absent. Storing it as 0 is fine; acting on it is not.
      if (n > 0) per[k as PlantCategory] = Math.round(n);
    }
  }
  return { emitter, perCategory: per };
}

export type DripTally = {
  emitters: number;
  // Plants that carried their own meta.emitter_count. Surfaced so the UI can
  // say the number is not purely the rule.
  overriddenPlants: number;
  plantsWithDrip: number;
  revenue: number;
  cost: number;
  manHours: number;
  byCategory: { category: PlantCategory; plants: number; emitters: number }[];
};

// Counts emitters from the plants ALREADY on the map. Reads the raw areas, not
// the plant legend: an override lives on one placed plant, and the legend has
// already grouped that plant in with its identical siblings.
export function dripTally(
  areas: Pick<EstimateArea, "id" | "kind" | "meta">[],
  config: DripConfig,
  // Plant area ids the estimator has chosen to drop, typically because
  // plantsInHeadCoverage showed them inside a head's throw. Passed in rather
  // than computed here: dropping an emitter is the estimator's decision, and
  // this function must not make it on its own.
  excludePlantIds?: ReadonlySet<string>
): DripTally {
  const empty: DripTally = {
    emitters: 0, overriddenPlants: 0, plantsWithDrip: 0,
    revenue: 0, cost: 0, manHours: 0, byCategory: [],
  };
  if (!config.emitter) return empty;

  const byCat = new Map<PlantCategory, { plants: number; emitters: number }>();
  let emitters = 0, overridden = 0, plants = 0;

  for (const area of areas) {
    const plant = readPlantSnapshot(area);
    if (!plant) continue;
    if (excludePlantIds?.has(area.id)) continue;
    const meta = area.meta as Record<string, unknown> | null | undefined;
    const rawOverride = meta && typeof meta === "object" ? meta.emitter_count : undefined;
    const hasOverride = typeof rawOverride === "number" || typeof rawOverride === "string";
    const n = hasOverride
      ? Math.max(0, Math.round(num(rawOverride)))
      : config.perCategory[plant.category] ?? 0;
    if (hasOverride) overridden += 1;
    if (n <= 0) continue;
    emitters += n;
    plants += 1;
    const c = byCat.get(plant.category) ?? { plants: 0, emitters: 0 };
    c.plants += 1;
    c.emitters += n;
    byCat.set(plant.category, c);
  }

  const em = config.emitter;
  return {
    emitters,
    overriddenPlants: overridden,
    plantsWithDrip: plants,
    revenue: Math.round(emitters * em.unit_price * 100) / 100,
    cost: Math.round(emitters * em.cost * 100) / 100,
    manHours: Math.round((emitters * em.install_minutes / 60) * 100) / 100,
    byCategory: [...byCat.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.emitters - a.emitters),
  };
}

// One line for all the emitters. Returns null when there is nothing to bill,
// so a $0 drip line cannot reach a customer quote.
export function dripLineItem(
  tally: DripTally,
  config: DripConfig
): { description: string; quantity: number; unit: string; unit_price: number; internal_cost: number } | null {
  if (!config.emitter || tally.emitters <= 0) return null;
  const em = config.emitter;
  const label = [em.name, em.nozzle].filter(Boolean).join(" ");
  return {
    description: `${label} drip emitters`.replace(/\s+/g, " ").trim(),
    quantity: tally.emitters,
    unit: "EA",
    unit_price: em.unit_price,
    internal_cost: em.cost,
  };
}

// ---------------------------------------------------------------------------
// Plants already inside a head's throw
// ---------------------------------------------------------------------------

// Compass bearing from `a` to `b`, degrees clockwise from north. Inverse of
// pointAtBearing, same planar model.
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dNorth = (b.lat - a.lat) * Math.PI / 180 * EARTH_R_M;
  const dEast =
    (b.lng - a.lng) * Math.PI / 180 * EARTH_R_M * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const deg = (Math.atan2(dEast, dNorth) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// Is `point` inside the wedge this head throws?
export function isWithinThrow(
  head: LatLng,
  snap: Pick<HeadSnapshot, "radius_ft" | "arc_deg" | "heading_deg">,
  point: LatLng
): boolean {
  if (!(snap.radius_ft > 0)) return false;
  if (distanceFt(head, point) > snap.radius_ft) return false;
  if (snap.arc_deg >= 360) return true;
  const sweep = (bearingDeg(head, point) - snap.heading_deg + 360) % 360;
  return sweep <= snap.arc_deg;
}

export type CoveredPlant = { plantAreaId: string; headName: string };

// Which placed PLANTS fall inside the throw of a placed HEAD.
//
// This is a MEASUREMENT, not a recommendation, and the difference matters. The
// app can say "this shrub is inside a rotor's arc" because that is geometry.
// It cannot say the shrub is therefore adequately watered — root zone, soil,
// species, run time and pressure all decide that, and they are the designer's
// call, not this tool's.
//
// So callers must SHOW this and let the estimator choose to drop those
// emitters. Nothing here may silently remove them: a tree that reads as
// covered but sits under a canopy the spray never reaches would quietly lose
// its drip, and nobody would see it happen.
export function plantsInHeadCoverage(
  areas: Pick<EstimateArea, "id" | "kind" | "meta" | "polygon">[]
): CoveredPlant[] {
  const heads: { at: LatLng; snap: HeadSnapshot }[] = [];
  for (const a of areas) {
    const snap = readHeadSnapshot(a);
    if (!snap) continue;
    const at = Array.isArray(a.polygon) ? a.polygon[0] : null;
    if (at) heads.push({ at, snap });
  }
  if (heads.length === 0) return [];

  const out: CoveredPlant[] = [];
  for (const a of areas) {
    if (!readPlantSnapshot(a)) continue;
    const at = Array.isArray(a.polygon) ? a.polygon[0] : null;
    if (!at) continue;
    const hit = heads.find((h) => isWithinThrow(h.at, h.snap, at));
    if (hit) out.push({ plantAreaId: a.id, headName: hit.snap.name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage report
// ---------------------------------------------------------------------------

// WHAT THIS IS, AND WHAT IT MUST NEVER BE READ AS.
//
// This measures GEOMETRY: which parts of a measured area fall inside the wedge
// of at least one placed head. That is a fact about a drawing, and the app can
// state it.
//
// It is NOT a verdict on whether the system waters adequately, and the gap
// between those two is wider than it looks. Irrigation is designed HEAD TO
// HEAD: every head's spray reaches the next head, which produces roughly 200%
// geometric overlap. That standard exists because a rotor or spray delivers
// very little water near the outer edge of its radius — the throw distance is
// where the water STOPS, not where it is still useful.
//
// So a plan whose circles merely touch measures 100% here and is under-watered
// in reality. A single "coverage score" would rate that layout perfectly,
// which is why this returns TWO numbers instead:
//
//   reachedPct   any head reaches it at all. Below 100 means real dry gaps.
//   overlapPct   TWO OR MORE heads reach it. The head-to-head proxy, and the
//                number a designer actually looks at.
//
// Still not a design check. Precipitation rate, matched nozzles, pressure,
// wind, slope and zone balancing decide whether a lawn gets water, and none of
// them are here. Report the measurement; never grade the system.

export type CoverageReport = {
  areaSqft: number;
  reachedSqft: number;
  reachedPct: number;
  overlapSqft: number;
  overlapPct: number;
  gapSqft: number;
  // Gap centres, sampled, so the UI can point at the dry spots rather than
  // only naming a percentage.
  gapPoints: LatLng[];
  headsConsidered: number;
  // Heads exist but none has a recorded throw. The report is meaningless then,
  // and "0% covered" would be a lie about the design rather than about the
  // catalogue.
  radiusMissing: boolean;
  cellFt: number;
};

// Planar feet relative to an origin — the same flat-earth model as the rest of
// this file, which at lawn scale is well below the error of a finger tap on
// satellite imagery.
function toFeet(origin: LatLng, p: LatLng): { x: number; y: number } {
  const latFt = (p.lat - origin.lat) * 364_000;
  const lngFt = (p.lng - origin.lng) * 364_000 * Math.cos((origin.lat * Math.PI) / 180);
  return { x: lngFt, y: latFt };
}

function pointInRing(pt: { x: number; y: number }, ring: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const straddles = a.y > pt.y !== b.y > pt.y;
    if (straddles && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Samples the measured area on a grid and counts how many heads reach each
// cell. `cellFt` trades resolution for work: 2 ft is about 1,000 cells on a
// 4,000 sq ft lawn — instant, and finer than any head edge is real.
export function coverageReport(
  polygon: LatLng[],
  heads: { at: LatLng; snap: Pick<HeadSnapshot, "radius_ft" | "arc_deg" | "heading_deg"> }[],
  cellFt = 2
): CoverageReport {
  const step = Number.isFinite(cellFt) && cellFt > 0 ? cellFt : 2;
  const radiusMissing = heads.length > 0 && heads.every((h) => !(h.snap.radius_ft > 0));
  const base: CoverageReport = {
    areaSqft: 0, reachedSqft: 0, reachedPct: 0, overlapSqft: 0, overlapPct: 0,
    gapSqft: 0, gapPoints: [], headsConsidered: heads.length,
    radiusMissing, cellFt: step,
  };
  if (!Array.isArray(polygon) || polygon.length < 3) return base;

  const origin = polygon[0];
  const ring = polygon.map((p) => toFeet(origin, p));
  const xs = ring.map((r) => r.x);
  const ys = ring.map((r) => r.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);

  let inside = 0, reached = 0, overlapped = 0;
  const gaps: LatLng[] = [];
  const usable = heads.filter((h) => h.snap.radius_ft > 0);

  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      if (!pointInRing({ x, y }, ring)) continue;
      inside++;
      if (usable.length === 0) continue;
      const at: LatLng = {
        lat: origin.lat + y / 364_000,
        lng: origin.lng + x / (364_000 * cosLat),
      };
      let hits = 0;
      for (const h of usable) {
        if (isWithinThrow(h.at, h.snap, at)) {
          hits++;
          if (hits >= 2) break;
        }
      }
      if (hits >= 1) reached++;
      if (hits >= 2) overlapped++;
      // Sample the gaps: a UI marking 400 dots is no more informative than one
      // marking 40, and the map has to stay readable.
      else if (gaps.length < 200 && inside % 3 === 0) gaps.push(at);
    }
  }

  const cellArea = step * step;
  const areaSqft = Math.round(inside * cellArea);
  const reachedSqft = Math.round(reached * cellArea);
  const pct = (n: number) => (inside > 0 ? Math.round((n / inside) * 1000) / 10 : 0);

  return {
    areaSqft,
    reachedSqft,
    reachedPct: pct(reached),
    overlapSqft: Math.round(overlapped * cellArea),
    overlapPct: pct(overlapped),
    gapSqft: Math.max(0, areaSqft - reachedSqft),
    gapPoints: gaps,
    headsConsidered: heads.length,
    radiusMissing,
    cellFt: step,
  };
}

// EVERY RADIUS IN THIS APP ASSUMES A DESIGN PRESSURE.
//
// Manufacturer throw figures are quoted at a stated pressure — 45 psi for the
// Rain Bird and Hunter lines seeded here. A house running lower throws
// SHORTER, and every circle on the map is then optimistic: the drawing shows
// coverage the system will not deliver, and the shortfall is invisible because
// nothing on screen knows the site's real pressure.
//
// This is the one caveat that has to reach the estimator BEFORE they buy, not
// after: heads are chosen from these radii, and a nozzle picked for 45 psi on
// a 30 psi house is the wrong part. Test static and working pressure at the
// site first.
export const PRESSURE_CAVEAT =
  "Throw distances assume the manufacturer's design pressure (45 psi for most lines here). Record a pressure test at the site BEFORE laying out the system — lower pressure throws shorter, and every circle above would be optimistic.";

// Reads the report for the UI. Deliberately descriptive, never a verdict:
// every line states what was MEASURED and leaves the judgement to the person
// holding the licence.
export function describeCoverage(r: CoverageReport): string[] {
  if (r.radiusMissing)
    return ["No throw distances recorded, so coverage cannot be measured — set them in the catalogue."];
  if (r.headsConsidered === 0) return ["No heads placed yet."];
  const out = [
    `${r.reachedPct}% of ${r.areaSqft.toLocaleString()} sq ft is inside at least one head's throw.`,
  ];
  if (r.gapSqft > 0) out.push(`${r.gapSqft.toLocaleString()} sq ft is not reached by any head.`);
  out.push(
    `${r.overlapPct}% is reached by two or more heads. Head-to-head layouts run far above this — spray delivers little water near the edge of its throw, so circles that merely touch are not the same as watered ground.`
  );
  out.push(PRESSURE_CAVEAT);
  return out;
}

// The heads on an estimate, ready for coverageReport.
export function headsForCoverage(
  areas: Pick<EstimateArea, "kind" | "meta" | "polygon">[]
): { at: LatLng; snap: HeadSnapshot }[] {
  const out: { at: LatLng; snap: HeadSnapshot }[] = [];
  for (const a of areas) {
    const snap = readHeadSnapshot(a);
    if (!snap) continue;
    const at = Array.isArray(a.polygon) ? a.polygon[0] : null;
    if (at) out.push({ at, snap });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Site pressure test
// ---------------------------------------------------------------------------

// A pressure test is RECORDED, never assumed, and it is recommended BEFORE
// laying out a system rather than after.
//
// The reason is mechanical: every radius in this app is a manufacturer figure
// quoted at a design pressure — 45 psi for the Rain Bird and Hunter lines
// seeded here. A site running below that throws SHORTER than every circle
// drawn on the map, and nothing on screen can tell, because the app has no way
// to know the site's pressure unless someone measures it and writes it down.
//
// Laying out first and testing later means the head count, the nozzle choice
// and the zone split were all decided against a number nobody checked.
//
// What this does NOT do: size zones, compute pressure loss, or say the system
// will work. It records two measurements and compares one of them against the
// pressure the catalogue radii assume. That comparison is arithmetic. Whether
// the design is sound is the licensed professional's call.

// The pressure the seeded manufacturer radii are quoted at. Rain Bird's
// recommended operating pressure for the R-VAN and 5000 lines, and Hunter's
// for MP Rotator, are both 45 psi.
export const CATALOGUE_DESIGN_PSI = 45;

export type PressureTest = {
  staticPsi: number | null;
  workingPsi: number | null;
  gpm: number | null;
  testedAt: string | null;
  notes: string | null;
};

export function readPressureTest(raw: {
  pressure_static_psi?: unknown;
  pressure_working_psi?: unknown;
  pressure_gpm?: unknown;
  pressure_tested_at?: unknown;
  pressure_notes?: unknown;
} | null | undefined): PressureTest {
  const n = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const x = typeof v === "string" ? Number(v) : v;
    return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
  };
  return {
    staticPsi: n(raw?.pressure_static_psi),
    workingPsi: n(raw?.pressure_working_psi),
    gpm: n(raw?.pressure_gpm),
    testedAt: typeof raw?.pressure_tested_at === "string" ? raw.pressure_tested_at : null,
    notes: typeof raw?.pressure_notes === "string" ? raw.pressure_notes : null,
  };
}

// True when no usable reading has been recorded. This is what the UI prompts
// on, and it should prompt BEFORE the layout, not at quote time.
export function pressureUntested(t: PressureTest): boolean {
  return t.staticPsi === null && t.workingPsi === null;
}

export type PressureVerdict = {
  status: "untested" | "at_or_above" | "below" | "static_only";
  // One line, stating the measurement and its consequence for the drawing.
  message: string;
  // How far below the catalogue's design pressure, when that is known.
  shortfallPsi: number | null;
  designPsi: number;
};

// Compares the RECORDED working pressure against the pressure the catalogue
// radii assume.
//
// Deliberately does not estimate a reduced radius. Throw does not fall off
// linearly with pressure, the curve differs per nozzle, and a number invented
// here would be exactly the false precision this whole file avoids. It says
// the site is short and by how much; the professional reads the manufacturer's
// chart for that pressure.
export function pressureVerdict(
  t: PressureTest,
  designPsi = CATALOGUE_DESIGN_PSI
): PressureVerdict {
  const design = Number.isFinite(designPsi) && designPsi > 0 ? designPsi : CATALOGUE_DESIGN_PSI;

  if (pressureUntested(t)) {
    return {
      status: "untested",
      message:
        `No pressure test recorded. Test static and working pressure at the site and record it BEFORE laying out the system — every throw distance here assumes ${design} psi, and a lower site throws shorter than the circles drawn.`,
      shortfallPsi: null,
      designPsi: design,
    };
  }

  if (t.workingPsi === null) {
    return {
      status: "static_only",
      message:
        `Static pressure recorded (${t.staticPsi} psi) but no WORKING pressure. Working pressure is the one that decides throw — static is measured with nothing flowing and always reads higher.`,
      shortfallPsi: null,
      designPsi: design,
    };
  }

  if (t.workingPsi >= design) {
    return {
      status: "at_or_above",
      message:
        `Working pressure ${t.workingPsi} psi, at or above the ${design} psi these throw distances assume.`,
      shortfallPsi: 0,
      designPsi: design,
    };
  }

  const short = Math.round((design - t.workingPsi) * 10) / 10;
  return {
    status: "below",
    message:
      `Working pressure ${t.workingPsi} psi is ${short} psi BELOW the ${design} psi these throw distances assume. Every head will throw shorter than drawn — check the manufacturer chart at ${t.workingPsi} psi before choosing nozzles.`,
    shortfallPsi: short,
    designPsi: design,
  };
}

// How old the reading is, in days. Null when never tested — the UI must show
// that as "not tested", never as "0 days old".
export function pressureAgeDays(t: PressureTest): number | null {
  if (!t.testedAt) return null;
  const then = Date.parse(t.testedAt);
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Throw at a measured pressure
// ---------------------------------------------------------------------------
// Written by gpt-oss:20b from a spec, verified by running. See the harness
// section "throw at a measured pressure".
export type PerfPoint = { psi: number; radius_ft: number; gpm?: number };

export type AdjustedRadius = {
  // The radius to use, or NULL when no defensible figure exists.
  radiusFt: number | null;
  // How it was arrived at, so the UI can say so.
  method: "chart" | "interpolated" | "scaled" | "below_minimum" | "unknown";
  // One sentence for the UI, stating what was done and any caveat.
  note: string;
  // The pressure the figure applies to.
  psi: number;
};

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Interpolates a radius from a manufacturer's performance chart.
 *
 * - Requires at least two valid points.
 * - Exact psi match returns that point's radius.
 * - Linear interpolation between two points.
 * - Above the highest point returns the highest radius (no upward extrapolation).
 *   Manufacturers flatten out and inventing more throw is the dangerous direction.
 * - Below the lowest point returns null (refusal to extrapolate below the chart).
 */
export function interpolateRadius(points: PerfPoint[], psi: number): number | null {
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(psi)) {
    return null;
  }
  const valid = points.filter(p => Number.isFinite(p.psi) && Number.isFinite(p.radius_ft));
  if (valid.length < 2) {
    return null;
  }
  const sorted = [...valid].sort((a, b) => a.psi - b.psi);

  // Exact match
  for (const p of sorted) {
    if (p.psi === psi) {
      return round1(p.radius_ft);
    }
  }

  // Below lowest point
  if (psi < sorted[0].psi) {
    return null;
  }

  // Above highest point – cap at highest radius
  if (psi > sorted[sorted.length - 1].psi) {
    return round1(sorted[sorted.length - 1].radius_ft);
  }

  // Interpolate between two points
  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    if (psi > p1.psi && psi < p2.psi) {
      const t = (psi - p1.psi) / (p2.psi - p1.psi);
      const radius = p1.radius_ft + t * (p2.radius_ft - p1.radius_ft);
      return round1(radius);
    }
  }

  return null;
}

/**
 * Adjusts a nozzle's radius based on site pressure.
 *
 * Follows the strict order of preference:
 * 1. No pressure recorded → use rated figure as-is.
 * 2. No throw distance recorded → unknown.
 * 3. Below minimum operating pressure → refuse to return a radius.
 * 4. Manufacturer chart available → use chart or interpolated value.
 * 5. Scale from rated figure using exponent 0.125.
 *    Exponent 0.125 derived from Hunter PGP data: 2.6× pressure for 11% more throw,
 *    giving ~P^0.12; we use 0.125 for simplicity.
 * 6. No rated pressure → unknown.
 */
export function adjustedRadius(
  nozzle: {
    radius_ft: number;
    rated_psi?: number | null;
    min_psi?: number | null;
    performance?: PerfPoint[] | null;
  },
  workingPsi: number | null
): AdjustedRadius {
  const create = (
    radiusFt: number | null,
    method: AdjustedRadius["method"],
    note: string
  ): AdjustedRadius => ({
    radiusFt,
    method,
    note,
    psi: workingPsi ?? 0,
  });

  // 1. No pressure recorded
  if (!Number.isFinite(workingPsi) || workingPsi === null || workingPsi <= 0) {
    return create(nozzle.radius_ft, "unknown", "No pressure has been recorded; showing the rated figure as-is.");
  }

  // 2. No throw distance recorded
  if (!Number.isFinite(nozzle.radius_ft) || nozzle.radius_ft <= 0) {
    return create(null, "unknown", "No throw distance is recorded for this nozzle.");
  }

  // 3. Below minimum operating pressure – refuse to extrapolate
  if (typeof nozzle.min_psi === "number" && Number.isFinite(nozzle.min_psi) && workingPsi < nozzle.min_psi) {
    return create(
      null,
      "below_minimum",
      `Below the ${nozzle.min_psi} psi minimum; the nozzle will not perform as designed (rotor may not rotate, spray may mist). A different nozzle or a booster is needed.`
    );
  }

  // 4. Manufacturer chart
  if (Array.isArray(nozzle.performance) && nozzle.performance.length >= 2) {
    const chartRadius = interpolateRadius(nozzle.performance, workingPsi);
    if (chartRadius !== null) {
      const method: AdjustedRadius["method"] = nozzle.performance.some(p => p.psi === workingPsi) ? "chart" : "interpolated";
      return create(chartRadius, method, "Radius derived from the manufacturer chart.");
    }
  }

  // 5. Scale from rated figure
  if (typeof nozzle.rated_psi === "number" && Number.isFinite(nozzle.rated_psi) && nozzle.rated_psi > 0) {
    const scaled = round1(nozzle.radius_ft * Math.pow(workingPsi / nozzle.rated_psi, 0.125));
    return create(scaled, "scaled", "Estimated radius from the rated figure; the manufacturer chart is the authority.");
  }

  // 6. Unknown rated pressure
  return create(nozzle.radius_ft, "unknown", "Rated pressure is unknown; the figure cannot be adjusted.");
}

/**
 * Returns the note for display. No extra text is added.
 */
export function describeAdjustment(a: AdjustedRadius): string {
  return a.note;
}

/* ── Throw distances the catalogue does not ship ──────────────────────────── */

/**
 * Orgs contributing figures for nozzles that shipped blank.
 *
 * 27 throwing nozzles have no radius because their manufacturer charts are not
 * reachable — Toro T5, K-Rain PROPLUS, Irritrol 700 and the rotary sets. The
 * people who install them have the charts on the box. This is how that gets
 * back into the shipped catalogue.
 *
 * OPT-IN, ALWAYS. Submitting is a deliberate act, never a side effect of an org
 * editing its own catalogue. Capturing what someone typed without asking would
 * be taking their data, and it is the same rule that governs prices and rates:
 * the values are theirs.
 *
 * `source_note` is the point of the record, not a nicety. A number with no
 * provenance cannot be folded into a shipped catalogue — that would be exactly
 * the guessing refused everywhere else in this project.
 */
export type NozzleSuggestion = {
  id: string;
  organization_id: string;
  model_name: string;
  nozzle_name: string;
  radius_ft: number;
  rated_psi: number | null;
  min_psi: number | null;
  source_note: string | null;
  status: string;
  created_at: string;
};

export type NewNozzleSuggestion = {
  organization_id: string;
  model_name: string;
  nozzle_name: string;
  radius_ft: number;
  rated_psi?: number | null;
  min_psi?: number | null;
  source_note?: string | null;
};

const SUGGESTION_COLUMNS =
  "id, organization_id, model_name, nozzle_name, radius_ft, rated_psi, min_psi, source_note, status, created_at";

/**
 * Is this figure worth recording?
 *
 * A suggestion with no radius is nothing, and one with no source cannot be
 * acted on — it would have to be verified from scratch, at which point the
 * suggestion saved nobody any work. Both are refused with a reason rather than
 * stored and quietly ignored later.
 */
export function suggestionProblem(s: NewNozzleSuggestion): string | null {
  if (!(s.radius_ft > 0)) {
    return "Enter the throw distance before sharing it.";
  }
  if (!s.source_note || s.source_note.trim().length < 3) {
    return "Say where the figure came from — a catalogue page, the box, a distributor sheet. A number with no source cannot be added to the shipped catalogue.";
  }
  return null;
}

export async function submitNozzleSuggestion(
  supabase: SupabaseClient,
  s: NewNozzleSuggestion
): Promise<{ data: NozzleSuggestion | null; error: string | null }> {
  const problem = suggestionProblem(s);
  if (problem) return { data: null, error: problem };

  const { data, error } = await supabase
    .from("nozzle_suggestions")
    .insert({
      organization_id: s.organization_id,
      model_name: s.model_name,
      nozzle_name: s.nozzle_name,
      radius_ft: s.radius_ft,
      rated_psi: s.rated_psi ?? null,
      min_psi: s.min_psi ?? null,
      source_note: (s.source_note ?? "").trim() || null,
    })
    .select(SUGGESTION_COLUMNS)
    .single();

  return {
    data: (data as unknown as NozzleSuggestion) ?? null,
    error: error?.message ?? null,
  };
}

export async function listNozzleSuggestions(
  supabase: SupabaseClient,
  organizationId: string
): Promise<{ data: NozzleSuggestion[]; error: string | null }> {
  const { data, error } = await supabase
    .from("nozzle_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  return {
    data: (data as unknown as NozzleSuggestion[]) ?? [],
    error: error?.message ?? null,
  };
}

/**
 * The standing caution on every seeded throw distance.
 *
 * Rendered on the catalogue screen rather than buried in a doc, because the
 * figures LOOK authoritative — they came off manufacturer charts — and three
 * things can still make them wrong for a given org:
 *
 *   - nozzle lines get revised, and a catalogue seeded once does not follow
 *   - adjustable nozzles were seeded at the TOP of their range, which is what
 *     they throw opened up, not what they throw as spaced
 *   - every figure is at a stated pressure the site may not have
 */
export const THROW_VERIFY_NOTE =
  "These throw distances came from manufacturer charts and are a starting point, not gospel. Check them against the nozzles you actually stock: product lines get revised, adjustable nozzles are recorded at the top of their range, and every figure is quoted at a pressure your site may not run.";
