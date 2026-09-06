import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Labor lines that are not plants, sod, heads or irrigation parts: mulch,
 * edging, bed prep, grading, demolition, haul-off, drainage, cleanup.
 *
 * THIS FILE IS MATH AND UNITS. Every figure an estimate uses is entered by the
 * org. The published research lives in LABOR_BENCHMARKS below and is shown
 * BESIDE a field as a suggestion — it is never written into a row, never used
 * as a default, and never used in a calculation. Borrowed production rates are
 * the wrong long-term answer for a crew that has its own; the org decides.
 *
 * See docs/labor-production-rates.md for where the benchmark figures came from.
 */

/**
 * The scope rule, for the catalogue screen to render. Sod, plant and irrigation
 * labor are ALREADY priced by their own catalogues; a row here that repeats one
 * of them bills the same man-hours twice. Removal is a different task from
 * installation and belongs here. Installation does not.
 */
export const LABOR_SCOPE_NOTE =
  "Sod, plant and irrigation labor are priced by their own catalogues. Adding them here would bill the same hours twice. Removal and disposal are different tasks and do belong here.";

export const LABOR_CATEGORIES = [
  "bed_prep", "mulch", "edging", "grading", "demolition", "haul_off",
  "drainage", "cleanup", "weeding", "seeding", "mobilization", "other",
] as const;
export type LaborCategory = (typeof LABOR_CATEGORIES)[number];
export function isLaborCategory(v: unknown): v is LaborCategory {
  return typeof v === "string" && (LABOR_CATEGORIES as readonly string[]).includes(v);
}

/**
 * `msqft` is per THOUSAND square feet — the unit turf work is already quoted in
 * (compare sod_products.install_minutes_per_1000_sqft). Without it, per-sqft
 * turf rates are four-decimal numbers nobody can sanity-check: fertilizer at
 * 43,000 sqft/hour is 0.0014 man-minutes per square foot, and a typo in that is
 * invisible.
 */
export const LABOR_UNITS = [
  "each", "foot", "sqft", "msqft", "cubic_yard", "ton", "hour", "job",
] as const;
export type LaborUnit = (typeof LABOR_UNITS)[number];
export function isLaborUnit(v: unknown): v is LaborUnit {
  return typeof v === "string" && (LABOR_UNITS as readonly string[]).includes(v);
}

const UNIT_ABBREV: Record<LaborUnit, string> = {
  each: "EA", foot: "FT", sqft: "SF", msqft: "MSF",
  cubic_yard: "CY", ton: "TON", hour: "HR", job: "JOB",
};
const UNIT_WORD: Record<LaborUnit, string> = {
  each: "each", foot: "ft", sqft: "sqft", msqft: "MSF",
  cubic_yard: "cu yd", ton: "ton", hour: "hr", job: "job",
};
const UNIT_LONG: Record<LaborUnit, string> = {
  each: "each", foot: "linear feet", sqft: "square feet",
  msqft: "thousand square feet", cubic_yard: "cubic yards", ton: "tons",
  hour: "hours", job: "per job",
};

export function unitAbbrev(u: LaborUnit): string { return UNIT_ABBREV[u]; }
export function unitLabel(u: LaborUnit): string { return UNIT_LONG[u]; }

/**
 * Convert a measured area to the msqft quantity.
 *
 * The UI must feed MEASURED SQFT through this rather than asking anyone to type
 * thousands. Typing 5000 into a field whose unit is MSF is a thousand-fold
 * error and it looks exactly like a correct entry — this is the worst trap in
 * the unit set, and converting instead of asking is what removes it.
 */
export function toMsqft(sqft: number): number {
  if (!Number.isFinite(sqft) || sqft <= 0) return 0;
  return Math.round((sqft / 1000) * 1000) / 1000;
}

export type LaborItem = {
  id: string;
  organization_id: string;
  name: string;
  category: LaborCategory;
  unit: LaborUnit;
  /** Material per unit. Zero on a pure-labor row, which is not the same as free. */
  cost: number;
  unit_price: number;
  /** MAN-minutes per unit. Fractional on per-area and per-foot rows. */
  install_minutes: number;
  notes: string | null;
  active: boolean;
  created_at: string;
};

export type NewLaborItem = {
  organization_id: string;
  name: string;
  category: LaborCategory;
  unit: LaborUnit;
  cost?: number;
  unit_price?: number;
  install_minutes?: number;
  notes?: string | null;
};

const LABOR_COLUMNS =
  "id,organization_id,name,category,unit,cost,unit_price,install_minutes,notes,active,created_at";

export async function listLaborItems(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly: boolean = true
): Promise<{ data: LaborItem[]; error: string | null }> {
  let query = supabase
    .from("labor_items")
    .select(LABOR_COLUMNS)
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (activeOnly) query = query.eq("active", true);

  const { data, error } = await query;
  return {
    data: (data as LaborItem[] | null) ?? [],
    error: error?.message ?? null,
  };
}

