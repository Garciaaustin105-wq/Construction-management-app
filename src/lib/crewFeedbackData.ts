import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readLaborSnapshot, laborCharge, unitAbbrev as laborUnitAbbrev, updateLaborItem,
} from "./laborItems";
import { readComponentSnapshot, componentCharge, updateComponent } from "./irrigationSystem";
import { buildPlantLegend, isPlantArea, updatePlantSize } from "./plantProducts";
import { isSodArea, sodEstimateForArea, updateSodProduct } from "./sodProducts";
import type { EstimateArea } from "./estimateAreas";
import type { JobRecord, EstimateTaskLine, ClockEntry } from "./crewFeedback";

/**
 * Database glue for src/lib/crewFeedback.ts.
 *
 * SPLIT FROM THE MATH ON PURPOSE: crewFeedback.ts stays pure so its harness can
 * run standalone, the same way manHours.ts is pure and its callers are not.
 * Everything here talks to Supabase or to another catalogue contract.
 */

type AreaRow = EstimateArea & { estimate_id: string };
/* ── Loading ──────────────────────────────────────────────────────────────── */

/**
 * Assemble job records from the four catalogues that carry labor.
 *
 * Every man-hour figure here comes from the catalogue's OWN charge function —
 * laborCharge, componentCharge, the plant legend, sodEstimate. Nothing is
 * re-derived. If a rate changes shape it changes in one place.
 *
 * The `key` on each line identifies the catalogue ROW, prefixed with which
 * catalogue it came from, because that prefix is what applySuggestion routes on.
 */
export type FeedbackData = {
  records: JobRecord[];
  /** Jobs with time but no estimate, so the screen can say why they are absent. */
  jobsWithoutEstimate: number;
  error: string | null;
};

