// Multi-area lawn measurement — contract for the v2 measurement map redesign
// (docs/handoff-estimator-v2-2026-08-28.md). Replaces the single-polygon
// model in lawnMeasurement.ts with named/colored `estimate_areas` rows, one
// per drawn shape (front yard, back beds, etc.).
//
// Contract-first per the Claude-direct/local-AI split: the drawing surface,
// area sidebar, and QuickQuoteForm v2 build against these exports, not
// against ad-hoc math or inline Supabase calls.
//
// IMPORTANT — keeps the live DB trigger fed: `convert_estimate_on_invoice_paid`
// (migration lawn_estimator_convert_on_invoice_paid, live in prod) still reads
// the legacy `estimates.measured_sqft` / `map_lat` / `map_lng` columns to seed
// `lawn_jobs` on conversion. `estimate_areas` does NOT replace those columns —
// `syncEstimateTotals` below keeps them in sync (sum of all areas' sqft,
// centroid of the largest area) every time an area is added/edited/deleted, so
// the existing trigger keeps working unmodified.

import type { SupabaseClient } from "@supabase/supabase-js";
import { polygonAreaSqft } from "@/lib/lawnMeasurement";

export type LatLng = { lat: number; lng: number };

export type AreaKind = "area" | "line" | "point";

export type EstimateArea = {
  id: string;
  estimate_id: string;
  name: string;
  color: string;
  polygon: LatLng[];
  area_sqft: number;
  // How to read `polygon`. Phase 1 of the estimator roadmap made this table
  // hold more than rings: a sprinkler head is a POINT, a pipe run is a LINE,
  // a mulch bed is still an AREA. `polygon` keeps its name and means "the
  // coordinate list" — one entry for a point, an open path for a line, a
  // closed ring for an area. App-validated on purpose (no CHECK), so a new
  // item type never needs a migration.
  kind: AreaKind;
  // Run length for kind="line". An area has no length and a point has
  // neither, so both stay 0 rather than null — the column is NOT NULL and
  // summing a column of nulls is a nuisance every caller would repeat.
  length_ft: number;
  // Per-kind detail with no column of its own: coverage radius for a head,
  // species and size for a plant, diameter for a pipe.
  meta: Record<string, unknown>;
  service_type: string | null;
  notes: string | null;
  // Access/obstacle chips picked while drawing (narrow gate, steep slope,
  // etc.) — front-loads what used to only get captured on lawn_jobs AFTER
  // conversion, i.e. after the price was already locked in. Rolled up into
  // the new job's `obstacles` field by convert_estimate_on_invoice_paid at
  // conversion time (see estimate_areas_access_tags.sql).
  access_tags: string[];
  created_at: string;
};

// Quick-pick chips for the drawing UI. Deliberately about MOWER ACCESS /
// physical obstacles, not chemical-safety — that's the separate, existing
// `lawn_jobs.sensitive_site_tags` (compliance-focused: daycare, pond, bee
// hives, etc.). Keep these two tag sets conceptually apart.
export const ACCESS_TAG_PRESETS = [
  "narrow gate",
  "steep slope",
  "irrigation heads",
  "septic lid",
  "low branches",
  "locked gate",
  "dog on site",
  "fragile hardscape nearby",
] as const;

// 8-color palette, auto-cycled per new area (pain #2 — color codes).
export const AREA_COLORS = [
  "#22c55e", // green
  "#3b82f6", // blue
  "#f97316", // orange
  "#a855f7", // purple
  "#ef4444", // red
  "#06b6d4", // cyan
  "#eab308", // yellow
  "#ec4899", // pink
] as const;

// Next color in the palette given the colors already in use on this
// estimate — cycles back to the start once all 8 are taken.
export function nextAreaColor(usedColors: string[]): string {
  const used = new Set(usedColors);
  const free = AREA_COLORS.find((c) => !used.has(c));
  return free ?? AREA_COLORS[usedColors.length % AREA_COLORS.length];
}

// Area of a polygon path (plain lat/lng points — no `google.maps` dependency,
// unlike lawnMeasurement's polygonAreaSqft which takes a Maps path type).
// Delegates to the same spherical math via a throwaway MVCArray-shaped input.
export function areaSqftFromPoints(points: LatLng[]): number {
  if (points.length < 3) return 0;
  const g = (globalThis as unknown as { google?: typeof google }).google;
  if (!g?.maps?.geometry?.spherical) return 0;
  const path = points.map((p) => new g.maps.LatLng(p.lat, p.lng));
  return polygonAreaSqft(path);
}

