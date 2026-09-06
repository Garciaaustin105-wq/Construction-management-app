import type { SupabaseClient } from "@supabase/supabase-js";

export const COMPONENT_CATEGORIES = [
  "poc","backflow","master_valve","flow_sensor","mainline","lateral","drip",
  "zone_valve","valve_box","controller","wire","connector","sensor","sleeve",
  "fitting","other",
] as const;
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];
export function isComponentCategory(v: unknown): v is ComponentCategory {
  return typeof v === "string" && (COMPONENT_CATEGORIES as readonly string[]).includes(v);
}

export const COMPONENT_UNITS = ["each", "foot"] as const;
export type ComponentUnit = (typeof COMPONENT_UNITS)[number];
export function isComponentUnit(v: unknown): v is ComponentUnit {
  return typeof v === "string" && (COMPONENT_UNITS as readonly string[]).includes(v);
}

export type IrrigationComponent = {
  id: string;
  organization_id: string;
  name: string;
  category: ComponentCategory;
  unit: ComponentUnit;
  cost: number;
  unit_price: number;
  install_minutes: number;   // MAN-minutes PER UNIT
  notes: string | null;
  active: boolean;
  created_at: string;
};

export type NewIrrigationComponent = {
  organization_id: string;
  name: string;
  category: ComponentCategory;
  unit: ComponentUnit;
  cost?: number;
  unit_price?: number;
  install_minutes?: number;
  notes?: string | null;
};

const COMPONENT_COLUMNS =
  "id,organization_id,name,category,unit,cost,unit_price,install_minutes,notes,active,created_at";

export async function listComponents(
  supabase: SupabaseClient,
  organizationId: string,
  activeOnly: boolean = true
): Promise<{ data: IrrigationComponent[]; error: string | null }> {
  const selectString = COMPONENT_COLUMNS;
  let query = supabase
    .from("irrigation_components")
    .select(selectString)
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (activeOnly) {
    query = query.eq("active", true);
  }

  const { data, error } = await query;
  return {
    data: (data as IrrigationComponent[] | null) ?? [],
    error: error?.message ?? null,
  };
}

export async function createComponent(
  supabase: SupabaseClient,
  c: NewIrrigationComponent
): Promise<{ data: IrrigationComponent | null; error: string | null }> {
  const { data, error } = await supabase
    .from("irrigation_components")
    .insert(c)
    .select(COMPONENT_COLUMNS)
    .single();

  return {
    data: (data as IrrigationComponent | null) ?? null,
    error: error?.message ?? null,
  };
}

export async function updateComponent(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      IrrigationComponent,
      | "name"
      | "category"
      | "unit"
      | "cost"
      | "unit_price"
      | "install_minutes"
      | "notes"
      | "active"
    >
  >
): Promise<string | null> {
  const { error } = await supabase
    .from("irrigation_components")
    .update(patch)
    .eq("id", id)
    .select("id")
    .single();

  return error?.message ?? null;
}

export type ComponentSnapshot = {
  irrigation_component_id: string;
  name: string;
  category: ComponentCategory;
  unit: ComponentUnit;
  cost: number;
  unit_price: number;
  install_minutes: number;
};

export function componentSnapshot(c: IrrigationComponent): ComponentSnapshot {
  return {
    irrigation_component_id: c.id,
    name: c.name,
    category: c.category,
    unit: c.unit,
    cost: c.cost,
    unit_price: c.unit_price,
    install_minutes: c.install_minutes,
  };
}

export function readComponentSnapshot(raw: unknown): ComponentSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = obj["irrigation_component_id"];
  const name = obj["name"];
  if (typeof id !== "string" || typeof name !== "string") return null;

  const costRaw = obj["cost"];
  const unitPriceRaw = obj["unit_price"];
  const installMinutesRaw = obj["install_minutes"];

  const cost = typeof costRaw === "number" ? costRaw : Number(costRaw);
  const unitPrice = typeof unitPriceRaw === "number" ? unitPriceRaw : Number(unitPriceRaw);
  const installMinutes = typeof installMinutesRaw === "number" ? installMinutesRaw : Number(installMinutesRaw);

  const categoryRaw = obj["category"];
  const unitRaw = obj["unit"];

  const category = isComponentCategory(categoryRaw) ? categoryRaw : "other";
  const unit = isComponentUnit(unitRaw) ? unitRaw : "each";

  const safeNumber = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    irrigation_component_id: id,
    name,
    category,
    unit,
    cost: safeNumber(cost),
    unit_price: safeNumber(unitPrice),
    install_minutes: safeNumber(installMinutes),
  };
}

