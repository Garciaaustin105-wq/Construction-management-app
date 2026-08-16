import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";

// /api/lawn/geocode — office-only helpers for the lawn route map.
//
// GET ?address=<text>  → server-side Nominatim (OpenStreetMap) geocode, returns
//   { lat, lng, display_name } or 404 if no match. Server-side so the request
//   carries a proper User-Agent (Nominatim's usage policy requires one) and the
//   public endpoint is only hit from our server, not the browser. Free, no API
//   key; rate-limited to 1 req/s by Nominatim policy — the client throttles bulk.
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, ok: false as const, status: 401 };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!OFFICE_LIKE.has(role as never))
    return { supabase, ok: false as const, status: 403 };
  return { supabase, ok: true as const };
}

export async function GET(req: Request) {
  const authed = await requireOffice();
  if (!authed.ok)
    return NextResponse.json({ error: "Unauthorized" }, { status: authed.status });

  const { searchParams } = new URL(req.url);
  const address = (searchParams.get("address") ?? "").trim();
  if (!address)
    return NextResponse.json({ error: "address is required" }, { status: 400 });

  // Nominatim public endpoint. countrycodes us,ca keeps results relevant;
  // limit=1 to minimize payload. A descriptive User-Agent is required by policy.
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us,ca&q=" +
    encodeURIComponent(address);

  // Nominatim's public instance enforces ~1 request/second. A rapid second
  // geocode from the office (or a bulk-run collision) gets 429. Wait and retry
  // once before surfacing a failure so quick back-to-back clicks "just work"
  // instead of erroring on every stop after the first.
  const doFetch = () =>
    fetch(url, {
      headers: {
        "User-Agent": "TerraVerdeLawnApp/1.0 (route planning)",
        Accept: "application/json",
      },
      // Don't cache — addresses change and Nominatim results shouldn't be stale.
      cache: "no-store",
    });

  let nominRes: Response;
  try {
    nominRes = await doFetch();
  } catch {
    return NextResponse.json(
      { error: "Geocoding service unreachable" },
      { status: 502 }
    );
  }
  if (nominRes.status === 429 || nominRes.status === 503) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      nominRes = await doFetch();
    } catch {
      return NextResponse.json(
        { error: "Geocoding service unreachable" },
        { status: 502 }
      );
    }
  }
  // Still rate-limited after the retry — tell the client clearly (not a generic
  // 502) so it can toast "wait a moment and try again" instead of "failed".
  if (nominRes.status === 429 || nominRes.status === 503) {
    return NextResponse.json(
      { error: "Geocoder rate-limited — wait a moment and try again" },
      { status: 429 }
    );
  }
  if (!nominRes.ok) {
    return NextResponse.json(
      { error: `Geocoder returned ${nominRes.status}` },
      { status: 502 }
    );
  }
  const results = (await nominRes.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  if (!results.length)
    return NextResponse.json({ error: "No match" }, { status: 404 });

  const r = results[0];
  return NextResponse.json({
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    display_name: r.display_name,
  });
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