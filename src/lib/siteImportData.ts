import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createEstimateArea,
  listEstimateAreas,
  type EstimateArea,
} from "@/lib/estimateAreas";
import type { ImportedArea } from "@/lib/siteImport";

/**
 * Database glue for src/lib/siteImport.ts.
 *
 * SPLIT FROM THE MATHS ON PURPOSE: siteImport.ts stays pure so its harness can
 * run standalone, the same way crewFeedback.ts is pure and crewFeedbackData.ts
 * is not.
 */

export type ImportTarget = {
  /** Areas already on the estimate, whatever their source. */
  existing: EstimateArea[];
  /** Total measured sqft already recorded, for the comparison line. */
  existingSqft: number;
  error: string | null;
};

export async function loadImportTarget(
  supabase: SupabaseClient,
  estimateId: string
): Promise<ImportTarget> {
  const { data, error } = await listEstimateAreas(supabase, estimateId);
  if (error) return { existing: [], existingSqft: 0, error };
  // Only closed areas carry square footage; a line or a point contributes none.
  const existingSqft = data
    .filter((a) => a.kind === "area")
    .reduce((sum, a) => sum + (Number(a.area_sqft) || 0), 0);
  return { existing: data, existingSqft: Math.round(existingSqft), error: null };
}

export type ImportResult = {
  written: number;
  skipped: number;
  error: string | null;
};

/**
 * Write imported paths onto an estimate.
 *
 * INSERTS ONLY. It never updates or deletes an existing area, and there is no
 * code path here that could: when the map says 4,200 sqft and a rover says
 * 3,850, keeping both is the entire point. The office chooses; the app does not
 * adjudicate between two measurements.
 *
 * Anything not `importable` is skipped rather than written half-formed — an
 * area with no unit chosen would carry a number that is wrong by 3.28x or
 * 10.76x and look completely ordinary.
 */
export async function importAreas(
  supabase: SupabaseClient,
  input: {
    estimateId: string;
    organizationId: string;
    areas: ImportedArea[];
    /** Free text from the upload step: file name, device, who ran it. */
    fileName: string;
  }
): Promise<ImportResult> {
  let written = 0;
  let skipped = 0;

  for (const area of input.areas) {
    if (!area.importable) {
      skipped += 1;
      continue;
    }

    // meta carries what has no column of its own. Elevation lives here rather
    // than in columns because it is optional detail, and putting it here means
    // the next device that brings something extra needs no migration.
    const meta: Record<string, unknown> = {
      import: {
        fileName: input.fileName,
        importedAt: new Date().toISOString(),
        issues: area.issues,
      },
    };
    if (area.zFt.length > 0) {
      // Stored in FEET, converted at import, so nothing downstream has to ask
      // what unit this is — the same reason length_ft is a foot column.
      meta.z = area.zFt;
    }
    if (area.elevation) meta.elevation = area.elevation;

    const { error } = await createEstimateArea(supabase, {
      estimate_id: input.estimateId,
      organization_id: input.organizationId,
      name: area.name,
      // Imported rows are visually distinct from drawn ones at a glance.
      color: "#7c3aed",
      polygon: area.polygon,
      area_sqft: area.areaSqft,
      kind: area.kind,
      length_ft: area.lengthFt,
      meta,
      source: area.source,
    });
    if (error) return { written, skipped, error };
    written += 1;
  }

  return { written, skipped, error: null };
}
