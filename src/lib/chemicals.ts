// Shared contract for the lawn chemical-application tracking feature (Track 2
// of the lawn competitive roadmap). Consumed by the office/crew UI (Opus-built)
// + the server routes (POST /api/lawn/applications + CSV export, Claude-direct).
//
// Compliance model: a chemical_application row is SELF-CONTAINED — product_name,
// epa_reg_number, active_ingredient are snapshotted at log time (the POST route
// copies them from the chosen chemical_product, or takes them from the request
// for a manual/one-off product). Editing/deleting a product never corrupts a
// historical application record. This is the audit shape a state inspector
// expects: who applied what (product + EPA # + active ingredient), how much
// (quantity + rate + area), when (applied_at), where (job/customer), weather
// (wind/temp), and the re-entry interval.

export const QUANTITY_UNITS = ["oz", "lb", "gal", "mL", "L", "g", "kg"] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export const RATE_UNITS = [
  "oz/1000sqft",
  "lb/1000sqft",
  "oz/acre",
  "lb/acre",
  "gal/acre",
  "mL/1000sqft",
] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

// Office catalog row (chemical_products). Crew read this; office/PM manage.
export type ChemicalProduct = {
  id: string;
  organization_id: string;
  name: string;
  epa_reg_number: string | null;
  active_ingredient: string | null;
  default_rate: number | null;
  rate_unit: RateUnit | string | null;
  re_entry_hours: number | null;
  active: boolean;
  notes: string | null;
  created_at: string;
};

// Application log row (chemical_applications). The list page seeds this via
// RLS (office sees all org apps; crew sees their own + their visits'). The
// embeds (jobs, crew_members) come from the seed select in the page shell.
export type ChemicalApplication = {
  id: string;
  organization_id: string;
  job_id: string;
  visit_id: string | null;
  product_id: string | null;
  product_name: string;
  epa_reg_number: string | null;
  active_ingredient: string | null;
  applicator_id: string | null;
  quantity_used: number | null;
  quantity_unit: string | null;
  rate: number | null;
  area_treated_sqft: number | null;
  target_pest: string | null;
  wind_mph: number | null;
  temp_f: number | null;
  applied_at: string;
  re_entry_hours: number | null;
  re_entry_until: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  // Embeds (optional — present when the seed select joins them):
  jobs?: { name: string | null; customers: { name: string | null } | null } | null;
  crew_members?: { name: string | null } | null;
};

// POST /api/lawn/applications request body. product_id OR product_name is
// required (product_id snapshots from the catalog; product_name is a manual /
// one-off entry). job_id is required (org is stamped from it). visit_id is
// optional (ad-hoc applications outside a visit). Crew callers must supply a
// visit_id assigned to them; the route forces applicator_id = auth.uid() for
// crew and ignores any applicator_id they send.
export type ChemicalApplicationInput = {
  job_id: string;
  visit_id?: string | null;
  product_id?: string | null;
  product_name?: string;
  epa_reg_number?: string;
  active_ingredient?: string;
  applicator_id?: string | null; // office only; forced to auth.uid() for crew
  quantity_used?: number | null;
  quantity_unit?: string | null;
  rate?: number | null;
  area_treated_sqft?: number | null;
  target_pest?: string;
  wind_mph?: number | null;
  temp_f?: number | null;
  applied_at?: string; // ISO; defaults to now
  re_entry_hours?: number | null;
  notes?: string;
};

// CSV compliance export column order (GET /api/lawn/applications/export). This
// is the audit shape — keep it stable; inspectors download this exact layout.
// Accessors can read the embeds (jobs / crew_members) the seed select joins, so
// applicator + site + customer land in the export.
export const CSV_COLUMNS: { label: string; get: (a: ChemicalApplication) => string }[] = [
  { label: "Date Applied", get: (a) => fmtDate(a.applied_at) },
  { label: "Applicator", get: (a) => a.crew_members?.name ?? "" },
  { label: "Customer", get: (a) => a.jobs?.customers?.name ?? "" },
  { label: "Job", get: (a) => a.jobs?.name ?? "" },
  { label: "Product", get: (a) => a.product_name },
  { label: "EPA Reg #", get: (a) => a.epa_reg_number ?? "" },
  { label: "Active Ingredient", get: (a) => a.active_ingredient ?? "" },
  { label: "Target Pest", get: (a) => a.target_pest ?? "" },
  { label: "Quantity Used", get: (a) => fmtNum(a.quantity_used) },
  { label: "Unit", get: (a) => a.quantity_unit ?? "" },
  { label: "Rate", get: (a) => fmtNum(a.rate) },
  { label: "Area Treated (sqft)", get: (a) => fmtNum(a.area_treated_sqft) },
  { label: "Wind (mph)", get: (a) => fmtNum(a.wind_mph) },
  { label: "Temp (°F)", get: (a) => fmtNum(a.temp_f) },
  { label: "Re-entry (hrs)", get: (a) => (a.re_entry_hours != null ? String(a.re_entry_hours) : "") },
  { label: "Re-entry Until", get: (a) => fmtDate(a.re_entry_until) },
];

function fmtNum(n: number | null): string {
  return n == null ? "" : String(n);
}
function fmtDate(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  // ISO-ish local for the audit sheet; keep it sortable.
  return d.toLocaleString();
}

// RFC 4180 CSV cell escaping (comma / quote / newline → quoted, internal quotes
// doubled). Used by the export route.
export function csvEscape(value: string): string {
  if (value == null) return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Compute re_entry_until = applied_at + re_entry_hours (null when either is
// missing). Shared by the POST route (server) so the column is always
// consistent.
export function computeReEntryUntil(
  appliedAt: string,
  reEntryHours: number | null
): string | null {
  if (reEntryHours == null || reEntryHours < 0) return null;
  const ms = new Date(appliedAt).getTime() + reEntryHours * 3600 * 1000;
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}