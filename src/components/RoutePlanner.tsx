"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  clusterZones,
  nearestNeighborRoute,
  routeMiles,
  estDriveMinutes,
  type RouteStop,
  type CrewInfo,
} from "@/lib/lawnRouting";
import { Loader2, MapPin, Route as RouteIcon, Layers, Save } from "lucide-react";

// Daily lawn route planner. The server page fetches the day's lawn_visits (with
// map pins from lawn_jobs) + the org's crew list and passes them in; this
// component clusters visits into geographic zones (deterministic k-means),
// orders each zone by nearest-neighbor, and lets the dispatcher (office) assign
// crews + save the optimized order. Saving persists per-visit crew_id + a
// per-crew route_order so each crew's My Route reflects the dispatcher's
// sequence. All geometry is straight-line haversine (no paid map API); drive
// time is a rough estimate.

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

function fmtMiles(n: number): string {
  return `${n.toFixed(1)} mi`;
}
function fmtMin(n: number): string {
  if (n < 1) return "<1 min";
  return `~${Math.round(n)} min`;
}

type PlanEntry = {
  zoneId: number;
  stop: RouteStop;
  crew: string | null;
  order: number | null;
};

function StopRow({
  entry,
  step,
  crews,
  onAssign,
}: {
  entry: PlanEntry;
  step: number;
  crews: CrewInfo[];
  onAssign: (visitId: string, crewId: string | null) => void;
}) {
  const { stop, crew, order } = entry;
  return (
    <li className="bg-white rounded-lg p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 w-7 h-7 rounded-full bg-green-600 text-white text-xs font-bold flex items-center justify-center">
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/lawn/visits/${stop.id}`}
            className="font-semibold text-gray-900 truncate block active:opacity-70"
          >
            {stop.jobName}
          </Link>
          <p className="text-xs text-gray-500 truncate">
            {stop.customerName ? `${stop.customerName} · ` : ""}
            {stop.address ?? "—"}
          </p>
          <p className="text-xs text-gray-400 truncate">
            {stop.serviceType ?? "Lawn service"}
            {order != null ? ` · route #${order}` : ""}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            {!stop.pos && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-700">
                <MapPin className="w-3 h-3" /> no pin
              </span>
            )}
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                STATUS_CHIP[stop.status] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {stop.status}
            </span>
          </div>
        </div>
        <select
          value={crew ?? ""}
          onChange={(e) => onAssign(stop.id, e.target.value || null)}
          className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white max-w-[7.5rem]"
          aria-label="Assign crew"
        >
          <option value="">Unassigned</option>
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {/* Stale crew: still assigned in the DB but no longer a crew/superintendent
              (e.g. demoted). Render it so the controlled value matches an option
              and the dispatcher sees the visit IS assigned (review LOW-1). */}
          {crew != null && !crews.some((c) => c.id === crew) && (
            <option value={crew}>Crew (removed)</option>
          )}
        </select>
      </div>
    </li>
  );
}

function ZoneCard({
  zone,
  entries,
  crews,
  onAssign,
  onAssignZone,
}: {
  zone: { id: number; label: string; ordered: RouteStop[]; centroid: { lat: number; lng: number } };
  entries: PlanEntry[];
  crews: CrewInfo[];
  onAssign: (visitId: string, crewId: string | null) => void;
  onAssignZone: (zoneId: number, crewId: string | null) => void;
}) {
  const miles = routeMiles(zone.ordered);
  const mins = estDriveMinutes(miles);
  // Currently-assigned crews within this zone (for the header summary).
  const zoneCrews = new Set(
    entries.map((e) => e.crew).filter((c): c is string => c != null)
  );
  const zoneCrewLabel =
    zoneCrews.size === 0
      ? "Unassigned"
      : zoneCrews.size === 1
        ? crews.find((c) => zoneCrews.has(c.id))?.name ?? "Crew"
        : `${zoneCrews.size} crews`;
  const zoneCrewValue = zoneCrews.size === 1 ? [...zoneCrews][0] : "";
  // Stale single-crew id (demoted since assignment) — render so the controlled
  // value matches an option (review LOW-1).
  const zoneCrewStale =
    zoneCrewValue !== "" && !crews.some((c) => c.id === zoneCrewValue);

  return (
    <section className="bg-gray-100 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-green-600" />
          {zone.label}
          <span className="text-gray-400 font-normal">· {entries.length}</span>
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500 whitespace-nowrap">
            {fmtMiles(miles)} · {fmtMin(mins)}
          </span>
          <select
            value={zoneCrewValue}
            onChange={(e) => onAssignZone(zone.id, e.target.value || null)}
            className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white max-w-[8rem]"
            aria-label={`Assign crew to ${zone.label}`}
          >
            <option value="">{zoneCrewLabel}</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {zoneCrewStale && (
              <option value={zoneCrewValue}>Crew (removed)</option>
            )}
          </select>
        </div>
      </div>
      <ol className="space-y-2">
        {entries.map((e, idx) => (
          <StopRow
            key={e.stop.id}
            entry={e}
            step={idx + 1}
            crews={crews}
            onAssign={onAssign}
          />
        ))}
      </ol>
    </section>
  );
}

