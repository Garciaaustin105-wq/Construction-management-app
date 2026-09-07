/**
 * What has to be BOUGHT for an estimate.
 *
 * The estimator already computes every quantity on a job and then drops them:
 * the contractor retypes the plant list into a supplier order by hand. This is
 * the missing link — the same measured quantities, expressed as things you can
 * put on an order.
 *
 * WHAT IT COVERS, and why the boundary sits where it does. Plants, sod, heads
 * and irrigation components are MATERIALS: someone sells them to you by the
 * each, the foot or the pallet. Labor is not bought from a supplier, and
 * equipment is owned or rented by time rather than purchased per job. Neither
 * belongs on a material order, and adding them later would turn a document a
 * supplier can quote against into a document nobody can.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. **Sod is bought in whole pallets.** You pay for the pallet, not for the
 *    grass you lay. `SodEstimate.cost` is gross sqft x cost — what the JOB
 *    consumes — and the order costs more than that, by the leftover. Reporting
 *    the job figure as the order figure would under-order and under-budget
 *    every sod job by up to a full pallet.
 *
 * 2. **A missing pallet size is not a quantity of zero.** With no
 *    `sqft_per_pallet` there is no pallet count, and square feet are not
 *    orderable — no supplier sells 4,300 sq ft of sod. The line says it cannot
 *    be ordered and why, rather than showing a number that looks actionable.
 *
 * 3. **Unpriced is not free.** A catalogue row with no cost produces a line
 *    with no cost, counted separately and left out of the total. A total that
 *    silently swallowed them would read as a complete budget while missing
 *    money.
 *
 * NO OVERAGE IS INVENTED. Sod carries the org's own waste percentage because
 * cutting waste is a property of laying sod; nothing here adds a "few extra
 * fittings" factor to pipe or heads. How much spare an org carries is theirs to
 * decide, and a default would quietly inflate every order.
 *
 * Pure. No database. The I/O half lives in materialTakeoffData.ts.
 */

import type { EstimateArea } from "@/lib/estimateAreas";
import { readPlantSnapshot } from "@/lib/plantProducts";
import { readHeadSnapshot } from "@/lib/irrigationProducts";
import { isSodArea, sodEstimateForArea } from "@/lib/sodProducts";
import type { ComponentSnapshot } from "@/lib/irrigationSystem";

/** How the supplier sells it — never how the map measured it. */
export type MaterialUnit = "each" | "foot" | "pallet";

export type MaterialSource = "plant" | "sod" | "head" | "component";

export type MaterialLine = {
  /**
   * Catalogue row plus the COST it was quoted at. Two placements of the same
   * item at different costs (the catalogue was re-priced mid-estimate) stay two
   * lines, matching what the plant legend already does. Merging them would
   * produce a total nobody can reconcile against either price.
   */
  key: string;
  source: MaterialSource;
  label: string;
  /** Size, nozzle, grass type — whatever identifies which one to order. */
  detail: string | null;
  quantity: number;
  unit: MaterialUnit;
  /** What the org pays for ONE of them. 0 means unrecorded, not free. */
  unitCost: number;
  extendedCost: number;
  /** No cost on the catalogue row. Never treat as free. */
  unpriced: boolean;
  /** False when the quantity itself cannot be determined. See `note`. */
  orderable: boolean;
  /** Why this line cannot be ordered as it stands. Null when it can. */
  note: string | null;
};

export type MaterialTakeoff = {
  lines: MaterialLine[];
  /** Only lines that are BOTH priced and orderable. */
  total: number;
  unpricedCount: number;
  unorderableCount: number;
};

export type TakeoffInput = {
  areas: Pick<EstimateArea, "kind" | "meta" | "color" | "area_sqft">[];
  components: { snapshot: ComponentSnapshot; quantity: number }[];
};

const money = (n: number) => Math.round(n * 100) / 100;

const SOURCE_ORDER: Record<MaterialSource, number> = {
  plant: 0,
  sod: 1,
  head: 2,
  component: 3,
};

