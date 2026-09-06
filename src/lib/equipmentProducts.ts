// Machinery for the quick estimator.
//
// Equipment is the odd catalogue: it holds TWO cost models at once.
//
//   RENTED  billed by PERIOD — daily, weekly, monthly — plus delivery and
//           pickup. The periods are not multiples of each other: a rental
//           house's week is typically far less than seven days, so five days
//           on a daily rate can cost more than one week. Multiplying the
//           daily rate is the commonest way to over-quote a rental.
//
//   OWNED   no rent, but a real hourly cost — depreciation, fuel and
//           maintenance. Without it, owned gear quotes at zero and every job
//           using it looks more profitable than it is. That is the single
//           most expensive mistake in this file's subject area, because it is
//           invisible: the job comes in "on budget" and the machine wears out
//           unfunded.
//
// The operator is LABOR, not equipment, and is counted in the labor math like
// any other man-hour. `operator_required` exists only so the UI can warn when
// a machine is added with no labor to run it.

import type { SupabaseClient } from "@supabase/supabase-js";

export const EQUIPMENT_CATEGORIES = [
  "skid_steer",
  "excavator",
  "trencher",
  "auger",
  "dump_trailer",
  "truck",
  "crane",
  "tiller",
  "sod_cutter",
  "stump_grinder",
  "other",
] as const;

export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export function isEquipmentCategory(v: unknown): v is EquipmentCategory {
  return typeof v === "string" && (EQUIPMENT_CATEGORIES as readonly string[]).includes(v);
}

export const OWNERSHIP = ["owned", "rented"] as const;
export type Ownership = (typeof OWNERSHIP)[number];
export function isOwnership(v: unknown): v is Ownership {
  return v === "owned" || v === "rented";
}

export type EquipmentProduct = {
  id: string;
  organization_id: string;
  name: string;
  category: EquipmentCategory;
  ownership: Ownership;
  // Null means the org does not rent at that period, NOT that it is free.
  // Every rate is nullable for that reason.
  cost_hourly: number | null;
  cost_daily: number | null;
  cost_weekly: number | null;
  cost_monthly: number | null;
  price_hourly: number | null;
  price_daily: number | null;
  price_weekly: number | null;
  price_monthly: number | null;
  delivery_fee: number;
  pickup_fee: number;
  operator_required: boolean;
  notes: string | null;
  active: boolean;
  // Rental pricing moves. A stale rate quoted as current is a silent margin
  // leak, so the age of this is surfaced rather than hidden.
  rates_updated_at: string | null;
  created_at: string;
};

const EQUIPMENT_COLUMNS =
  "id, organization_id, name, category, ownership, cost_hourly, cost_daily, cost_weekly, cost_monthly, price_hourly, price_daily, price_weekly, price_monthly, delivery_fee, pickup_fee, operator_required, notes, active, rates_updated_at, created_at";

export type NewEquipmentProduct = {
  organization_id: string;
  name: string;
  category: EquipmentCategory;
  ownership: Ownership;
  cost_hourly?: number | null;
  cost_daily?: number | null;
  cost_weekly?: number | null;
  cost_monthly?: number | null;
  price_hourly?: number | null;
  price_daily?: number | null;
  price_weekly?: number | null;
  price_monthly?: number | null;
  delivery_fee?: number;
  pickup_fee?: number;
  operator_required?: boolean;
  notes?: string | null;
};

export async function listEquipment(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly = true
): Promise<{ data: EquipmentProduct[]; error: string | null }> {
  let q = supabase
    .from("equipment_products")
    .select(EQUIPMENT_COLUMNS)
    .eq("organization_id", organizationId);
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("name", { ascending: true });
  return { data: (data as unknown as EquipmentProduct[]) ?? [], error: error?.message ?? null };
}

export async function createEquipment(
  supabase: SupabaseClient,
  product: NewEquipmentProduct
): Promise<{ data: EquipmentProduct | null; error: string | null }> {
  const { data, error } = await supabase
    .from("equipment_products")
    .insert({ ...product, rates_updated_at: new Date().toISOString() })
    .select(EQUIPMENT_COLUMNS)
    .single();
  return { data: (data as unknown as EquipmentProduct) ?? null, error: error?.message ?? null };
}

// Any rate change stamps rates_updated_at, so "how old is this price" is
// answerable without a separate history table.
export async function updateEquipment(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Omit<EquipmentProduct, "id" | "organization_id" | "created_at">>
): Promise<string | null> {
  const touchesRates = [
    "cost_hourly", "cost_daily", "cost_weekly", "cost_monthly",
    "price_hourly", "price_daily", "price_weekly", "price_monthly",
    "delivery_fee", "pickup_fee",
  ].some((k) => k in patch);
  const body = touchesRates
    ? { ...patch, rates_updated_at: new Date().toISOString() }
    : patch;
  const { error } = await supabase.from("equipment_products").update(body).eq("id", id);
  return error?.message ?? null;
}