export async function createLaborItem(
  supabase: SupabaseClient,
  item: NewLaborItem
): Promise<{ data: LaborItem | null; error: string | null }> {
  // PostgREST returns no row from an insert unless select() is chained, so
  // .single() alone would hand back null and the caller could never read the id.
  const { data, error } = await supabase
    .from("labor_items")
    .insert(item)
    .select(LABOR_COLUMNS)
    .single();

  return {
    data: (data as LaborItem | null) ?? null,
    error: error?.message ?? null,
  };
}

export async function updateLaborItem(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<LaborItem,
    "name" | "category" | "unit" | "cost" | "unit_price" | "install_minutes" | "notes" | "active">>
): Promise<string | null> {
  const { error } = await supabase
    .from("labor_items")
    .update(patch)
    .eq("id", id)
    .select("id")
    .single();

  return error?.message ?? null;
}

export type LaborSnapshot = {
  labor_item_id: string;
  name: string;
  category: LaborCategory;
  unit: LaborUnit;
  cost: number;
  unit_price: number;
  install_minutes: number;
};

export function laborSnapshot(item: LaborItem): LaborSnapshot {
  return {
    labor_item_id: item.id,
    name: item.name,
    category: item.category,
    unit: item.unit,
    cost: item.cost,
    unit_price: item.unit_price,
    install_minutes: item.install_minutes,
  };
}

export function readLaborSnapshot(raw: unknown): LaborSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = o["labor_item_id"];
  const name = o["name"];
  if (typeof id !== "string" || typeof name !== "string") return null;

  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    labor_item_id: id,
    name,
    category: isLaborCategory(o["category"]) ? o["category"] : "other",
    unit: isLaborUnit(o["unit"]) ? o["unit"] : "each",
    cost: num(o["cost"]),
    unit_price: num(o["unit_price"]),
    install_minutes: num(o["install_minutes"]),
  };
}

export type LaborCharge = {
  name: string;
  category: LaborCategory;
  unit: LaborUnit;
  quantity: number;
  /** Always names the unit — the defence against a bare number meaning anything. */
  basis: string;
  cost: number;
  revenue: number;
  manHours: number;
  /** PER-UNIT money. The quote consumer multiplies by quantity. */
  unitPrice: number;
  unitCost: number;
  /** No price recorded. NOT the same as free. */
  unpriced: boolean;
  /** No man-minutes recorded. NOT the same as instant. */
  untimed: boolean;
};

function round2(n: number) { return Math.round(n * 100) / 100; }

export function laborCharge(s: LaborSnapshot, quantity: number): LaborCharge {
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;

  // A quantity of hours IS the labor time. Reading install_minutes on an hour
  // row would report zero man-hours for an eight-hour line whenever nobody had
  // filled the column in, which is worse than ignoring it.
  const manHours = s.unit === "hour"
    ? round2(qty)
    : round2((s.install_minutes * qty) / 60);

  // msqft states the square footage too, so a thousand-fold entry error is
  // visible in the line itself rather than only in the total.
  const basis = s.unit === "msqft"
    ? `${qty} MSF (${Math.round(qty * 1000).toLocaleString("en-US")} sqft)`
    : `${qty} ${UNIT_WORD[s.unit]}`;

  return {
    name: s.name,
    category: s.category,
    unit: s.unit,
    quantity: qty,
    basis,
    cost: round2(s.cost * qty),
    revenue: round2(s.unit_price * qty),
    manHours,
    unitPrice: s.unit_price,
    unitCost: s.cost,
    unpriced: s.unit_price <= 0 && qty > 0,
    // An hour row is timed by definition; anything else with no rate is not.
    untimed: s.unit !== "hour" && s.install_minutes <= 0 && qty > 0,
  };
}

export type LaborTotals = {
  cost: number;
  revenue: number;
  manHours: number;
  charges: LaborCharge[];
  unpricedCount: number;
  untimedCount: number;
};

export function laborTotals(
  lines: { snapshot: LaborSnapshot; quantity: number }[]
): LaborTotals {
  const charges: LaborCharge[] = [];
  let cost = 0, revenue = 0, manHours = 0, unpricedCount = 0, untimedCount = 0;

  for (const { snapshot, quantity } of lines) {
    const c = laborCharge(snapshot, quantity);
    charges.push(c);
    cost += c.cost;
    revenue += c.revenue;
    manHours += c.manHours;
    if (c.unpriced) unpricedCount += 1;
    if (c.untimed) untimedCount += 1;
  }

  return {
    cost: round2(cost),
    revenue: round2(revenue),
    manHours: round2(manHours),
    charges,
    unpricedCount,
    untimedCount,
  };
}