// One aggregator per material kind. They were one function until DeepSource put
// its cyclomatic complexity at 33 - four unrelated groupings sharing a body
// only because they share an output type. Split, each is readable on its own
// and the grouping key each uses is visible at a glance, which is the part that
// has to be right.

function plantLines(areas: TakeoffInput["areas"]): MaterialLine[] {
  // NOT buildPlantLegend, and the harness is what caught it. The legend groups
  // by product, size and SELLING price, because that is what appears on a
  // proposal. An order is denominated in what you PAY: two placements sold at
  // the same price but bought at different costs are one legend row and two
  // order lines, and using the legend here would extend the whole quantity at
  // whichever cost happened to be seen first.
  const buckets = new Map<string, { label: string; size: string; count: number; cost: number }>();
  for (const area of areas) {
    const s = readPlantSnapshot(area);
    if (!s) continue;
    const key = `${s.plant_product_id}|${s.size}|${s.cost}`;
    const found = buckets.get(key);
    if (found) {
      found.count += 1;
      continue;
    }
    buckets.set(key, { label: s.name, size: s.size, count: 1, cost: s.cost });
  }
  return [...buckets].map(([key, p]) => ({
    key: `plant:${key}`,
    source: "plant" as const,
    label: p.label,
    detail: p.size || null,
    quantity: p.count,
    unit: "each" as const,
    unitCost: p.cost,
    extendedCost: money(p.count * p.cost),
    unpriced: !(p.cost > 0),
    orderable: true,
    note: null,
  }));
}

