import { createAdminClient } from "@/lib/supabase/admin";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";

// /api/lawn/route-optimize — server-side proxy for route optimization so the
// Google Distance Matrix call is billed + DAILY quota-capped per org (Step 7 of
// the capped-free-tier plan). The browser used to call Distance Matrix directly
// with the public key (uncapped, bypassable); now RouteMapPlanner POSTs the
// stops here, the route checks route_opt_quota (free 5/day, paid/trial
// unlimited, expired/canceled 0), calls Google with the SERVER key, records the
// usage, and returns an N×N duration matrix in seconds.
//
// Office/admin/PM only. Needs GOOGLE_MAPS_SERVER_KEY env (set on Vercel — a
// server-only, IP-restricted key, distinct from NEXT_PUBLIC_GOOGLE_MAPS_API_KEY).
// Without it the route returns 503 so the client falls back to a haversine
// estimate (no outage). Quota RPCs are SECURITY DEFINER service-role-only
// (revoke execute from public/anon/authenticated in route_opt_quota.sql).
export const dynamic = "force-dynamic";

type LatLng = { lat: number; lng: number };

async function requireOffice() {
  const me = await getMeIdentity();
  if (!me) return { me: null, ok: false as const, status: 401 };
  if (!OFFICE_LIKE.has(me.role as never))
    return { me: null, ok: false as const, status: 403 };
  return { me, ok: true as const };
}

// 2-25 points, each with finite numeric lat/lng. Google Distance Matrix caps at
// 25 origins/destinations per request; below 2 there's nothing to optimize.
function validPoints(ps: unknown): ps is LatLng[] {
  return (
    Array.isArray(ps) &&
    ps.length >= 2 &&
    ps.length <= 25 &&
    ps.every(
      (p) =>
        p != null &&
        typeof (p as LatLng).lat === "number" &&
        typeof (p as LatLng).lng === "number" &&
        Number.isFinite((p as LatLng).lat) &&
        Number.isFinite((p as LatLng).lng)
    )
  );
}

export async function POST(request: Request) {
  const authed = await requireOffice();
  if (!authed.ok)
    return NextResponse.json({ error: "Unauthorized" }, { status: authed.status });
  const me = authed.me!;

  let body: { origins?: unknown; destinations?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!validPoints(body.origins))
    return NextResponse.json(
      { error: "origins must be 2-25 {lat,lng} points" },
      { status: 400 }
    );
  const destinations: unknown =
    body.destinations && Array.isArray(body.destinations) ? body.destinations : body.origins;
  if (!validPoints(destinations) || (destinations as LatLng[]).length !== (body.origins as LatLng[]).length)
    return NextResponse.json(
      { error: "destinations must match origins length (2-25 points)" },
      { status: 400 }
    );

  const orgId = me.orgId;
  if (!orgId)
    return NextResponse.json({ error: "No organization" }, { status: 403 });

  // Quota check BEFORE Google → zero Google spend on a blocked request.
  // (check_route_opt_quota is an untyped SECURITY DEFINER RPC — its return
  //  shape isn't in the generated Supabase types, so cast it explicitly.)
  const admin = createAdminClient();
  const quota = (
    await admin.rpc("check_route_opt_quota", { p_org: orgId }).maybeSingle()
  ).data as { allowed: boolean; used: number; max: number | null } | null;
  if (!quota || !quota.allowed) {
    return NextResponse.json(
      {
        error:
          "Daily route-optimization limit reached on the Free plan. Upgrade for unlimited optimizations.",
        upgrade: true,
        used: quota?.used ?? null,
        max: quota?.max ?? null,
      },
      { status: 429 }
    );
  }

  const serverKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!serverKey)
    return NextResponse.json(
      { error: "Route optimization is not configured." },
      { status: 503 }
    );

  // Google Distance Matrix REST (server key). encodeURIComponent handles the
  // pipe separator + commas + any negative longitudes safely.
  const oStr = (body.origins as LatLng[]).map((p) => `${p.lat},${p.lng}`).join("|");
  const dStr = (destinations as LatLng[]).map((p) => `${p.lat},${p.lng}`).join("|");
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
    oStr
  )}&destinations=${encodeURIComponent(dStr)}&mode=driving&key=${serverKey}`;

  let googleRes: Response;
  try {
    googleRes = await fetch(url);
  } catch {
    return NextResponse.json({ error: "Google fetch failed" }, { status: 502 });
  }
  if (!googleRes.ok)
    return NextResponse.json({ error: "Google fetch failed" }, { status: 502 });

  const json = (await googleRes.json()) as {
    rows?: { elements?: { status?: string; duration?: { value?: unknown } }[] }[];
  };
  if (!json.rows || !Array.isArray(json.rows) || json.rows.length === 0)
    return NextResponse.json({ error: "Google returned no rows" }, { status: 502 });

  // N×N duration matrix in seconds. Unreachable pairs (status !== "OK" or no
  // duration.value) → null (JSON-safe; the client maps null → Infinity for
  // nearestNeighborByMatrix, matching the old in-browser DistanceMatrixService).
  const durations: (number | null)[][] = json.rows.map((row) =>
    (row.elements ?? []).map((el) => {
      if (el && el.status === "OK" && typeof el.duration?.value === "number") {
        return el.duration.value;
      }
      return null;
    })
  );

  // Record the optimization (best-effort). The quota was already checked, so a
  // record failure (e.g. a TOCTOU race where two requests passed check together)
  // is a minor under-count — it must NOT undo the optimization the user already
  // waited for. Swallow; the check_gate is the real enforcement.
  try {
    await admin.rpc("record_route_opt", { p_org: orgId, p_profile: me.user.id });
  } catch {
    // best-effort
  }

  return NextResponse.json({ durations });
}