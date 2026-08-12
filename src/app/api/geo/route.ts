import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// IP-geolocation fallback for when device GPS is denied. Vercel exposes the
// caller's approximate lat/lng via request headers (no external service, no
// API key). Coarse — city/region level — but better than no location at all.
// In local dev these headers are absent, so this returns 404 and the client
// surfaces "location unavailable". Requires auth (returns the caller's OWN
// IP location, so no cross-user leak).
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const h = await headers();
  const lat = h.get("x-vercel-ip-latitude");
  const lng = h.get("x-vercel-ip-longitude");
  if (!lat || !lng) {
    return NextResponse.json({ error: "Location unavailable" }, { status: 404 });
  }
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  if (Number.isNaN(la) || Number.isNaN(ln)) {
    return NextResponse.json({ error: "Location unavailable" }, { status: 404 });
  }
  return NextResponse.json({ lat: la, lng: ln, source: "ip" });
}