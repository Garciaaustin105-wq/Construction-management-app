"use client";

// Map-first route planner for /lawn/routes. Two panes: a Google map (pins per
// mapped stop, numbered by list position, plus a real DRIVING route line via
// the Directions API) + a @dnd-kit drag-to-reorder stop list with crew
// assignment.
//
// The save contract is unchanged: per-visit `lawn_visits.update({ crew_id,
// route_order })` in Promise.all, where route_order is a per-crew 1..n for the
// day (null = unassigned). The crew "My Route" sorts by (due_date, route_order
// nullsLast) — preserved.
//
// Pin setting: "Geocode" geocodes the job's address in-browser via the Google
// Maps Geocoder (client-side, under NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) and writes
// lawn_jobs.map_lat/map_lng through POST /api/lawn/geocode; "On map" enters a
// drop mode where the next map click sets the pin. "Geocode all unpinned" does
// the address batch (concurrency-capped ~4 — the Geocoder has no Nominatim
// 1 req/s limit). Real drive minutes/miles come back from the Directions API
// via onDirectionsResult; the straight-line estimate is the fallback.

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import RouteList from "@/components/RouteList";
import { loadGoogleMaps } from "@/lib/googleMaps";
import {
  nearestNeighborRoute,
  nearestNeighborByMatrix,
  refineRouteHaversine,
  clusterZones,
  routeMiles,
  estDriveMinutes,
  buildGoogleMapsDirUrl,
  type RouteStop,
  type CrewInfo,
} from "@/lib/lawnRouting";
import { Save, Loader2, Search, MapPin, X, Info, RouteIcon, Sparkles, Users, Navigation } from "lucide-react";

// Google Maps touches window — load the map client-only.
const GoogleRouteMap = dynamic(() => import("@/components/GoogleRouteMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[320px] lg:h-[560px] rounded-lg bg-gray-100 animate-pulse" />
  ),
});