export function laborLineItem(c: LaborCharge): {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  internal_cost: number;
} | null {
  // Nothing billable produces no line. No $0 row reaches a customer quote.
  if (c.revenue <= 0) return null;
  return {
    description: `${c.name} — ${c.basis}`,
    quantity: c.quantity,
    unit: UNIT_ABBREV[c.unit],
    // PER UNIT, both of them. The consumer multiplies by quantity, so an
    // extended figure here would bill 40 cubic yards forty times over.
    unit_price: c.unitPrice,
    internal_cost: c.unitCost,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * SUGGESTIONS — published figures, shown beside a field, never written.
 *
 * These exist so an estimator filling in an empty catalogue has something to
 * judge their own number against. Nothing here is a default and nothing here
 * enters a calculation. Where only a PRICE was published and no production
 * rate, that is stated: a market price is an observation about what others
 * charge, not a rate this app recommends.
 * ──────────────────────────────────────────────────────────────────────────── */

export type BenchmarkRange = { low: number; typical: number; high: number };

export type Benchmark = {
  unit: LaborUnit;
  /** Man-minutes per unit, where a production rate has actually been published. */
  minutes: BenchmarkRange | null;
  /** Charge per unit, where only market pricing was found. An observation. */
  price: BenchmarkRange | null;
  source: string;
  /** What actually moves the number. Usually more useful than the number. */
  driver: string;
};

/**
 * Keyed `category:unit`, because the same category in a different unit is a
 * different figure entirely.
 */
export const LABOR_BENCHMARKS: Readonly<Record<string, Benchmark>> = {
  "mulch:cubic_yard": {
    unit: "cubic_yard",
    minutes: { low: 24, typical: 32, high: 60 },
    price: null,
    source: "Landscape contractor production reports, 2026",
    driver: "Carry distance and bed obstacles. Established perennials, tight gates or a long barrow run roughly halve the rate.",
  },
  "edging:foot": {
    unit: "foot",
    minutes: null,
    price: { low: 1.5, typical: 2.5, high: 3.5 },
    source: "Market pricing survey, 2026 — no production rate published",
    driver: "How overgrown the existing edge is.",
  },
  "weeding:hour": {
    unit: "hour",
    minutes: null,
    price: { low: 40, typical: 55, high: 70 },
    source: "Market pricing survey, 2026",
    driver: "Density and root depth. Billed by the hour precisely because it does not estimate well.",
  },
  "seeding:msqft": {
    unit: "msqft",
    minutes: { low: 1.4, typical: 1.4, high: 1.4 },
    price: null,
    source: "Push-spreader production rate, 43,000 sqft/hour, product cost excluded — single source",
    driver: "Spreader type. A single published figure, so treat the range as unknown rather than narrow.",
  },
};

/**
 * Sod install time, for the sod catalogue screen. It lives here rather than in
 * sodProducts.ts because this file is where published figures belong — a
 * benchmark is research, and keeping it out of the catalogue contracts is what
 * stops one being read as a default.
 *
 * The unit is per thousand square feet, matching
 * sod_products.install_minutes_per_1000_sqft.
 */
export const SOD_INSTALL_BENCHMARK: Benchmark = {
  unit: "msqft",
  minutes: { low: 218, typical: 420, high: 720 },
  price: null,
  source: "Contractor production reports, 2026 — 100 to 275 sqft per man-hour",
  driver: "Carry distance and access, far more than grass type. The published spread is nearly 3x: 275 sqft/man-hour barrowed 30 ft against 100 sqft/man-hour carried up stairs.",
};

/** The org's own billing rate, for the labor settings screen. An observation. */
export const BILL_RATE_BENCHMARK: Benchmark = {
  unit: "hour",
  minutes: null,
  price: { low: 65, typical: 88, high: 145 },
  source: "Landscape billing rate survey, 2026",
  driver: "Install-plus-maintenance companies cluster at 75-100. Lean operations run 65-75; design/build with heavy equipment reaches 100-145.",
};

export function benchmarkFor(
  category: LaborCategory,
  unit: LaborUnit
): Benchmark | null {
  return LABOR_BENCHMARKS[`${category}:${unit}`] ?? null;
}

function fmtRange(r: BenchmarkRange, suffix: string): string {
  return r.low === r.high
    ? `${r.typical}${suffix}`
    : `${r.low}-${r.high}${suffix} (typically ${r.typical})`;
}

/**
 * One line for the UI. Says what was published and what it depends on, and
 * never tells the org what to charge.
 */
export function describeBenchmark(b: Benchmark): string {
  const parts: string[] = [];
  if (b.minutes) {
    parts.push(`Published rate: ${fmtRange(b.minutes, " man-min")} per ${UNIT_WORD[b.unit]}.`);
  }
  if (b.price) {
    parts.push(`Others charge ${fmtRange(b.price, "")} per ${UNIT_WORD[b.unit]}.`);
  }
  if (!parts.length) return "No published figure found.";
  parts.push(b.driver);
  parts.push(`Source: ${b.source}. Your own crew times are better than any of this.`);
  return parts.join(" ");
}