// Average of a polygon's vertices — used both as the area's own center
// (map pan/fit) and as an input to the estimate-level centroid below.
export function polygonCenter(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

export function totalAreaSqft(areas: Pick<EstimateArea, "area_sqft">[]): number {
  return areas.reduce((sum, a) => sum + (a.area_sqft || 0), 0);
}

const AREA_COLUMNS =
  "id, estimate_id, name, color, polygon, area_sqft, service_type, notes, access_tags, created_at";

export async function listEstimateAreas(
  supabase: SupabaseClient,
  estimateId: string
): Promise<{ data: EstimateArea[]; error: string | null }> {
  const { data, error } = await supabase
    .from("estimate_areas")
    .select(AREA_COLUMNS)
    .eq("estimate_id", estimateId)
    .order("created_at", { ascending: true });
  return { data: (data as unknown as EstimateArea[]) ?? [], error: error?.message ?? null };
}

export type NewEstimateArea = {
  estimate_id: string;
  organization_id: string;
  name: string;
  color: string;
  polygon: LatLng[];
  area_sqft: number;
  // Omitted means an area: the columns carry DB defaults, so existing
  // callers that only ever drew polygons keep working untouched.
  kind?: AreaKind;
  length_ft?: number;
  meta?: Record<string, unknown>;
  service_type?: string | null;
  notes?: string | null;
  access_tags?: string[];
};

export async function createEstimateArea(
  supabase: SupabaseClient,
  area: NewEstimateArea
): Promise<{ data: EstimateArea | null; error: string | null }> {
  const { data, error } = await supabase
    .from("estimate_areas")
    .insert(area)
    .select(AREA_COLUMNS)
    .single();
  return { data: (data as unknown as EstimateArea) ?? null, error: error?.message ?? null };
}

export async function updateEstimateArea(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<EstimateArea, "name" | "color" | "polygon" | "area_sqft" | "service_type" | "notes" | "access_tags">>
): Promise<string | null> {
  const { error } = await supabase.from("estimate_areas").update(patch).eq("id", id);
  return error?.message ?? null;
}

export async function deleteEstimateArea(
  supabase: SupabaseClient,
  id: string
): Promise<string | null> {
  const { error } = await supabase.from("estimate_areas").delete().eq("id", id);
  return error?.message ?? null;
}

// Roll every area up onto the legacy estimate-level columns the live
// conversion trigger reads: total sqft across all areas, and the centroid of
// the LARGEST area (a better single map pin than averaging every area's
// center together, which can land outside the property on an L-shaped lot).
// Call this after any area create/update/delete.
export async function syncEstimateTotals(
  supabase: SupabaseClient,
  estimateId: string,
  areas: EstimateArea[]
): Promise<string | null> {
  const largest = areas.reduce<EstimateArea | null>(
    (best, a) => (!best || a.area_sqft > best.area_sqft ? a : best),
    null
  );
  const center = largest ? polygonCenter(largest.polygon) : null;
  const { error } = await supabase
    .from("estimates")
    .update({
      measured_sqft: totalAreaSqft(areas),
      map_lat: center?.lat ?? null,
      map_lng: center?.lng ?? null,
    })
    .eq("id", estimateId);
  return error?.message ?? null;
}

/**
 * Which outline edge does a click land on, and where exactly?
 *
 * Clicking the map used to APPEND a vertex to the end of the outline. So once
 * a shape was roughly drawn, adding detail to a run you had already passed
 * threw a point onto the end instead — the outline shot across the yard to
 * reach it, which reads as "it generated another area". The midpoint handles
 * only ever insert at the exact middle of an edge, so refining a long run
 * meant halving it repeatedly.
 *
 * Returns the index to splice at and the point ON the edge (perpendicular
 * foot, not the raw click), so an inserted dot sits exactly on the line rather
 * than a few feet off it.
 *
 * Geometry is planar in metres: over a single property the error from ignoring
 * the earth's curvature is far below a pixel. Longitude is scaled by cos(lat)
 * because a degree of longitude narrows as you leave the equator — without it
 * the hit test is skewed east-west and gets worse the further from the equator
 * the job is.
 */
const M_PER_DEG_LAT = 111_320;

export function edgeHitAt(
  click: LatLng,
  verts: LatLng[],
  tolMeters: number
): { index: number; point: LatLng } | null {
  if (verts.length < 2) return null;
  const kLng = Math.cos((click.lat * Math.PI) / 180) * M_PER_DEG_LAT;
  const toM = (p: LatLng) => ({ x: p.lng * kLng, y: p.lat * M_PER_DEG_LAT });
  const c = toM(click);

  // A 2-vertex draft is a single open line; 3+ is a closed ring, so the
  // last->first edge is real and must be testable too.
  const edgeCount = verts.length >= 3 ? verts.length : 1;
  let best: { index: number; point: LatLng; d: number } | null = null;

  for (let i = 0; i < edgeCount; i++) {
    const a = toM(verts[i]);
    const b = toM(verts[(i + 1) % verts.length]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue; // duplicate vertices — no edge to hit
    // Clamped projection: t outside [0,1] means the nearest point is an
    // endpoint, and a click near a CORNER should not silently insert a
    // duplicate vertex on top of one that already exists.
    const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(c.x - px, c.y - py);
    if (d > tolMeters) continue;
    if (t <= 0.02 || t >= 0.98) continue; // too close to an existing vertex
    if (!best || d < best.d) {
      best = {
        index: i + 1,
        point: { lat: py / M_PER_DEG_LAT, lng: px / kLng },
        d,
      };
    }
  }
  return best ? { index: best.index, point: best.point } : null;
}

/**
 * Run length of an open path, in feet.
 *
 * The counterpart to areaSqftFromPoints for kind="line" — pipe runs, edging,
 * fence. Open, not closed: unlike an area, the last point does NOT join back
 * to the first, because a pipe that ran back to where it started would be
 * billed for a leg nobody laid.
 *
 * Planar in metres with longitude scaled by cos(lat), same as edgeHitAt above.
 * Over one property the curvature error is far below the accuracy of clicking
 * a satellite tile; dropping the latitude term, though, would skew every
 * east-west run and get worse the further from the equator the job is.
 */
export function lengthFtFromPoints(points: LatLng[]): number {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const M_PER_FT = 0.3048;
  let metres = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const kLng = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * M_PER_DEG_LAT;
    const dx = (b.lng - a.lng) * kLng;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    metres += Math.hypot(dx, dy);
  }
  return Math.round((metres / M_PER_FT) * 10) / 10;
}
