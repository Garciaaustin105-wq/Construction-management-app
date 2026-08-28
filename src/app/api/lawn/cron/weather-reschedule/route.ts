import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";

// Daily weather check → auto-reschedule tomorrow's visits. For every org that
// opted in (organizations.auto_weather_reschedule_enabled) AND has service
// coordinates set (service_area_lat/lng), fetches tomorrow's forecast from
// api.weather.gov (free, no key, US-only — requires a descriptive User-Agent),
// and on a rain/storm match calls the DB-side trigger_weather_reschedule RPC
// (which guards the opt-in again server-side and respects crew capacity,
// time off, and blackout dates through crew_has_capacity).
//
// Postgres never makes the HTTP call — this route is the weather check; the DB
// function is the reschedule. See migration weather_reschedule_settings_and_trigger_fn.
//
// Approximation, on purpose: "tomorrow" is computed in UTC. For CONUS orgs the
// 05:23 UTC run lands within one calendar day of local "tomorrow" everywhere,
// which is acceptable for a v1 — the forecast day check uses the period's LOCAL
// date (api.weather.gov startTimes carry the station's local offset).
//
// No-op today for orgs with null coords (both live lawn orgs) — the settings UI
// that geocodes the org address and sets service_area_lat/lng is the enabler.
//
// Same deployment contract as every platform cron: CRON_SECRET bearer auth, the
// construction-deploy ownership gate, service role, 60s ceiling.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rain probability at or above this = reschedule. Anything stormier
// (thunderstorm/severe wording) also matches via keywords regardless of pop.
const POP_THRESHOLD = 50;
const SEVERE_RE = /thunderstorm|severe|heavy rain|torrential|hail/i;
const RAIN_RE = /rain|showers|drizzle|storms/i;

type OrgRow = { id: string; service_area_lat: number; service_area_lng: number };

function utcDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type ForecastPeriod = {
  startTime: string;
  detailedForecast: string | null;
  probabilityOfPrecipitation: { value: number | null } | null;
};

async function fetchTomorrowBadWeather(
  lat: number,
  lng: number,
  targetDate: string
): Promise<{ bad: boolean; summary: string }> {
  const headers = {
    // api.weather.gov requires an identifiable UA (product + contact).
    "User-Agent": "TerraVerde/1.0 (weather-reschedule cron)",
    Accept: "application/geo+json",
  };

  const pointRes = await fetch(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
    { headers }
  );
  if (!pointRes.ok) throw new Error(`weather.gov points ${pointRes.status}`);
  const point = (await pointRes.json()) as {
    properties?: { forecast?: string };
  };
  const forecastUrl = point.properties?.forecast;
  if (!forecastUrl) throw new Error("no forecast URL in points response");

  const fcRes = await fetch(forecastUrl, { headers });
  if (!fcRes.ok) throw new Error(`weather.gov forecast ${fcRes.status}`);
  const fc = (await fcRes.json()) as { properties?: { periods?: ForecastPeriod[] } };
  const periods = fc.properties?.periods ?? [];

  const reasons: string[] = [];
  for (const p of periods) {
    // Period startTime is LOCAL ISO with offset — its date part is the local
    // day, which is exactly the day we're comparing against.
    const periodDate = (p.startTime ?? "").slice(0, 10);
    if (periodDate !== targetDate) continue;
    const pop = p.probabilityOfPrecipitation?.value ?? null;
    const text = p.detailedForecast ?? "";
    if (pop !== null && pop >= POP_THRESHOLD) {
      reasons.push(`${pop}% precip — ${text}`);
      continue;
    }
    if (SEVERE_RE.test(text)) {
      reasons.push(text);
      continue;
    }
    // Plain "chance of showers" under the threshold is NOT bad weather.
    if (RAIN_RE.test(text) && (pop ?? 0) >= POP_THRESHOLD) reasons.push(text);
  }

  return { bad: reasons.length > 0, summary: reasons.join(" | ").slice(0, 500) };
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 401 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isLawn()) {
    return NextResponse.json({ ok: true, skipped: "construction owns cron" });
  }

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured (service role missing)" },
      { status: 500 }
    );
  }
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, service_area_lat, service_area_lng")
    .eq("auto_weather_reschedule_enabled", true)
    .not("service_area_lat", "is", null)
    .not("service_area_lng", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const targetDate = utcDateOffset(1);
  const results: Record<string, unknown>[] = [];

  for (const org of (orgs as unknown as OrgRow[]) ?? []) {
    try {
      const { bad, summary } = await fetchTomorrowBadWeather(
        org.service_area_lat,
        org.service_area_lng,
        targetDate
      );
      if (!bad) {
        results.push({ orgId: org.id, targetDate, weather: "ok" });
        continue;
      }
      const { data, error: rpcErr } = await admin.rpc(
        "trigger_weather_reschedule",
        {
          p_org_id: org.id,
          p_from_date: targetDate,
          p_to_date: utcDateOffset(2),
          p_reason: "weather",
        }
      );
      if (rpcErr) throw new Error(rpcErr.message);
      results.push({ orgId: org.id, targetDate, weather: summary, ...(data as object) });
    } catch (err) {
      // One org's failure must not skip the rest; Sentry keeps it visible.
      captureException(err instanceof Error ? err : new Error(String(err)));
      results.push({
        orgId: org.id,
        targetDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    orgsChecked: orgs?.length ?? 0,
    targetDate,
    results,
  });
}