export async function loadFeedbackData(
  supabase: SupabaseClient,
  organizationId: string
): Promise<FeedbackData> {
  const empty = { records: [], jobsWithoutEstimate: 0 };

  const { data: estimateRows, error: estErr } = await supabase
    .from("estimates")
    .select("id, job_id, title, mobilization_hours")
    .eq("organization_id", organizationId)
    .not("job_id", "is", null);
  if (estErr) return { ...empty, error: estErr.message };

  const estimates = (estimateRows ?? []) as {
    id: string; job_id: string; title: string | null; mobilization_hours: number | null;
  }[];
  if (estimates.length === 0) return { ...empty, error: null };

  const estimateIds = estimates.map((e) => e.id);
  const jobIds = [...new Set(estimates.map((e) => e.job_id))];

  const [jobsRes, laborRes, compRes, areaRes, timeRes] = await Promise.all([
    supabase.from("jobs").select("id, name").in("id", jobIds),
    supabase.from("estimate_labor_items")
      .select("estimate_id, snapshot, quantity").in("estimate_id", estimateIds),
    supabase.from("estimate_components")
      .select("estimate_id, snapshot, quantity").in("estimate_id", estimateIds),
    supabase.from("estimate_areas")
      .select("estimate_id, kind, meta, color, area_sqft").in("estimate_id", estimateIds),
    supabase.from("time_entries")
      .select("id, job_id, clock_in_at, clock_out_at, crew_size")
      .eq("organization_id", organizationId)
      .in("job_id", jobIds),
  ]);

  const firstError =
    jobsRes.error ?? laborRes.error ?? compRes.error ?? areaRes.error ?? timeRes.error;
  if (firstError) return { ...empty, error: firstError.message };

  const jobNames = new Map<string, string>();
  for (const j of (jobsRes.data ?? []) as { id: string; name: string | null }[]) {
    jobNames.set(j.id, j.name ?? "Untitled job");
  }

  const linesByEstimate = new Map<string, EstimateTaskLine[]>();
  const push = (estimateId: string, line: EstimateTaskLine) => {
    const bucket = linesByEstimate.get(estimateId);
    if (bucket) bucket.push(line);
    else linesByEstimate.set(estimateId, [line]);
  };

  type SnapRow = { estimate_id: string; snapshot: unknown; quantity: number };

  for (const r of (laborRes.data ?? []) as SnapRow[]) {
    const snap = readLaborSnapshot(r.snapshot);
    if (!snap) continue;
    const charge = laborCharge(snap, r.quantity);
    push(r.estimate_id, {
      key: `labor:${snap.labor_item_id}`,
      label: snap.name,
      unit: laborUnitAbbrev(snap.unit),
      quantity: charge.quantity,
      manHours: charge.manHours,
    });
  }

  for (const r of (compRes.data ?? []) as SnapRow[]) {
    const snap = readComponentSnapshot(r.snapshot);
    if (!snap) continue;
    const charge = componentCharge(snap, r.quantity);
    push(r.estimate_id, {
      key: `component:${snap.irrigation_component_id}`,
      label: snap.name,
      unit: snap.unit === "foot" ? "FT" : "EA",
      quantity: charge.quantity,
      manHours: charge.manHours,
    });
  }

  // Plants and sod both live in estimate_areas and are told apart by META, not
  // by kind — kind is GEOMETRY, meta is what the thing is.
  const areasByEstimate = new Map<string, AreaRow[]>();
  for (const a of (areaRes.data ?? []) as AreaRow[]) {
    const bucket = areasByEstimate.get(a.estimate_id);
    if (bucket) bucket.push(a);
    else areasByEstimate.set(a.estimate_id, [a]);
  }

  for (const [estimateId, areas] of areasByEstimate) {
    for (const row of buildPlantLegend(areas.filter(isPlantArea))) {
      // The legend keys on price as well, so a re-priced catalogue does not
      // merge rows. A RATE does not care what the plant sold for, so the price
      // is dropped here and product plus size identifies the row.
      const [productId, size] = row.key.split("|");
      push(estimateId, {
        key: `plant:${productId}|${size}`,
        label: `${row.name} — ${row.size}`,
        unit: "EA",
        quantity: row.count,
        manHours: Math.round((row.total_minutes / 60) * 100) / 100,
      });
    }

    for (const area of areas.filter(isSodArea)) {
      const sod = sodEstimateForArea(area);
      if (!sod) continue;
      push(estimateId, {
        key: `sod:${sod.snapshot.sod_product_id}`,
        label: sod.snapshot.name,
        // Per THOUSAND square feet, matching how the sod catalogue stores it,
        // so an observed rate drops straight into that column.
        unit: "MSF",
        quantity: Math.round((sod.estimate.grossSqft / 1000) * 1000) / 1000,
        manHours: sod.estimate.manHours,
      });
    }
  }

  const entriesByJob = new Map<string, ClockEntry[]>();
  for (const e of (timeRes.data ?? []) as {
    id: string; job_id: string | null; clock_in_at: string | null;
    clock_out_at: string | null; crew_size: number | null;
  }[]) {
    if (!e.job_id) continue;
    const entry: ClockEntry = {
      id: e.id, jobId: e.job_id, clockInAt: e.clock_in_at,
      clockOutAt: e.clock_out_at, crewSize: e.crew_size,
    };
    const bucket = entriesByJob.get(e.job_id);
    if (bucket) bucket.push(entry);
    else entriesByJob.set(e.job_id, [entry]);
  }

  const records: JobRecord[] = estimates.map((e) => ({
    jobId: e.job_id,
    estimateId: e.id,
    jobName: jobNames.get(e.job_id) ?? e.title ?? "Untitled job",
    completedAt: null,
    lines: linesByEstimate.get(e.id) ?? [],
    entries: entriesByJob.get(e.job_id) ?? [],
    mobilizationHours:
      typeof e.mobilization_hours === "number" && Number.isFinite(e.mobilization_hours)
        ? e.mobilization_hours
        : 0,
  }));

  const estimated = new Set(estimates.map((e) => e.job_id));
  let jobsWithoutEstimate = 0;
  for (const jobId of entriesByJob.keys()) {
    if (!estimated.has(jobId)) jobsWithoutEstimate += 1;
  }

  return { records, jobsWithoutEstimate, error: null };
}