export default function RouteMapPlanner({
  date,
  stops: initial,
  crews,
  routeOptCap = null,
}: {
  date: string;
  stops: RouteStop[];
  crews: CrewInfo[];
  /** Daily route-optimization cap from the org's plan (null = unlimited for
   *  paid/trial; 5/day for free; 0 for expired/canceled). Client-enforced soft
   *  cap as a STOPGAP — bypassable from the console, deters casual overuse.
   *  The server-side Distance Matrix proxy + hard DB quota is the fast-follow
   *  (route_opt_quota.sql + /api/lawn/route-optimize). */
  routeOptCap?: number | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  // Route-opt soft cap (free tier): count Optimize clicks per calendar day in
  // localStorage. Keyed by the ACTUAL day (not the route `date` being viewed) so
  // the cap is "per day per org" regardless of which day's route is open. Reads
  // come back empty in private mode / cleared storage — render the button
  // enabled (worst case: a few extra free clicks; the server cap is the real
  // enforcement).
  const ROUTE_OPT_KEY = "terra-route-opt-day";
  const [routeOptUsed, setRouteOptUsed] = useState<number>(() => {
    if (routeOptCap == null) return 0; // no cap → don't touch storage
    try {
      const today = new Date().toISOString().slice(0, 10);
      const raw = localStorage.getItem(ROUTE_OPT_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as { day?: string; n?: number };
      if (parsed.day !== today) return 0; // rolled over → reset
      return typeof parsed.n === "number" ? parsed.n : 0;
    } catch {
      return 0;
    }
  });
  const routeOptRemaining =
    routeOptCap == null ? Infinity : Math.max(0, routeOptCap - routeOptUsed);
  const routeOptBlocked = routeOptCap != null && routeOptRemaining <= 0;

  // Increment today's route-opt counter (free-tier soft cap). No-op when there
  // is no cap. Wrapped — storage can throw in private mode / when blocked.
  function bumpRouteOpt() {
    if (routeOptCap == null) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const next = routeOptUsed + 1;
      localStorage.setItem(
        ROUTE_OPT_KEY,
        JSON.stringify({ day: today, n: next })
      );
      setRouteOptUsed(next);
    } catch {
      // best-effort — the cap is a soft deterrent, not money-critical
    }
  }

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
  const [massAssignCrewId, setMassAssignCrewId] = useState("");
  const [massAssigning, setMassAssigning] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [geocoding, setGeocoding] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(true);
  // Real drive time/distance from the Directions API (null until the route
  // resolves, or when it can't be computed — then we fall back to the
  // straight-line estimate below).
  const [realMinutes, setRealMinutes] = useState<number | null>(null);
  const [realMiles, setRealMiles] = useState<number | null>(null);

  const mappedCount = ordered.filter((s) => s.pos).length;
  const unmapped = ordered.filter((s) => !s.pos);
  const miles = useMemo(() => routeMiles(ordered), [ordered]);
  // Turn-by-turn nav link from the current ordered, pinned stops. Updates live
  // as the dispatcher drags/reorders, so the button always matches the plan on
  // screen. Capped at MAX_NAV_STOPS; `routed < total` warns when stops are cut.
  const nav = useMemo(() => buildGoogleMapsDirUrl(ordered), [ordered]);

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
      const gmaps = await loadGoogleMaps();
      const geocoder = new gmaps.maps.Geocoder();
      const res = await geocoder.geocode({ address: stop.address, region: "us" });
      const loc = res.results?.[0]?.geometry?.location;
      if (!loc) {
        toast.error(`No geocoding match for ${stop.jobName}`);
        return false;
      }
      const lat = loc.lat();
      const lng = loc.lng();
      const ok = await savePin(stop.jobId, lat, lng);
      if (ok) setStopPos(stop.id, { lat, lng });
      return ok;
    } catch {
      toast.error("Geocoding failed");
      return false;
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
    // The Google Geocoder has no Nominatim 1 req/s limit; cap concurrency to
    // ~4 in flight so a big batch is quick without hammering the service.
    const CHUNK = 4;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const slice = targets.slice(i, i + CHUNK);
      const results = await Promise.all(slice.map((s) => geocodeOne(s)));
      done += results.filter(Boolean).length;
    }
    setBulkBusy(false);
    toast.success(`Geocoded ${done} of ${targets.length} stop${targets.length === 1 ? "" : "s"}.`);
  }

  // Reorder the MAPPED stops by real DRIVE time (Distance Matrix API), keeping
  // any previously-saved crew assignments (keyed by stop id). Unmapped stops
  // can't be sequenced by distance, so they stay appended in their current
  // order. Non-destructive: only mutates local `ordered` state — the dispatcher
  // still has to hit Save to persist. Distance Matrix caps at 25
  // origins/destinations per request — above that, fall back to a haversine
  // nearest-neighbor walk + 2-opt refinement (no Google API call, so no cap).
  // It's an estimate rather than live drive time, but still meaningfully
  // better than the unoptimized greedy order for a big day.
  // Haversine estimate fallback: reorder mapped stops by straight-line
  // nearest-neighbor + 2-opt. Used when there are too many stops for a single
  // Google Distance Matrix request (>25) OR when the server proxy is
  // unavailable (503 — GOOGLE_MAPS_SERVER_KEY not configured). No Google call,
  // so it never consumes the route-opt quota. Non-destructive (local state only).
  function applyHaversineOptimize(mappedStops: RouteStop[]) {
    const optimized = refineRouteHaversine(nearestNeighborRoute(mappedStops));
    const unmapped = ordered.filter((s) => !s.pos);
    setOrdered([...optimized, ...unmapped]);
  }

  async function optimizeOrder() {
    const mapped = ordered.filter((s) => s.pos);
    if (mapped.length < 2) {
      toast.info("Pin at least 2 stops to optimize the order.");
      return;
    }
    // Free-tier route-opt soft cap (stopgap): block once the daily allotment is
    // used up. Bypassable from the console — the server proxy + DB quota is the
    // real enforcement (fast-follow).
    if (routeOptBlocked) {
      toast.warning(
        `Daily route-optimization limit reached (${routeOptCap}/day on the Free plan). Upgrade for unlimited optimizations.`
      );
      return;
    }
    if (mapped.length > 25) {
      setOptimizing(true);
      applyHaversineOptimize(mapped);
      setOptimizing(false);
      toast.success(
        "Reordered by estimated distance (too many stops for live drive-time) — review and Save."
      );
      bumpRouteOpt();
      return;
    }
    setOptimizing(true);
    try {
      // Server-side Google Distance Matrix (quota-capped per org per day via
      // route_opt_quota — free 5/day; the client soft cap above is just a
      // pre-check to avoid a wasted round trip). Returns an N×N duration matrix
      // in seconds; null pairs are unreachable.
      const positions = mapped.map((s) => ({ lat: s.pos!.lat, lng: s.pos!.lng }));
      const r = await fetch("/api/lawn/route-optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origins: positions, destinations: positions }),
      });
      if (r.status === 429) {
        // Server quota hit (raced past the client pre-check, or caps changed
        // server-side). Sync the local counter so the button disables + nudge.
        setRouteOptUsed(routeOptCap ?? 0);
        toast.warning(
          "Daily route-optimization limit reached on the Free plan. Upgrade for unlimited optimizations."
        );
        return;
      }
      if (r.status === 503) {
        // Server key not configured — degrade gracefully to a haversine
        // estimate (no Google spend, no quota consumed). Not an error.
        applyHaversineOptimize(mapped);
        toast.success("Reordered by estimated distance — review and Save.");
        return;
      }
      if (!r.ok) {
        toast.error("Could not optimize the order — please try again.");
        return;
      }
      const { durations } = (await r.json()) as { durations: (number | null)[][] };
      // N×N duration matrix (seconds). null pairs (unreachable) → Infinity so
      // nearestNeighborByMatrix falls back to haversine for that leg instead of
      // stalling (matches the old in-browser DistanceMatrixService behavior).
      const matrix: number[][] = durations.map((row) =>
        row.map((d) => (typeof d === "number" ? d : Infinity))
      );
      const optimized = nearestNeighborByMatrix(mapped, matrix);
      const unmapped = ordered.filter((s) => !s.pos);
      setOrdered([...optimized, ...unmapped]);
      toast.success("Reordered by real drive time — review and Save.");
      bumpRouteOpt();
    } catch {
      toast.error("Could not optimize the order — please try again.");
    } finally {
      setOptimizing(false);
    }
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

  // Accepts an optional assignment-map override so callers that just computed
  // a new crewAssign (e.g. the mass-assign buttons below) can save it
  // immediately without waiting on React's async state update — using the
  // `crewAssign` state var right after setCrewAssign() would read the STALE
  // value here since state updates aren't synchronous.
  async function save(assignOverride?: Record<string, string | null>) {
    setBusy(true);
    const assign = assignOverride ?? crewAssign;
    // Per-crew contiguous 1..n from the dragged order; unassigned → null.
    const targets = new Map<string, { crew_id: string | null; route_order: number | null }>();
    const counters = new Map<string, number>();
    for (const s of ordered) {
      const crew = assign[s.id] ?? null;
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

  // "Assign to all" / "Assign to unassigned" — sets massAssignCrewId on every
  // (or every currently-unassigned) stop and saves immediately (no separate
  // renumber step: save() already computes each crew's contiguous 1..n from
  // the current `ordered` list position).
  async function massAssign(target: "all" | "unassigned") {
    if (!massAssignCrewId) {
      toast.warning("Pick a crew first");
      return;
    }
    const next: Record<string, string | null> = { ...crewAssign };
    for (const s of ordered) {
      if (target === "all" || !next[s.id]) next[s.id] = massAssignCrewId;
    }
    setCrewAssign(next);
    setMassAssigning(true);
    await save(next);
    setMassAssigning(false);
  }

  // "Auto-assign crews" — geographic k-means zoning (clusterZones) instead of
  // one crew for everyone. k = the number of crews already in use today (so
  // re-running after a manual tweak keeps the same crew count), falling back
  // to the full crew roster size when nothing is assigned yet; clamped to
  // [1, mappedCount] so k never exceeds the stops available to zone.
  // Zones are ranked biggest-stop-count-first (routeMiles as a tiebreak) and
  // paired with crews in that order — a simple, deterministic, stable
  // assignment rather than a full optimal matching. Each zone's stops are
  // locally sequenced via nearestNeighborRoute (haversine + 2-opt) so the
  // reassembled `ordered` list is contiguous per crew — save() then writes a
  // correct per-crew 1..n route_order straight from list position. Local
  // state only — does not call save(); the dispatcher can still drag-tweak
  // before hitting the main Save button.
  function autoAssignCrews() {
    if (mappedCount < 2) {
      toast.info("Pin at least 2 stops first.");
      return;
    }
    if (crews.length === 0) {
      toast.warning("No crews available to assign.");
      return;
    }
    const assignedCrewIds = new Set(
      Object.values(crewAssign).filter((c): c is string => !!c)
    );
    const kRaw = assignedCrewIds.size > 0 ? assignedCrewIds.size : crews.length;
    const k = Math.max(1, Math.min(kRaw, mappedCount));

    const zones = clusterZones(ordered, k);
    const mappedZones = zones
      .filter((z) => z.label !== "Unmapped")
      .map((z) => ({ ...z, stops: nearestNeighborRoute(z.stops) }));
    const unmappedZone = zones.find((z) => z.label === "Unmapped") ?? null;

    const rankedZones = [...mappedZones].sort((a, b) => {
      if (b.stops.length !== a.stops.length)
        return b.stops.length - a.stops.length;
      return routeMiles(b.stops) - routeMiles(a.stops);
    });
    const crewIds = crews.slice(0, k).map((c) => c.id);

    const nextAssign: Record<string, string | null> = { ...crewAssign };
    const reassembled: RouteStop[] = [];
    rankedZones.forEach((zone, i) => {
      const crewId = crewIds[i] ?? null;
      for (const s of zone.stops) {
        nextAssign[s.id] = crewId;
        reassembled.push(s);
      }
    });
    if (unmappedZone) {
      for (const s of unmappedZone.stops) reassembled.push(s);
    }
    // Safety net: zones partition `ordered` exactly, but if anything were
    // somehow missed, append it as-is rather than silently dropping a stop.
    const seen = new Set(reassembled.map((s) => s.id));
    for (const s of ordered) if (!seen.has(s.id)) reassembled.push(s);

    setCrewAssign(nextAssign);
    setOrdered(reassembled);
    toast.success(
      `Zoned ${mappedZones.length} area${mappedZones.length === 1 ? "" : "s"} across ${Math.min(crewIds.length, mappedZones.length)} crew${crewIds.length === 1 ? "" : "s"} — review and Save.`
    );
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
              · ~{(realMiles ?? miles).toFixed(1)} mi · ~
              {Math.round(realMinutes ?? estDriveMinutes(miles))} min
              {realMinutes == null ? " (est.)" : ""}
            </span>
          )}
        </span>
        <div className="flex items-center gap-3">
          {nav.url && (
            <a
              href={nav.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-green-700 font-semibold"
              title={
                nav.routed < nav.total
                  ? `Google Maps caps a trip — opens the first ${nav.routed} of ${nav.total} pinned stops`
                  : "Open this route in Google Maps (turn-by-turn, CarPlay / Android Auto)"
              }
            >
              <Navigation className="w-3.5 h-3.5" />
              Open in Maps
              {nav.routed < nav.total && (
                <span className="text-gray-400 font-normal">
                  ({nav.routed}/{nav.total})
                </span>
              )}
            </a>
          )}
          {mappedCount >= 2 && (
            <button
              onClick={optimizeOrder}
              disabled={optimizing || routeOptBlocked}
              className="inline-flex items-center gap-1 text-green-700 font-semibold disabled:opacity-50"
              title={
                routeOptCap != null
                  ? routeOptBlocked
                    ? `Free plan limit reached (${routeOptCap}/day) — upgrade for unlimited`
                    : `${routeOptRemaining} route optimization${routeOptRemaining === 1 ? "" : "s"} left today (Free plan)`
                  : undefined
              }
            >
              {optimizing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              Optimize order
              {routeOptCap != null && !routeOptBlocked && (
                <span className="text-gray-400 font-normal">
                  ({routeOptRemaining} left)
                </span>
              )}
            </button>
          )}
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
      </div>

      {unmapped.length > 0 && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          {unmapped.length} stop{unmapped.length === 1 ? "" : "s"} ha
          {unmapped.length === 1 ? "s" : "ve"} no pin — geocode it or set it on the
          map so it&rsquo;s included in the order.
        </p>
      )}

      {routeOptBlocked && (
        <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 flex items-center justify-between gap-2">
          <span>
            Daily route-optimization limit reached ({routeOptCap}/day on the Free
            plan). You can still drag to reorder manually.
          </span>
          <button
            onClick={() => router.push("/admin/billing")}
            className="text-green-700 font-semibold underline shrink-0"
          >
            Upgrade
          </button>
        </div>
      )}

      {/* Map */}
      <GoogleRouteMap
        stops={ordered}
        highlightId={highlightId}
        dropTargetId={dropTargetId}
        onMarkerClick={(id) => setHighlightId((h) => (h === id ? null : id))}
        onMapClick={onMapClick}
        showDirections
        onDirectionsResult={(min, mi) => {
          setRealMinutes(min);
          setRealMiles(mi);
        }}
      />

      {/* Mass crew-assign — pick a crew, then blast it onto every stop or
          just the unassigned ones. Saves immediately (same per-crew
          contiguous renumber as the main Save button, from current list
          order), so this is a shortcut for "everyone today", not a staged
          edit. */}
      {crews.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-white rounded-lg p-2.5 shadow-sm text-xs">
          <select
            value={massAssignCrewId}
            onChange={(e) => setMassAssignCrewId(e.target.value)}
            disabled={massAssigning}
            className="flex-1 min-w-[140px] px-2 py-1.5 border border-gray-300 rounded-lg text-xs disabled:opacity-50"
          >
            <option value="">— Pick a crew —</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => massAssign("all")}
            disabled={massAssigning || !massAssignCrewId}
            className="px-2.5 py-1.5 rounded-lg font-semibold text-green-700 bg-green-50 border border-green-200 disabled:opacity-50 flex items-center gap-1"
          >
            {massAssigning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Assign to all
          </button>
          <button
            type="button"
            onClick={() => massAssign("unassigned")}
            disabled={massAssigning || !massAssignCrewId}
            className="px-2.5 py-1.5 rounded-lg font-semibold text-gray-700 bg-white border border-gray-300 disabled:opacity-50"
          >
            Assign to unassigned
          </button>
          {mappedCount >= 2 && (
            <button
              type="button"
              onClick={autoAssignCrews}
              disabled={massAssigning}
              className="px-2.5 py-1.5 rounded-lg font-semibold text-green-700 bg-white border border-green-300 disabled:opacity-50 flex items-center gap-1"
              title="Split today's pinned stops into geographic zones, one per crew"
            >
              <Users className="w-3.5 h-3.5" />
              Auto-assign crews
            </button>
          )}
        </div>
      )}

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
          onClick={() => save()}
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