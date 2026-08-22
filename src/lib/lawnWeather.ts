import { headers } from "next/headers";
import { createClient as createServerClient } from "@/lib/supabase/server";

// Weather board for the Lawn hub. SERVER-ONLY — the US National Weather Service
// (NWS) API must never be called from the browser (CORS + their usage policy).
// Free, no API key, US-only. Shared by /api/lawn/weather and /lawn/weather so the
// route and the server page don't duplicate the NWS + aggregation logic.

const NWS_HEADERS = {
  Accept: "application/geo+json",
  "User-Agent": "TerraVistaLawn/1.0 (contact: ops@terravistabuilding.com)",
};
const RAIN_THRESHOLD = 50; // a day is "rain-risk" if max hourly precip >= this
const FETCH_TIMEOUT_MS = 8000;
const WINDOW_DAYS = 10;
// NWS forecasts change slowly and the points->grid mapping is stable, so cache
// both api.weather.gov fetches for 30 min across requests (Next Data Cache). The
// two calls are on the weather board's TTFB path (up to 16s cold); this turns
// repeat loads into a cache hit. force-dynamic on the route does not disable
// per-fetch revalidate caching.
const NWS_REVALIDATE_SECONDS = 1800;

export type DayForecast = { date: string; precipMax: number; rainRisk: boolean };
export type VisitByDate = { date: string; count: number; jobs: string[] };
export type WeatherBoard = {
  days: DayForecast[];
  visitsByDate: VisitByDate[];
  locationLabel: string;
  // How the forecast location was chosen — surfaced as a note so the user
  // knows what area/job the weather is for.
  //   "property" = an office-set map pin on the next scheduled lawn job
  //   "ip"       = Vercel IP geolocation fallback (no pin set on any visit)
  //   "none"     = no coords available; forecast unavailable
  locationSource: "property" | "ip" | "none";
  forecastAvailable: boolean;
};

// Supabase types these relation embeds loosely; cast via `as unknown as`.
type VisitRow = {
  id: string;
  due_date: string;
  jobs: {
    name: string;
    address: string | null;
    // lawn_jobs is a 1:1 profile (lawn_jobs.id FK -> jobs.id). Embeddable from
    // jobs because the FK exists; a direct lawn_visits->lawn_jobs join does not.
    lawn_jobs: { map_lat: number | null; map_lng: number | null } | null;
  } | null;
};

async function fetchWithTimeout(
  url: string,
  opts: RequestInit = {},
  ms = FETCH_TIMEOUT_MS
): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      next: { revalidate: NWS_REVALIDATE_SECONDS },
      signal: ctrl.signal,
    });
  } catch {
    return null; // abort / network / DNS — caller treats as "unavailable"
  } finally {
    clearTimeout(t);
  }
}