function sodLines(areas: TakeoffInput["areas"]): MaterialLine[] {
  // Grouped by product and cost, then the PALLETS are summed. Summing pallets
  // per area rather than re-deriving from total sqft is deliberate: three beds
  // that each round up to a pallet need three pallets, and one calculation over
  // the combined area would order two.
  type Bucket = {
    label: string; grass: string; pallets: number; costPerSqft: number;
    sqftPerPallet: number; purchasedSqft: number; unresolved: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const area of areas.filter(isSodArea)) {
    const found = sodEstimateForArea(area);
    if (!found) continue;
    const { snapshot: s, estimate: e } = found;
    const key = `${s.sod_product_id}|${s.cost_per_sqft}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        label: s.name, grass: s.grass_type, pallets: 0,
        costPerSqft: s.cost_per_sqft, sqftPerPallet: e.sqftPerPallet,
        purchasedSqft: 0, unresolved: 0,
      };
      buckets.set(key, bucket);
    }
    if (e.pallets == null || e.purchasedSqft == null) {
      bucket.unresolved += 1;
      continue;
    }
    bucket.pallets += e.pallets;
    bucket.purchasedSqft = money(bucket.purchasedSqft + e.purchasedSqft);
  }
  return [...buckets].map(([key, b]) => {
    const orderable = b.unresolved === 0 && b.pallets > 0;
    return {
      key: `sod:${key}`,
      source: "sod" as const,
      label: b.label,
      detail: b.grass,
      quantity: orderable ? b.pallets : 0,
      unit: "pallet" as const,
      // A pallet price, not a square foot price - the line is denominated in
      // the thing being bought.
      unitCost: money(b.costPerSqft * b.sqftPerPallet),
      // What the PALLETS cost, which exceeds what the job lays.
      extendedCost: orderable ? money(b.purchasedSqft * b.costPerSqft) : 0,
      unpriced: !(b.costPerSqft > 0),
      orderable,
      note: orderable
        ? null
        : "Pallet size is not recorded for this sod, so a pallet count cannot be worked out. Square feet are not orderable - no farm sells a part pallet.",
    };
  });
}

function headLines(areas: TakeoffInput["areas"]): MaterialLine[] {
  // Grouped by nozzle row and cost. Arc does NOT split the line: you buy the
  // nozzle, and how far it is turned is set on site with a screwdriver.
  const buckets = new Map<string, { label: string; nozzle: string; count: number; cost: number }>();
  for (const area of areas) {
    const s = readHeadSnapshot(area);
    if (!s) continue;
    const key = `${s.irrigation_nozzle_id}|${s.cost}`;
    const found = buckets.get(key);
    if (found) {
      found.count += 1;
      continue;
    }
    buckets.set(key, { label: s.name, nozzle: s.nozzle, count: 1, cost: s.cost });
  }
  return [...buckets].map(([key, h]) => ({
    key: `head:${key}`,
    source: "head" as const,
    label: h.label,
    detail: h.nozzle || null,
    quantity: h.count,
    unit: "each" as const,
    unitCost: h.cost,
    extendedCost: money(h.count * h.cost),
    unpriced: !(h.cost > 0),
    orderable: true,
    note: null,
  }));
}

function componentLines(components: TakeoffInput["components"]): MaterialLine[] {
  const buckets = new Map<string, { label: string; unit: MaterialUnit; qty: number; cost: number }>();
  for (const c of components) {
    const s = c.snapshot;
    const qty = Number.isFinite(c.quantity) && c.quantity > 0 ? c.quantity : 0;
    if (qty <= 0) continue;
    const key = `${s.irrigation_component_id}|${s.cost}`;
    const found = buckets.get(key);
    if (found) {
      found.qty = money(found.qty + qty);
      continue;
    }
    buckets.set(key, {
      label: s.name,
      unit: s.unit === "foot" ? "foot" : "each",
      qty,
      cost: s.cost,
    });
  }
  return [...buckets].map(([key, c]) => ({
    key: `component:${key}`,
    source: "component" as const,
    label: c.label,
    detail: null,
    quantity: c.qty,
    unit: c.unit,
    unitCost: c.cost,
    extendedCost: money(c.qty * c.cost),
    unpriced: !(c.cost > 0),
    orderable: true,
    note: null,
  }));
}

export function buildMaterialTakeoff(input: TakeoffInput): MaterialTakeoff {
  const lines = [
    ...plantLines(input.areas),
    ...sodLines(input.areas),
    ...headLines(input.areas),
    ...componentLines(input.components),
  ];

  lines.sort((a, b) => {
    const d = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
    if (d !== 0) return d;
    const n = a.label.localeCompare(b.label);
    if (n !== 0) return n;
    return (a.detail ?? "").localeCompare(b.detail ?? "");
  });

  // A line that is unpriced or unorderable contributes nothing to the total and
  // is COUNTED instead, so the screen can say what the number is missing.
  let total = 0;
  let unpricedCount = 0;
  let unorderableCount = 0;
  for (const l of lines) {
    if (!l.orderable) unorderableCount += 1;
    if (l.unpriced) unpricedCount += 1;
    if (l.orderable && !l.unpriced) total += l.extendedCost;
  }

  return { lines, total: money(total), unpricedCount, unorderableCount };
}

/**
 * One sentence for the screen, or null when the take-off is complete.
 *
 * Reports what could not be used and why, rather than letting a confident total
 * stand for an incomplete one.
 */
export function takeoffWarning(t: MaterialTakeoff): string | null {
  const parts: string[] = [];
  if (t.unorderableCount > 0) {
    parts.push(
      `${t.unorderableCount} line${t.unorderableCount === 1 ? "" : "s"} cannot be ordered yet`
    );
  }
  if (t.unpricedCount > 0) {
    parts.push(
      `${t.unpricedCount} line${t.unpricedCount === 1 ? "" : "s"} have no cost recorded, so they are not in the total`
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join(", and ")}.`;
}

/** Sod surplus across the take-off: paid for, not laid. Real money. */
export function sodLeftoverSqft(input: TakeoffInput): number {
  let leftover = 0;
  for (const area of input.areas.filter(isSodArea)) {
    const found = sodEstimateForArea(area);
    if (!found || found.estimate.leftoverSqft == null) continue;
    leftover += found.estimate.leftoverSqft;
  }
  return money(leftover);
}