export default function RoutePlanner({
  date,
  stops,
  crews,
}: {
  date: string;
  stops: RouteStop[];
  crews: CrewInfo[];
}) {
  const router = useRouter();
  const toast = useToast();
  // Per-visit crew assignment (local state; reset on date change via key={date}
  // on the component instance from the server page).
  const [crewAssign, setCrewAssign] = useState<Record<string, string | null>>(
    () => Object.fromEntries(stops.map((s) => [s.id, s.crewId]))
  );
  const [k, setK] = useState(() => {
    const mapped = stops.filter((s) => s.pos).length;
    return Math.max(1, Math.min(mapped || 3, 6));
  });
  const [busy, setBusy] = useState(false);

  const zones = useMemo(
    () =>
      clusterZones(stops, k).map((z) => ({
        id: z.id,
        label: z.label,
        centroid: z.centroid,
        ordered: nearestNeighborRoute(z.stops),
      })),
    [stops, k]
  );

  // The plan: walk every zone in display order, ordering each by NN, and assign
  // a per-crew route_order counter so each crew gets a contiguous 1..n for the
  // day (what My Route sorts by). Unassigned visits get order = null.
  const plan = useMemo<PlanEntry[]>(() => {
    const counters = new Map<string, number>();
    const entries: PlanEntry[] = [];
    for (const z of zones) {
      for (const stop of z.ordered) {
        // crewAssign is initialized for EVERY stop (see useState initializer),
        // so this is always string | null — never undefined. Do NOT fall back
        // to stop.crewId: `??` treats an explicit unassign (null) as nullish
        // and would silently revert it to the original crew (review MEDIUM-1).
        const crew = crewAssign[stop.id] ?? null;
        let order: number | null = null;
        if (crew) {
          order = (counters.get(crew) ?? 0) + 1;
          counters.set(crew, order);
        }
        entries.push({ zoneId: z.id, stop, crew, order });
      }
    }
    return entries;
  }, [zones, crewAssign]);

  function assignVisit(visitId: string, crewId: string | null) {
    setCrewAssign((prev) => ({ ...prev, [visitId]: crewId }));
  }
  function assignZone(zoneId: number, crewId: string | null) {
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;
    setCrewAssign((prev) => {
      const next = { ...prev };
      for (const stop of zone.ordered) next[stop.id] = crewId;
      return next;
    });
  }

  async function save() {
    setBusy(true);
    const supabase = createClient();
    const targets = new Map<string, { crew_id: string | null; route_order: number | null }>();
    for (const e of plan) {
      targets.set(e.stop.id, { crew_id: e.crew, route_order: e.order });
    }
    const results = await Promise.all(
      [...targets].map(([id, t]) =>
        supabase
          .from("lawn_visits")
          .update({ crew_id: t.crew_id, route_order: t.route_order })
          .eq("id", id)
      )
    );
    setBusy(false);
    if (results.some((r) => r.error)) {
      toast.error("Some saves failed — please retry");
      return;
    }
    toast.success(`Saved ${targets.size} visit${targets.size === 1 ? "" : "s"}`);
    router.refresh();
  }

  const unmappedCount = stops.filter((s) => !s.pos).length;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg p-3 shadow-sm flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RouteIcon className="w-4 h-4 text-green-600" />
          <div>
            <p className="text-sm font-bold text-gray-900">{date}</p>
            <p className="text-xs text-gray-500">
              {stops.length} visit{stops.length === 1 ? "" : "s"} · {crews.length} crew
              {crews.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Zones</label>
          <button
            type="button"
            onClick={() => setK((n) => Math.max(1, n - 1))}
            className="w-7 h-7 rounded border border-gray-300 bg-white text-gray-700 font-bold"
            aria-label="Fewer zones"
          >
            −
          </button>
          <span className="w-5 text-center text-sm font-semibold">{k}</span>
          <button
            type="button"
            onClick={() => setK((n) => Math.min(6, n + 1))}
            className="w-7 h-7 rounded border border-gray-300 bg-white text-gray-700 font-bold"
            aria-label="More zones"
          >
            +
          </button>
        </div>
      </div>

      {stops.length === 0 ? (
        <div className="bg-white rounded-lg p-6 text-center text-gray-500 text-sm">
          No lawn visits due on {date}. Pick another day or generate visits from
          a schedule.
        </div>
      ) : (
        <>
          {unmappedCount > 0 && (
            <p className="text-xs text-amber-700 flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" />
              {unmappedCount} visit{unmappedCount === 1 ? "" : "s"} have no map
              pin — set a pin on the property (job edit) to include them in the
              route order.
            </p>
          )}

          {zones.map((z) => (
            <ZoneCard
              key={z.id}
              zone={z}
              entries={plan.filter((e) => e.zoneId === z.id)}
              crews={crews}
              onAssign={assignVisit}
              onAssignZone={assignZone}
            />
          ))}

          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2 sticky bottom-20"
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Save className="w-5 h-5" />
            )}
            Save crews &amp; order
          </button>
          <p className="text-[11px] text-gray-400 text-center">
            Saves each visit&rsquo;s assigned crew + a per-crew route order. Crews
            see their sequence in My Route.
          </p>
        </>
      )}
    </div>
  );
}