// Fetch the NWS hourly forecast for a point and bucket the MAX precip
// probability per local calendar day (date = ISO slice [0,10)). Returns null if
// anything along the points -> forecastHourly chain fails — the board then
// renders with forecastAvailable:false (visits still show).
async function getNwsForecast(
  lat: number,
  lng: number
): Promise<DayForecast[] | null> {
  const pointsRes = await fetchWithTimeout(
    `https://api.weather.gov/points/${lat},${lng}`,
    { headers: NWS_HEADERS }
  );
  if (!pointsRes || !pointsRes.ok) return null;
  let pointsJson: { properties?: { forecastHourly?: string } } | null = null;
  try {
    pointsJson = await pointsRes.json();
  } catch {
    return null;
  }
  const hourlyUrl = pointsJson?.properties?.forecastHourly;
  if (!hourlyUrl) return null;

  const hourlyRes = await fetchWithTimeout(hourlyUrl, { headers: NWS_HEADERS });
  if (!hourlyRes || !hourlyRes.ok) return null;
  let hourlyJson: {
    properties?: {
      periods?: Array<{
        startTime?: string;
        probabilityOfPrecipitation?: { value?: number | null } | null;
      }>;
    };
  } | null = null;
  try {
    hourlyJson = await hourlyRes.json();
  } catch {
    return null;
  }
  const periods = hourlyJson?.properties?.periods ?? [];

  const maxByDay = new Map<string, number>();
  for (const p of periods) {
    const iso = p.startTime;
    if (!iso) continue;
    const day = iso.slice(0, 10);
    const v = p.probabilityOfPrecipitation?.value ?? null;
    if (v == null) continue;
    const cur = maxByDay.get(day);
    if (cur == null || v > cur) maxByDay.set(day, v);
  }

  const days: DayForecast[] = [...maxByDay.entries()]
    .map(([date, precipMax]) => ({
      date,
      precipMax,
      rainRisk: precipMax >= RAIN_THRESHOLD,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Resolve a lat/lng for the forecast + a human label.
//   1. First pending visit whose lawn_jobs profile has map_lat AND map_lng
//      (office-entered property pin on /lawn/new). Use that property's address.
//   2. Else fall back to the dispatcher's Vercel IP geolocation (replicates
//      /api/geo's logic inline — a same-origin fetch wouldn't forward the
//      x-vercel-ip-* headers, so read them directly here). Regional proxy only.
//   3. Else no coords -> forecastAvailable:false, visits still returned.
function resolveLocation(
  visitRows: VisitRow[],
  ipLat: string | null,
  ipLng: string | null
): {
  lat: number | null;
  lng: number | null;
  label: string;
  source: "property" | "ip" | "none";
} {
  for (const v of visitRows) {
    const lj = v.jobs?.lawn_jobs;
    if (lj && lj.map_lat != null && lj.map_lng != null) {
      const lat = Number(lj.map_lat);
      const lng = Number(lj.map_lng);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        return {
          lat,
          lng,
          label: v.jobs?.address || v.jobs?.name || "property",
          source: "property",
        };
      }
    }
  }
  if (ipLat && ipLng) {
    const la = parseFloat(ipLat);
    const ln = parseFloat(ipLng);
    if (!Number.isNaN(la) && !Number.isNaN(ln)) {
      return { lat: la, lng: ln, label: "your approximate location", source: "ip" };
    }
  }
  return { lat: null, lng: null, label: "location unavailable", source: "none" };
}

export async function getLawnWeatherBoard(
  supabase: Awaited<ReturnType<typeof createServerClient>>
): Promise<WeatherBoard> {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + WINDOW_DAYS);
  const horizonDate = horizon.toISOString().slice(0, 10);

  // RLS scopes this to the caller's org (no manual org filter).
  const { data: visits } = await supabase
    .from("lawn_visits")
    .select("id, due_date, jobs(name, address, lawn_jobs(map_lat, map_lng))")
    .eq("status", "pending")
    .gte("due_date", today)
    .lte("due_date", horizonDate)
    .order("due_date", { ascending: true });
  const visitRows = (visits as unknown as VisitRow[] | null) ?? [];

  // Group pending visits by due_date (de-dup job names within a day).
  const byDate = new Map<string, VisitByDate>();
  for (const v of visitRows) {
    const d = v.due_date;
    if (!byDate.has(d)) byDate.set(d, { date: d, count: 0, jobs: [] });
    const entry = byDate.get(d)!;
    entry.count += 1;
    const jn = v.jobs?.name;
    if (jn && !entry.jobs.includes(jn)) entry.jobs.push(jn);
  }
  const visitsByDate: VisitByDate[] = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : 1
  );

  const h = await headers();
  const ipLat = h.get("x-vercel-ip-latitude");
  const ipLng = h.get("x-vercel-ip-longitude");
  const { lat, lng, label, source } = resolveLocation(visitRows, ipLat, ipLng);

  if (lat == null || lng == null) {
    return {
      days: [],
      visitsByDate,
      locationLabel: label,
      locationSource: "none",
      forecastAvailable: false,
    };
  }

  const days = await getNwsForecast(lat, lng);
  if (!days) {
    return {
      days: [],
      visitsByDate,
      locationLabel: label || "property",
      locationSource: source,
      forecastAvailable: false,
    };
  }
  return {
    days,
    visitsByDate,
    locationLabel: label || "property",
    locationSource: source,
    forecastAvailable: true,
  };
}

export { RAIN_THRESHOLD, WINDOW_DAYS };