/**
 * Write ONE accepted suggestion back to whichever catalogue it came from.
 *
 * This is the only function in this file that writes, and it runs because a
 * person pressed a button on a specific row. Nothing is applied in bulk and
 * nothing is applied automatically — the point of the screen is that the org
 * decides.
 */
export async function applySuggestion(
  supabase: SupabaseClient,
  key: string,
  manMinutesPerUnit: number
): Promise<string | null> {
  if (!Number.isFinite(manMinutesPerUnit) || manMinutesPerUnit < 0) {
    return "That is not a usable rate.";
  }
  const sep = key.indexOf(":");
  if (sep < 0) return "Unrecognised catalogue row.";
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);

  if (kind === "labor") {
    return updateLaborItem(supabase, id, { install_minutes: manMinutesPerUnit });
  }
  if (kind === "component") {
    return updateComponent(supabase, id, { install_minutes: manMinutesPerUnit });
  }
  if (kind === "sod") {
    return updateSodProduct(supabase, id, {
      install_minutes_per_1000_sqft: Math.round(manMinutesPerUnit),
    });
  }
  if (kind === "plant") {
    // The plant key carries product and size; sizes are their own rows, so the
    // size id has to be looked up rather than assumed.
    const sepIdx = id.indexOf("|");
    if (sepIdx < 0) return "Unrecognised catalogue row.";
    const productId = id.slice(0, sepIdx);
    const size = id.slice(sepIdx + 1);
    const { data, error } = await supabase
      .from("plant_product_sizes")
      .select("id")
      .eq("plant_product_id", productId)
      .eq("size", size)
      .maybeSingle();
    if (error) return error.message;
    if (!data) return "That size is no longer in the catalogue.";
    return updatePlantSize(supabase, (data as { id: string }).id, {
      install_minutes: Math.round(manMinutesPerUnit),
    });
  }
  return "Unrecognised catalogue row.";
}

/**
 * The rate each catalogue row carries TODAY, keyed to match the task lines.
 *
 * Read live rather than taken from the estimate snapshots: a snapshot records
 * what the row was worth when it was quoted, and the screen has to show what
 * pressing Apply would actually change.
 */
export async function loadCurrentRates(
  supabase: SupabaseClient,
  organizationId: string
): Promise<Map<string, number>> {
  const rates = new Map<string, number>();

  const [labor, components, plantSizes, sod] = await Promise.all([
    supabase.from("labor_items").select("id, install_minutes").eq("organization_id", organizationId),
    supabase.from("irrigation_components").select("id, install_minutes").eq("organization_id", organizationId),
    supabase.from("plant_product_sizes")
      .select("plant_product_id, size, install_minutes").eq("organization_id", organizationId),
    supabase.from("sod_products")
      .select("id, install_minutes_per_1000_sqft").eq("organization_id", organizationId),
  ]);

  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  for (const r of (labor.data ?? []) as { id: string; install_minutes: unknown }[]) {
    rates.set(`labor:${r.id}`, num(r.install_minutes));
  }
  for (const r of (components.data ?? []) as { id: string; install_minutes: unknown }[]) {
    rates.set(`component:${r.id}`, num(r.install_minutes));
  }
  for (const r of (plantSizes.data ?? []) as
    { plant_product_id: string; size: string; install_minutes: unknown }[]) {
    rates.set(`plant:${r.plant_product_id}|${r.size}`, num(r.install_minutes));
  }
  for (const r of (sod.data ?? []) as
    { id: string; install_minutes_per_1000_sqft: unknown }[]) {
    rates.set(`sod:${r.id}`, num(r.install_minutes_per_1000_sqft));
  }

  return rates;
}