// How stale the rates are, in days. Null when they have never been recorded —
// which the UI must show as "never priced", not as "0 days old".
export function rateAgeDays(product: Pick<EquipmentProduct, "rates_updated_at">): number | null {
  if (!product.rates_updated_at) return null;
  const then = Date.parse(product.rates_updated_at);
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Choosing a rate
// ---------------------------------------------------------------------------

// DAYS IN A RENTAL MONTH. Most equipment rental houses bill a "month" as 4
// weeks / 28 days, not a calendar month — but not all do, and the difference
// is real money: 30 days on a 28-day month is one month plus two days, and on
// a 30-day month it is exactly one month. Left as a parameter rather than
// buried, so an org whose supplier bills calendar months is not silently
// over-quoted by two days on every long hire.
export const DEFAULT_RENTAL_MONTH_DAYS = 28;


export type RatePeriods = {
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
};

export type RatePlan = {
  months: number;
  weeks: number;
  days: number;
  total: number;
  // Spelled out so the estimator can see WHY, e.g. "1 week + 2 days".
  label: string;
  // True when no period rate was available at all.
  unpriced: boolean;
};

// The cheapest way to cover `days` given the rates that exist.
//
// This is the whole reason equipment rates are stored per period rather than
// as one number. Rental houses price a week well below seven days and a month
// well below four weeks, so the naive daily × days is often the most expensive
// possible answer. A 5-day job on $150/day and $450/week is $750 multiplied
// out and $450 taken as a week.
//
// It also never returns a plan costing more than a longer, cheaper one: if a
// full week is cheaper than the 5 days it replaces, the week wins and the
// customer is not billed for arithmetic nobody would do by hand.
export function cheapestPlan(
  days: number,
  rates: RatePeriods,
  daysPerMonth = DEFAULT_RENTAL_MONTH_DAYS
): RatePlan {
  const d = Number.isFinite(days) && days > 0 ? Math.ceil(days) : 0;
  const rate = (v: number | null) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const rd = rate(rates.daily), rw = rate(rates.weekly), rm = rate(rates.monthly);

  if (d === 0) return { months: 0, weeks: 0, days: 0, total: 0, label: "", unpriced: false };
  if (!rd && !rw && !rm) {
    return { months: 0, weeks: 0, days: d, total: 0, label: `${d} day${d === 1 ? "" : "s"}`, unpriced: true };
  }

  let best: RatePlan | null = null;
  const perMonth = Number.isFinite(daysPerMonth) && daysPerMonth > 0 ? daysPerMonth : DEFAULT_RENTAL_MONTH_DAYS;
  const maxMonths = rm ? Math.ceil(d / perMonth) : 0;
  for (let m = 0; m <= maxMonths; m++) {
    const afterMonths = d - m * perMonth;
    const maxWeeks = rw ? Math.max(0, Math.ceil(Math.max(afterMonths, 0) / 7)) : 0;
    for (let w = 0; w <= maxWeeks; w++) {
      const remaining = Math.max(0, afterMonths - w * 7);
      // Leftover days need a daily rate; without one, round up to another
      // week or month rather than pretending the days are free.
      if (remaining > 0 && !rd) continue;
      const total =
        m * (rm ?? 0) + w * (rw ?? 0) + (remaining > 0 ? remaining * (rd ?? 0) : 0);
      if (total <= 0) continue;
      if (!best || total < best.total) {
        const parts: string[] = [];
        if (m) parts.push(`${m} month${m === 1 ? "" : "s"}`);
        if (w) parts.push(`${w} week${w === 1 ? "" : "s"}`);
        if (remaining) parts.push(`${remaining} day${remaining === 1 ? "" : "s"}`);
        best = {
          months: m, weeks: w, days: remaining,
          total: Math.round(total * 100) / 100,
          label: parts.join(" + "),
          unpriced: false,
        };
      }
    }
  }

  return best ?? { months: 0, weeks: 0, days: d, total: 0, label: `${d} day${d === 1 ? "" : "s"}`, unpriced: true };
}

// ---------------------------------------------------------------------------
// Equipment on an estimate
// ---------------------------------------------------------------------------

export type EquipmentSnapshot = {
  equipment_product_id: string;
  name: string;
  category: EquipmentCategory;
  ownership: Ownership;
  cost_hourly: number | null;
  cost_daily: number | null;
  cost_weekly: number | null;
  cost_monthly: number | null;
  price_hourly: number | null;
  price_daily: number | null;
  price_weekly: number | null;
  price_monthly: number | null;
  delivery_fee: number;
  pickup_fee: number;
  operator_required: boolean;
};

export function equipmentSnapshot(p: EquipmentProduct): EquipmentSnapshot {
  return {
    equipment_product_id: p.id,
    name: p.name,
    category: p.category,
    ownership: p.ownership,
    cost_hourly: p.cost_hourly,
    cost_daily: p.cost_daily,
    cost_weekly: p.cost_weekly,
    cost_monthly: p.cost_monthly,
    price_hourly: p.price_hourly,
    price_daily: p.price_daily,
    price_weekly: p.price_weekly,
    price_monthly: p.price_monthly,
    delivery_fee: p.delivery_fee,
    pickup_fee: p.pickup_fee,
    operator_required: p.operator_required,
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function readEquipmentSnapshot(raw: unknown): EquipmentSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = m.equipment_product_id;
  const name = m.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    equipment_product_id: id,
    name,
    category: isEquipmentCategory(m.category) ? m.category : "other",
    ownership: isOwnership(m.ownership) ? m.ownership : "rented",
    cost_hourly: numOrNull(m.cost_hourly),
    cost_daily: numOrNull(m.cost_daily),
    cost_weekly: numOrNull(m.cost_weekly),
    cost_monthly: numOrNull(m.cost_monthly),
    price_hourly: numOrNull(m.price_hourly),
    price_daily: numOrNull(m.price_daily),
    price_weekly: numOrNull(m.price_weekly),
    price_monthly: numOrNull(m.price_monthly),
    delivery_fee: num(m.delivery_fee),
    pickup_fee: num(m.pickup_fee),
    operator_required: m.operator_required !== false,
  };
}

export type EquipmentLine = {
  snapshot: EquipmentSnapshot;
  quantity: number;
  hours: number;
  days: number;
};

export type EquipmentCharge = {
  name: string;
  ownership: Ownership;
  quantity: number;
  // What the estimator sees as the basis: "1 week + 2 days" or "6.5 hours".
  basis: string;
  cost: number;
  revenue: number;
  // Delivery and pickup, counted once per machine per rental, not per day.
  mobilization: number;
  unpriced: boolean;
};

// Costs one machine on one job.
//
// OWNED bills by the hour against the internal rate. RENTED takes the
// cheapest period plan for the days needed, then adds delivery and pickup
// ONCE per machine — those are per-rental fees, not per-day, and forgetting
// them is routine on short hires where they can exceed the rate itself.
export function equipmentCharge(line: EquipmentLine): EquipmentCharge {
  const s = line.snapshot;
  const qty = Number.isFinite(line.quantity) && line.quantity > 0 ? Math.floor(line.quantity) : 1;

  if (s.ownership === "owned") {
    const hrs = Number.isFinite(line.hours) && line.hours > 0 ? line.hours : 0;
    const cost = (s.cost_hourly ?? 0) * hrs * qty;
    const revenue = (s.price_hourly ?? 0) * hrs * qty;
    return {
      name: s.name,
      ownership: "owned",
      quantity: qty,
      basis: `${hrs} hour${hrs === 1 ? "" : "s"}`,
      cost: Math.round(cost * 100) / 100,
      revenue: Math.round(revenue * 100) / 100,
      mobilization: 0,
      // Owned machinery with no hourly cost recorded is the silent one: it
      // quotes at zero and the job looks more profitable than it is.
      unpriced: !(s.cost_hourly && s.cost_hourly > 0) && hrs > 0,
    };
  }

  const costPlan = cheapestPlan(line.days, {
    daily: s.cost_daily, weekly: s.cost_weekly, monthly: s.cost_monthly,
  });
  const pricePlan = cheapestPlan(line.days, {
    daily: s.price_daily, weekly: s.price_weekly, monthly: s.price_monthly,
  });
  const mob = (s.delivery_fee + s.pickup_fee) * qty;
  return {
    name: s.name,
    ownership: "rented",
    quantity: qty,
    basis: costPlan.label,
    cost: Math.round((costPlan.total * qty + mob) * 100) / 100,
    revenue: Math.round((pricePlan.total * qty + mob) * 100) / 100,
    mobilization: Math.round(mob * 100) / 100,
    unpriced: costPlan.unpriced,
  };
}

export function equipmentTotals(lines: EquipmentLine[]): {
  cost: number;
  revenue: number;
  charges: EquipmentCharge[];
  unpricedCount: number;
  needsOperator: boolean;
} {
  const charges = lines.map(equipmentCharge);
  return {
    cost: Math.round(charges.reduce((s, c) => s + c.cost, 0) * 100) / 100,
    revenue: Math.round(charges.reduce((s, c) => s + c.revenue, 0) * 100) / 100,
    charges,
    unpricedCount: charges.filter((c) => c.unpriced).length,
    needsOperator: lines.some((l) => l.snapshot.operator_required),
  };
}

// One line per machine. internal_cost is the whole charge for this machine,
// with quantity 1, because the charge already accounts for quantity and for a
// period plan that is not a simple per-unit multiple.
export function equipmentLineItem(
  charge: EquipmentCharge
): { description: string; quantity: number; unit: string; unit_price: number; internal_cost: number } | null {
  if (charge.revenue <= 0) return null;
  const qty = charge.quantity > 1 ? `${charge.quantity}x ` : "";
  const basis = charge.basis ? ` — ${charge.basis}` : "";
  return {
    description: `${qty}${charge.name}${basis}`,
    quantity: 1,
    unit: "LOT",
    unit_price: charge.revenue,
    internal_cost: charge.cost,
  };
}
