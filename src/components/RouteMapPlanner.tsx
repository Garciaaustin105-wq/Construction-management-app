"use client";

// Map-first route planner for /lawn/routes. Replaces the old zone-list
// RoutePlanner. Two panes: a Leaflet map (pins per mapped stop, numbered by
// list position) + a @dnd-kit drag-to-reorder stop list with crew assignment.
//
// The save contract is unchanged from the old planner: per-visit
// `lawn_visits.update({ crew_id, route_order })` in Promise.all, where
// route_order is a per-crew 1..n for the day (null = unassigned). The crew
// "My Route" sorts by (due_date, route_order nullsLast) — preserved.
//
// Pin setting: "Geocode" geocodes the job's address via /api/lawn/geocode
// (Nominatim, server-side) and writes lawn_jobs.map_lat/map_lng; "On map"
// enters a drop mode where the next map click sets the pin. "Geocode all
// unpinned" does the address batch (throttled ~1/s to respect Nominatim).

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import RouteList from "@/components/RouteList";
import {
  nearestNeighborRoute,
  routeMiles,
  estDriveMinutes,
  type RouteStop,
  type CrewInfo,
} from "@/lib/lawnRouting";
import { Save, Loader2, Search, MapPin, X, Info, RouteIcon } from "lucide-react";

// Leaflet touches window on import — load the map client-only.
const RouteMapView = dynamic(() => import("@/components/RouteMapView"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[320px] lg:h-[560px] rounded-lg bg-gray-100 animate-pulse" />
  ),
});

