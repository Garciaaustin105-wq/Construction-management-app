import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import { OFFICE_LIKE } from "@/lib/roles";
import {
  getLawnWeatherBoard,
  RAIN_THRESHOLD,
  type DayForecast,
  type VisitByDate,
} from "@/lib/lawnWeather";
import LawnWeatherMover from "@/components/LawnWeatherMover";
import Link from "next/link";
import { CloudSun, CloudRain, ArrowLeft, MapPin } from "lucide-react";

function fmtDay(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return "Today";
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const tomorrow = t.toISOString().slice(0, 10);
  if (date === tomorrow) return "Tomorrow";
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default async function LawnWeatherPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const board = await getLawnWeatherBoard(supabase);
  const { days, visitsByDate, locationLabel, locationSource, forecastAvailable } =
    board;

  // Index forecast days by date for quick lookup.
  const dayMap = new Map<string, DayForecast>(days.map((d) => [d.date, d]));

  // "Next dry day" = soonest day after `from` with max precip < threshold, from
  // the NWS window. Returns null if none known (button then hidden).
  function nextDryAfter(from: string): string | null {
    for (const d of days) {
      if (d.date > from && d.precipMax < RAIN_THRESHOLD) return d.date;
    }
    return null;
  }

  // Only rain-risk days that actually have pending visits get a move card.
  const rainRiskVisitDays = visitsByDate.filter((vd) => {
    const day = dayMap.get(vd.date);
    return !!day && day.rainRisk;
  });

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title="Weather"
        subtitle={
          forecastAvailable ? `Forecast near ${locationLabel}` : "Forecast unavailable"
        }
      />

      <main className="max-w-md mx-auto p-4 space-y-6">
        <Link
          href="/lawn"
          className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Lawn
        </Link>

        {!forecastAvailable && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            NWS forecast could not be loaded
            {visitsByDate.length > 0
              ? ", but your pending visits are shown below."
              : "."}
          </div>
        )}

        {/* ── Where this forecast is for ───────────────────────────────────── */}
        {forecastAvailable && (
          <div
            className={`rounded-lg p-3 text-sm flex items-start gap-2 ${
              locationSource === "property"
                ? "bg-green-50 border border-green-200 text-green-800"
                : "bg-blue-50 border border-blue-200 text-blue-800"
            }`}
          >
            <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="leading-snug">
              {locationSource === "property" ? (
                <>
                  Forecast is for <strong>{locationLabel}</strong> — the map pin
                  set on your next scheduled lawn job. Weather follows the route.
                </>
              ) : (
                <>
                  Forecast is based on <strong>{locationLabel}</strong> (your
                  approximate location). No lawn job has a map pin set, so the
                  weather isn&rsquo;t property-specific. Add a pin in the lawn job
                  to pin the forecast to that property.
                </>
              )}
            </p>
          </div>
        )}

        {/* ── 10-Day Forecast strip ───────────────────────────────────────── */}
        {forecastAvailable && days.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
              <CloudSun className="w-3.5 h-3.5" /> 10-Day Forecast
            </h2>
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4">
              {days.map((d) => (
                <div
                  key={d.date}
                  className={`shrink-0 w-16 rounded-lg p-2 text-center ${
                    d.rainRisk ? "bg-blue-100" : "bg-white border border-gray-200"
                  }`}
                >
                  <p className="text-[10px] font-semibold text-gray-500">
                    {fmtDay(d.date)}
                  </p>
                  <p
                    className={`text-lg font-bold ${
                      d.rainRisk ? "text-blue-700" : "text-gray-900"
                    }`}
                  >
                    {d.precipMax}%
                  </p>
                  {d.rainRisk && (
                    <CloudRain className="w-4 h-4 mx-auto text-blue-600" />
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Rain-Risk Visit Days ────────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <CloudRain className="w-3.5 h-3.5" /> Rain-Risk Visit Days
          </h2>
          {rainRiskVisitDays.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={CloudSun}
                title="No rain-risk visits"
                description="No pending lawn visits fall on a high-rain day in the next 10 days."
              />
            </div>
          ) : (
            <div className="space-y-3">
              {rainRiskVisitDays.map((vd: VisitByDate) => {
                const day = dayMap.get(vd.date)!;
                const nextDry = nextDryAfter(vd.date);
                return (
                  <div
                    key={vd.date}
                    className="bg-white rounded-lg p-3 shadow-sm ring-1 ring-blue-300"
                  >
                    <div className="flex justify-between items-center">
                      <p className="font-semibold text-gray-900">
                        {fmtDay(vd.date)}
                      </p>
                      <span className="text-[10px] font-semibold px-2 py-1 rounded bg-blue-100 text-blue-700 whitespace-nowrap">
                        {day.precipMax}% rain
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {vd.count} visit{vd.count > 1 ? "s" : ""} ·{" "}
                      {vd.jobs.join(", ")}
                    </p>
                    {nextDry ? (
                      <div className="mt-2">
                        <LawnWeatherMover fromDate={vd.date} toDate={nextDry} />
                      </div>
                    ) : (
                      <p className="text-xs text-amber-700 mt-2">
                        No dry day found in the forecast window to move to.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}