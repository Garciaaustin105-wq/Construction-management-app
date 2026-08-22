import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";

// /api/lawn/geocode — office-only pin saver for the lawn route map.
//
// Geocoding itself moved CLIENT-SIDE: the office RouteMapPlanner now geocodes a
// job's address in-browser via the Google Maps Geocoder (under
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) and posts the resolved lat/lng here to
// persist. The old server-side Nominatim GET handler is gone (Nominatim
// dependency removed with the Leaflet swap).
//
// POST { jobId, lat, lng } → upsert lawn_jobs { map_lat, map_lng } for the job
//   (the 1:1 lawn_jobs profile, PK = jobs.id). Uses the RLS session client (no
//   service-role key): office role has `for all` on lawn_jobs. organization_id
//   is resolved from the job (RLS scopes the read to the caller's org) and
//   re-supplied on upsert (lawn_jobs has no set_org_from_job trigger). This is
//   the same upsert pattern as src/components/LawnPropertyDetails.tsx.
export const dynamic = "force-dynamic";

async function requireOffice() {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) return { supabase, ok: false as const, status: 401 };
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never))
    return { supabase, ok: false as const, status: 403 };
  return { supabase, ok: true as const };
}

export async function POST(req: Request) {
  const authed = await requireOffice();
  if (!authed.ok)
    return NextResponse.json({ error: "Unauthorized" }, { status: authed.status });
  const supabase = authed.supabase;

  let body: { jobId?: string; lat?: number; lng?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { jobId, lat, lng } = body;
  if (!jobId || typeof lat !== "number" || typeof lng !== "number")
    return NextResponse.json(
      { error: "jobId, lat, lng are required" },
      { status: 400 }
    );

  // Resolve the job's organization_id (RLS scopes the read to our org) so we
  // can re-supply it on the lawn_jobs upsert (lawn_jobs has no org trigger).
  const { data: job } = await supabase
    .from("jobs")
    .select("organization_id")
    .eq("id", jobId)
    .single();
  if (!job?.organization_id)
    return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { error } = await supabase
    .from("lawn_jobs")
    .upsert(
      {
        id: jobId,
        organization_id: job.organization_id,
        map_lat: lat,
        map_lng: lng,
      },
      { onConflict: "id" }
    );
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}