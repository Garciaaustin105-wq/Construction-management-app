// Curated generic-US inspection checklists for the Inspections feature.
//
// Source: research on U.S. city building-department published inspection lists
// (Philadelphia PA, College Station TX, Galveston TX, San Antonio TX, Provo UT).
// Residential projects run ~12 inspections; commercial 25-40+. This is the
// generic US baseline — per-jurisdiction templates keyed to the job's location
// are a follow-up (would add an inspection_templates table + city lists once a
// specific city is named). For now this constant is the single source of truth:
// version-controlled, editable, seeded into job_inspections rows when the
// office/PM clicks "Generate checklist".

import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectType = "commercial" | "residential";

export interface InspectionTemplateItem {
  title: string;
}

export const RESIDENTIAL_INSPECTIONS: InspectionTemplateItem[] = [
  { title: "Initial Site Inspection" },
  { title: "Footing / Foundation" },
  { title: "Foundation Wall" },
  { title: "Under-Slab (plumbing / electrical)" },
  { title: "Plumbing Rough-In" },
  { title: "Electrical Rough-In" },
  { title: "Mechanical Rough-In" },
  { title: "Plumbing Top-Out" },
  { title: "Framing Inspection (exterior + interior)" },
  { title: "Insulation" },
  { title: "Wallboard" },
  { title: "Finals — Plumbing / Electrical / Mechanical / Building (CO)" },
];

export const COMMERCIAL_INSPECTIONS: InspectionTemplateItem[] = [
  { title: "Pre-Construction / Site Inspection" },
  { title: "Footing / Foundation (incl. 3rd-party engineer)" },
  { title: "Foundation Wall / CMU Reinforcing Steel" },
  { title: "Under-Slab (incl. med-gas)" },
  { title: "Plumbing Rough-In" },
  { title: "Electrical Rough-In" },
  { title: "Mechanical Rough-In" },
  { title: "Partial Framing / Cover-Up (firewall)" },
  { title: "Shear Wall / Designed Sheathing Nail Pattern" },
  { title: "Fire-Rated Assemblies & Penetrations" },
  { title: "Roof Drain / Storm Water Plumbing" },
  { title: "Grease Trap / Interceptor (kitchens)" },
  { title: "Vent Hood (commercial kitchens)" },
  { title: "Walk-In Cooler" },
  { title: "Fire Suppression — Rough" },
  { title: "Fire Suppression — Hydrostatic Test" },
  { title: "Fire Suppression — Final" },
  { title: "Fire Alarm Certification" },
  { title: "Special Inspections (IBC 1705)" },
  { title: "Insulation" },
  { title: "Wallboard" },
  { title: "Prefinal Walkthrough" },
  { title: "Temporary Certificate of Occupancy (TCO)" },
  { title: "Finals — All Trades (MEP, Fire, Health, Traffic, Landscape, Drainage, Sign)" },
  { title: "Final Building Inspection / Certificate of Occupancy" },
];

// Pick the template for a job's project_type. Unknown/null defaults to the
// residential baseline (the lighter checklist) so old jobs can still generate.
export function templateFor(projectType: string | null): InspectionTemplateItem[] {
  return projectType === "commercial" ? COMMERCIAL_INSPECTIONS : RESIDENTIAL_INSPECTIONS;
}

// Human label for the project-type badge.
export function projectTypeLabel(projectType: string | null): string {
  if (projectType === "commercial") return "Commercial";
  if (projectType === "residential") return "Residential";
  return "—";
}

// Seed a job's inspection checklist from the curated template. Idempotent at
// the call site (only invoke when the job has zero rows). Inserts rows with
// status='required', position = index. organization_id is stamped by the
// set_org_from_job BEFORE-INSERT trigger (so it is NOT sent here). Returns the
// count of inserted rows (0 on error).
export async function seedJobInspections(
  supabase: SupabaseClient,
  jobId: string,
  projectType: string | null,
  createdBy: string
): Promise<number> {
  const items = templateFor(projectType);
  const rows = items.map((it, i) => ({
    job_id: jobId,
    title: it.title,
    position: i,
    status: "required",
    created_by: createdBy,
  }));
  const { data, error } = await supabase
    .from("job_inspections")
    .insert(rows)
    .select("id");
  if (error || !data) return 0;
  return data.length;
}