export default function RouteMapPlanner({
  date,
  stops: initial,
  crews,
}: {
  date: string;
  stops: RouteStop[];
  crews: CrewInfo[];
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  // Seed the ordered list: keep a previously-saved order if any stop has a
  // route_order; otherwise seed via nearest-neighbor so the map opens
  // already roughly sequenced. Unmapped stops sort to the end either way.
  const [ordered, setOrdered] = useState<RouteStop[]>(() => {
    const hasSaved = initial.some((s) => s.routeOrder != null);
    if (hasSaved) {
      return [...initial].sort((a, b) => {
        if (a.routeOrder == null && b.routeOrder == null) return 0;
        if (a.routeOrder == null) return 1;
        if (b.routeOrder == null) return -1;
        return a.routeOrder - b.routeOrder;
      });
    }
    return nearestNeighborRoute(initial);
  });
  const [crewAssign, setCrewAssign] = useState<Record<string, string | null>>(
    () => Object.fromEntries(initial.map((s) => [s.id, s.crewId]))
  );
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [geocoding, setGeocoding] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(true);

  const mappedCount = ordered.filter((s) => s.pos).length;
  const unmapped = ordered.filter((s) => !s.pos);
  const miles = useMemo(() => routeMiles(ordered), [ordered]);

  function setStopPos(visitId: string, pos: { lat: number; lng: number } | null) {
    setOrdered((prev) =>
      prev.map((s) => (s.id === visitId ? { ...s, pos } : s))
    );
  }

  async function geocodeOne(stop: RouteStop): Promise<boolean> {
    if (!stop.address) {
      toast.warning(`No address for ${stop.jobName} — set the pin on the map.`);
      return false;
    }
    setGeocoding((g) => ({ ...g, [stop.id]: true }));
    try {
      const r = await fetch(
        `/api/lawn/geocode?address=${encodeURIComponent(stop.address)}`
      );
      if (r.status === 404) {
        toast.error(`No geocoding match for ${stop.jobName}`);
        return false;
      }
      if (!r.ok) {
        toast.error("Geocoding failed");
        return false;
      }
      const { lat, lng } = (await r.json()) as { lat: number; lng: number };
      const ok = await savePin(stop.jobId, lat, lng);
      if (ok) setStopPos(stop.id, { lat, lng });
      return ok;
    } finally {
      setGeocoding((g) => ({ ...g, [stop.id]: false }));
    }
  }

  async function savePin(jobId: string, lat: number, lng: number): Promise<boolean> {
    const r = await fetch("/api/lawn/geocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, lat, lng }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      toast.error(error ?? "Could not save pin");
      return false;
    }
    return true;
  }

  async function geocodeAll() {
    const targets = unmapped.filter((s) => s.address);
    if (targets.length === 0) {
      toast.info("No unpinned stops with an address to geocode.");
      return;
    }
    setBulkBusy(true);
    let done = 0;
    // Sequential + throttled (~1.1s) to respect Nominatim's 1 req/s policy.
    for (const s of targets) {
      const ok = await geocodeOne(s);
      if (ok) done += 1;
      await new Promise((res) => setTimeout(res, 1100));
    }
    setBulkBusy(false);
    toast.success(`Geocoded ${done} of ${targets.length} stop${targets.length === 1 ? "" : "s"}.`);
  }

  async function onMapClick(lat: number, lng: number) {
    if (!dropTargetId) return;
    const target = ordered.find((s) => s.id === dropTargetId);
    const id = dropTargetId;
    setDropTargetId(null);
    if (!target) return;
    const ok = await savePin(target.jobId, lat, lng);
    if (ok) {
      setStopPos(id, { lat, lng });
      toast.success("Pin set");
    }
  }

  async function save() {
    setBusy(true);
    // Per-crew contiguous 1..n from the dragged order; unassigned → null.
    const targets = new Map<string, { crew_id: string | null; route_order: number | null }>();
    const counters = new Map<string, number>();
    for (const s of ordered) {
      const crew = crewAssign[s.id] ?? null;
      if (crew) {
        counters.set(crew, (counters.get(crew) ?? 0) + 1);
        targets.set(s.id, { crew_id: crew, route_order: counters.get(crew)! });
      } else {
        targets.set(s.id, { crew_id: null, route_order: null });
      }
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

  if (initial.length === 0) {
    return (
      <div className="bg-white rounded-lg p-8 text-center shadow-sm">
        <MapPin className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No lawn visits due on {date}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Help / usage banner */}
      {helpOpen && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-semibold mb-0.5">How to plan a route</p>
            <p>
              Each numbered pin is a stop. <b>Drag the list</b> to set the order,
              assign a <b>crew</b> to each stop, then <b>Save</b>. Stops without a
              pin show <b>Geocode</b> (auto from the address) or <b>On map</b>{" "}
              (click the map to drop it). Numbers on the pins match the list.
            </p>
          </div>
          <button onClick={() => setHelpOpen(false)} className="text-blue-400 hover:text-blue-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Route summary */}
      <div className="flex items-center justify-between bg-white rounded-lg p-2.5 shadow-sm text-xs">
        <span className="inline-flex items-center gap-1.5 text-gray-700 font-medium">
          <RouteIcon className="w-4 h-4 text-green-600" />
          {mappedCount}/{ordered.length} pinned
          {mappedCount >= 2 && (
            <span className="text-gray-400">
              · ~{miles.toFixed(1)} mi · ~{Math.round(estDriveMinutes(miles))} min
            </span>
          )}
        </span>
        {unmapped.length > 0 && (
          <button
            onClick={geocodeAll}
            disabled={bulkBusy}
            className="inline-flex items-center gap-1 text-green-700 font-semibold disabled:opacity-50"
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Geocode all unpinned ({unmapped.length})
          </button>
        )}
      </div>

      {unmapped.length > 0 && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          {unmapped.length} stop{unmapped.length === 1 ? "" : "s"} ha
          {unmapped.length === 1 ? "s" : "ve"} no pin — geocode it or set it on the
          map so it&rsquo;s included in the order.
        </p>
      )}

      {/* Map */}
      <RouteMapView
        stops={ordered}
        highlightId={highlightId}
        dropTargetId={dropTargetId}
        onMarkerClick={(id) => setHighlightId((h) => (h === id ? null : id))}
        onMapClick={onMapClick}
      />

      {/* Drag-to-reorder list */}
      <RouteList
        stops={ordered}
        crews={crews}
        crewAssign={crewAssign}
        highlightId={highlightId}
        geocoding={geocoding}
        dropTargetId={dropTargetId}
        onReorder={setOrdered}
        onAssign={(id, crew) => setCrewAssign((p) => ({ ...p, [id]: crew }))}
        onHighlight={setHighlightId}
        onGeocode={(id) => {
          const s = ordered.find((o) => o.id === id);
          if (s) geocodeOne(s);
        }}
        onSetOnMap={setDropTargetId}
      />

      {/* Save */}
      <div className="sticky bottom-20 lg:bottom-4 z-10">
        <button
          onClick={save}
          disabled={busy}
          className="w-full bg-green-600 text-white py-3.5 rounded-lg font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg"
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          Save crews &amp; order
        </button>
        <p className="text-[11px] text-gray-400 text-center mt-1">
          Saves each visit&rsquo;s crew + a per-crew order. Crews see it in My Route.
        </p>
      </div>
    </div>
  );
}