export type ComponentCharge = {
  name: string;
  category: ComponentCategory;
  unit: ComponentUnit;
  quantity: number;
  basis: string;
  cost: number;
  revenue: number;
  manHours: number;
  // PER-UNIT money, carried alongside the extended totals. The quote consumer
  // multiplies quantity by these, so a line must never receive the extended
  // figure — 200 ft of wire would bill 200x its own run.
  unitPrice: number;
  unitCost: number;
  unpriced: boolean;
};

export function componentCharge(
  s: ComponentSnapshot,
  quantity: number
): ComponentCharge {
  const qty = Number.isFinite(quantity) && quantity >= 0 ? quantity : 0;
  const cost = Math.round(s.cost * qty * 100) / 100;
  const revenue = Math.round(s.unit_price * qty * 100) / 100;
  const manHours = Math.round((s.install_minutes * qty / 60) * 100) / 100;
  const basis = `${qty} ${s.unit === "foot" ? "ft" : "each"}`;
  const unpriced = s.unit_price <= 0 && qty > 0;

  return {
    name: s.name,
    category: s.category,
    unit: s.unit,
    quantity: qty,
    basis,
    cost,
    revenue,
    manHours,
    unitPrice: s.unit_price,
    unitCost: s.cost,
    unpriced,
  };
}

export type SystemTotals = {
  cost: number;
  revenue: number;
  manHours: number;
  charges: ComponentCharge[];
  unpricedCount: number;
};

export function systemTotals(
  lines: { snapshot: ComponentSnapshot; quantity: number }[]
): SystemTotals {
  const charges: ComponentCharge[] = [];
  let totalCost = 0;
  let totalRevenue = 0;
  let totalManHours = 0;
  let unpricedCount = 0;

  for (const { snapshot, quantity } of lines) {
    const charge = componentCharge(snapshot, quantity);
    charges.push(charge);
    totalCost += charge.cost;
    totalRevenue += charge.revenue;
    totalManHours += charge.manHours;
    if (charge.unpriced) unpricedCount += 1;
  }

  return {
    cost: Math.round(totalCost * 100) / 100,
    revenue: Math.round(totalRevenue * 100) / 100,
    manHours: Math.round(totalManHours * 100) / 100,
    charges,
    unpricedCount,
  };
}

export function componentLineItem(
  c: ComponentCharge
):
  | {
      description: string;
      quantity: number;
      unit: string;
      unit_price: number;
      internal_cost: number;
    }
  | null {
  if (c.revenue <= 0) return null;

  const description = `${c.name} — ${c.basis}`;
  const unit = c.unit === "foot" ? "FT" : "EA";

  return {
    description,
    quantity: c.quantity,
    unit,
    unit_price: c.unitPrice,
    internal_cost: c.unitCost,
  };
}

export type StationCheck = {
  zoneValves: number;
  stations: number;
  short: number;
  ok: boolean;
  message: string;
};

export function stationCheck(
  zoneValves: number,
  stations: number
): StationCheck {
  const z = Number.isFinite(zoneValves) && zoneValves >= 0 ? zoneValves : 0;
  const s = Number.isFinite(stations) && stations >= 0 ? stations : 0;
  // Missing data is not a shortfall. Six valves and no controller yet is an
  // unfinished estimate, not a six-station problem, and reporting one would be
  // the app inventing a fault out of a blank field.
  if (z === 0 || s === 0) {
    return {
      zoneValves: z,
      stations: s,
      short: 0,
      ok: true,
      message: "Enter both the zone valve count and the controller stations to check them.",
    };
  }

  const short = Math.max(0, z - s);
  const ok = s >= z;
  const message = short > 0
    ? `${z} zone valves, controller has ${s} stations — ${short} short.`
    : `${z} zone valves, controller has ${s} stations — covered.`;

  return { zoneValves: z, stations: s, short, ok, message };
}
