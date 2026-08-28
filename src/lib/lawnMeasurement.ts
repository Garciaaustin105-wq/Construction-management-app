// Lawn measurement — shared contract for the LawnMeasurementMap component and
// anything that consumes estimates.measured_sqft / map_lat / map_lng (the
// columns added by migration lawn_estimator_convert_on_invoice_paid; the DB
// convert trigger carries them onto lawn_jobs on invoice-paid conversion).
//
// Contract-first per [[lowvoltage-opus-heavy-delegation]]: the UI builds
// against these helpers, not against ad-hoc math.

import type { SupabaseClient } from "@supabase/supabase-js";

// m² → sq ft
const SQFT_PER_SQM = 10.7639104167097;

// Area of a closed polygon path in SQUARE FEET. `path` is the polygon's path
// (google.maps.MVCArray<google.maps.LatLng> or LatLng[]). Uses the Maps
// geometry library's spherical area (accounts for lat/lng distortion), so the
// map must load the `geometry` library (see src/lib/googleMaps.ts).
export function polygonAreaSqft(path: unknown): number {
  const g = (globalThis as unknown as { google?: typeof google }).google;
  if (!g?.maps?.geometry?.spherical) return 0;
  const areaSqM = g.maps.geometry.spherical.computeArea(
    path as google.maps.MVCArray<google.maps.LatLng>
  );
  // computeArea can go negative for a clockwise-wound path; clamp.
  return Math.round(Math.abs(areaSqM) * SQFT_PER_SQM);
}

// The measurement payload as stored on the estimate row. lat/lng are the
// polygon's visual center (used later to seed service-zone lookup via
// find_zone_for_point and to carry onto lawn_jobs at conversion).
export type EstimateMeasurement = {
  measured_sqft: number;
  map_lat: number | null;
  map_lng: number | null;
};

// Persist a measurement onto the estimate (office RLS — caller passes the
// browser/session client). Returns the error message or null on success.
export async function saveEstimateMeasurement(
  supabase: SupabaseClient,
  estimateId: string,
  m: EstimateMeasurement
): Promise<string | null> {
  const { error } = await supabase
    .from("estimates")
    .update({
      measured_sqft: m.measured_sqft,
      map_lat: m.map_lat,
      map_lng: m.map_lng,
    })
    .eq("id", estimateId);
  return error?.message ?? null;
}

// A ready-made per-sqft price hint: sqft × rate, rounded to the cent.
export function sqftPrice(sqft: number, ratePerSqft: number): number {
  return Math.round(sqft * ratePerSqft * 100) / 100;
}

// A lawn_services row that has an opt-in $/sqft rate set (see
// lawn_services_price_per_sqft.sql) — services without one can't price a
// measured area and are excluded by listPricedServices below.
export type PricedService = {
  id: string;
  name: string;
  price_per_sqft: number;
};

export async function listPricedServices(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ data: PricedService[]; error: string | null }> {
  const { data, error } = await supabase
    .from("lawn_services")
    .select("id, name, price_per_sqft")
    .eq("organization_id", orgId)
    .eq("active", true)
    .not("price_per_sqft", "is", null)
    .order("name");
  return {
    data: (data as unknown as PricedService[]) ?? [],
    error: error?.message ?? null,
  };
}