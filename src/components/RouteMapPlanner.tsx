"use client";

// Map-first route planner for /lawn/routes. Two panes: a Google map (pins per
// mapped stop, numbered by list position, plus a real DRIVING route line via
// the Directions API) + a @dnd-kit drag-to-reorder stop list with crew
// assignment.
//
// The save contract is unchanged in SHAPE: per-visit `lawn_visits.update({
// crew_id, route_order })` in Promise.all, where route_order is a per-crew 1..n
// for the day (null = unassigned). But persistence is now AUTO — a debounced
// effect writes crew_id + route_order ~800ms after any change to `ordered` or
// `crewAssign` (drag, crew select, Optimize, mass-assign, auto-assign); there
// is no Save button. The initial seed (saved order or nearest-neighbor) is NOT
// auto-saved (mount-skip) so opening the page never persists an order the
// office didn't ask for. The crew "My Route" sorts by (due_date, route_order
// nullsLast) — preserved.
//
// Pin setting: "Geocode" geocodes the job's address in-browser via the Google
// Maps Geocoder (client-side, under NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) and writes
// lawn_jobs.map_lat/map_lng through POST /api/lawn/geocode; "On map" enters a
// drop mode where the next map click sets the pin. "Geocode all unpinned" does
// the address batch (concurrency-capped ~4 — the Geocoder has no Nominatim
// 1 req/s limit). Real drive minutes/miles come back from the Directions API
// via onDirectionsResult; the straight-line estimate is the fallback.

import { useEffect, useMemo, useRef, useState } from "react";
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
  refineRouteMatrix,
  clusterZones,
  routeMiles,
  estDriveMinutes,
  haversineMiles,
  buildGoogleMapsDirUrl,
  type RouteStop,
  type CrewInfo,
} from "@/lib/lawnRouting";
import { Loader2, Search, MapPin, X, Info, RouteIcon, Sparkles, Users, Navigation } from "lucide-react";

// Google Maps touches window — load the map client-only.
const GoogleRouteMap = dynamic(() => import("@/components/GoogleRouteMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[320px] lg:h-[560px] rounded-lg bg-gray-100 animate-pulse" />
  ),
});

// Assumed crew start time for the per-stop arrival-ETA walk (8:00 AM, local).
// The ETA is dispatcher planning advice, not a customer-facing promise — the
// office can tweak this once a per-org "day start" setting exists. Seconds
// since midnight.
const ROUTE_START_SEC = 8 * 3600;

/** Format seconds-since-midnight as a 12-hour clock "h:mm AM/PM". */
function formatClock(sec: number): string {
  const h24 = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(true);
  // Real drive time/distance from the Directions API (null until the route
  // resolves, or when it can't be computed — then we fall back to the
  // straight-line estimate below).
  const [realMinutes, setRealMinutes] = useState<number | null>(null);
  const [realMiles, setRealMiles] = useState<number | null>(null);
  // Real per-leg DRIVE matrix (seconds) from /api/lawn/route-optimize, keyed by
  // stop id so it stays valid as the dispatcher drags/reorders after Optimize.
  // `travel[srcId][dstId]` = drive seconds (off-diagonal; only finite cells
  // stored — null/unreachable legs are omitted so the ETA walk falls back to a
  // haversine estimate for that leg). `service[id]` = on-site seconds (the
  // matrix diagonal the server wrote from the serviceDurations we sent). null
  // until the first successful Optimize (or a 503 haversine fallback, which
  // skips the matrix entirely) — before that, ETAs use the haversine estimate.
  const [routeMatrix, setRouteMatrix] = useState<{
    travel: Map<string, Map<string, number>>;
    service: Map<string, number>;
  } | null>(null);

  // Auto-save: debounced persist of crew_id + per-crew route_order whenever the
  // dispatcher changes the order or a crew assignment (drag, crew <select>,
  // Optimize, mass-assign, auto-assign). Mount is skipped so the initial seed
  // (a previously-saved order, or the nearest-neighbor guess) is never written
  // back as if the office had asked for it. ~800ms coalesces a rapid drag
  // sequence into one write batch. No router.refresh() — local state is the
  // source of truth and the DB is now in sync; a refresh would disrupt the
  // drag. (RLS session client — the office/PM update policy admits crew_id +
  // route_order; guard_lawn_visit_crew_update blocks crew_id changes for
  // non-office, but this page is OFFICE_LIKE-gated.)
  const didMountRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(() => {
      void (async () => {
        const targets = new Map<
          string,
          { crew_id: string | null; route_order: number | null }
        >();
        const counters = new Map<string, number>();
        for (const s of ordered) {
          const crew = crewAssign[s.id] ?? null;
          if (crew) {
            counters.set(crew, (counters.get(crew) ?? 0) + 1);
            targets.set(s.id, {
              crew_id: crew,
              route_order: counters.get(crew)!,
            });
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
        if (results.some((r) => r.error)) {
          setSaveState("error");
          return;
        }
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2000);
      })();
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, crewAssign]);

  const mappedCount = ordered.filter((s) => s.pos).length;
  const unmapped = ordered.filter((s) => !s.pos);
  const miles = useMemo(() => routeMiles(ordered), [ordered]);
  // Turn-by-turn nav link from the current ordered, pinned stops. Updates live
  // as the dispatcher drags/reorders, so the button always matches the plan on
  // screen. Capped at MAX_NAV_STOPS; `routed < total` warns when stops are cut.
  const nav = useMemo(() => buildGoogleMapsDirUrl(ordered), [ordered]);

  // Per-stop arrival ETAs + day-end. Walk `ordered` from ROUTE_START_SEC:
  // arrival[i] = prevDeparture + travel(prev→cur); departure = arrival +
  // service(cur). Travel legs use the real matrix when available (post-Optimize,
  // keyed by id so a drag re-walks with the same real drive times), else a
  // haversine estimate. Service time = the matrix diagonal (sent as
  // serviceDurations) when available, else the stop's resolved serviceDurationMin.
  // An unmapped stop (no pos) breaks the chain — it and everything after it get
  // null (we can't time a leg to/from an unknown location). Returns etaByStop as
  // a plain record for the list + dayEndSec (last departure) for the summary.
  const { etaByStop, dayEndSec } = useMemo(() => {
    const eta: Record<string, number | null> = {};
    let prevDeparture: number | null = null;
    let prevStop: RouteStop | null = null;
    let dayEnd: number | null = null;
    for (const s of ordered) {
      let arrival: number | null;
      if (prevStop === null) {
        // First stop — crew starts there at ROUTE_START_SEC.
        arrival = ROUTE_START_SEC;
      } else if (
        prevDeparture !== null &&
        prevStop.pos !== null &&
        s.pos !== null
      ) {
        const real = routeMatrix?.travel.get(prevStop.id)?.get(s.id);
        const travel =
          typeof real === "number"
            ? real
            : estDriveMinutes(haversineMiles(prevStop.pos, s.pos)) * 60;
        arrival = prevDeparture + travel;
      } else {
        // Previous leg uncomputable (unmapped gap, or chain already broken).
        arrival = null;
      }
      eta[s.id] = arrival;
      if (arrival !== null) {
        const svc = routeMatrix?.service.get(s.id) ?? null;
        const serviceSec =
          svc !== null
            ? svc
            : s.serviceDurationMin != null
              ? s.serviceDurationMin * 60
              : 0;
        // Annotated `number` to break the inference cycle: departure feeds
        // prevDeparture, which feeds the next iteration's arrival, which feeds
        // departure — without an explicit type TS sees departure's type as
        // depending on itself (TS7022).
        const departure: number = arrival + serviceSec;
        prevDeparture = departure;
        dayEnd = departure;
      } else {
        prevDeparture = null;
      }
      prevStop = s;
    }
    return { etaByStop: eta, dayEndSec: dayEnd };
  }, [ordered, routeMatrix]);

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
  // order. Non-destructive: only mutates local `ordered` state — the auto-save
  // effect persists it (debounced). Distance Matrix caps at 25
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
        "Reordered by estimated distance (too many stops for live drive-time)."
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
      // On-site service seconds per stop (null = no duration on file → server
      // writes 0 on that diagonal). The server puts these on the matrix DIAGONAL
      // (durations[i][i]); off-diagonal stays pure travel time. Ordering ignores
      // the diagonal (service time is a constant added to every tour → can't
      // improve the optimum), so this does NOT change the order — its payoff is
      // the client building a per-stop arrival-ETA walk from the returned matrix
      // (real drive legs + service times) instead of the straight-line estimate.
      const serviceDurations = mapped.map((s) =>
        s.serviceDurationMin != null ? s.serviceDurationMin * 60 : null
      );
      const r = await fetch("/api/lawn/route-optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origins: positions,
          destinations: positions,
          serviceDurations,
        }),
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
        toast.success("Reordered by estimated distance.");
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
      // Build the id-keyed route matrix for the ETA walk. Off-diagonal finite
      // cells → travel[src][dst]; the diagonal → service[id] (the serviceDurations
      // we sent, written by the server). Null/unreachable off-diagonal cells are
      // omitted so the walk falls back to a haversine estimate for that leg.
      // Keyed by id (not index) so a drag after Optimize re-walks with the same
      // real drive times for the new sequence.
      const travel = new Map<string, Map<string, number>>();
      const service = new Map<string, number>();
      for (let i = 0; i < mapped.length; i++) {
        const row = durations[i] ?? [];
        // Assign to a local so `typeof cell === "number"` narrows it — TS won't
        // narrow an indexed access like `row[i]` directly.
        const diag = row[i];
        service.set(mapped[i].id, typeof diag === "number" ? diag : 0);
        const inner = new Map<string, number>();
        for (let j = 0; j < mapped.length; j++) {
          if (i === j) continue;
          const d = row[j];
          if (typeof d === "number" && Number.isFinite(d)) inner.set(mapped[j].id, d);
        }
        travel.set(mapped[i].id, inner);
      }
      setRouteMatrix({ travel, service });
      // 2-opt the drive-time tour, exactly as the free haversine path already
      // does. Without this the PAID path ran bare nearest-neighbour while the
      // free one got NN + 2-opt — so paying for real drive times could hand you
      // a worse tour than not paying, because refinement usually beats matrix
      // accuracy on dense suburban stops. refineRouteMatrix was written for
      // this and was never called from anywhere.
      const optimized = refineRouteMatrix(
        nearestNeighborByMatrix(mapped, matrix),
        mapped,
        matrix
      );
      const unmapped = ordered.filter((s) => !s.pos);
      setOrdered([...optimized, ...unmapped]);
      toast.success("Reordered by real drive time.");
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

  // "Assign to all" / "Assign to unassigned" — sets massAssignCrewId on every
  // (or every currently-unassigned) stop. The auto-save effect persists it
  // (debounced); no separate renumber step — the effect computes each crew's
  // contiguous 1..n from the current `ordered` list position.
  function massAssign(target: "all" | "unassigned") {
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
    // Brief spinner so the click registers; the auto-save effect persists.
    setTimeout(() => setMassAssigning(false), 500);
    toast.success(
      `Assigned ${target === "all" ? "all" : "unassigned"} stops to ${
        crews.find((c) => c.id === massAssignCrewId)?.name ?? "crew"
      }.`
    );
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
  // reassembled `ordered` list is contiguous per crew — the auto-save effect
  // then writes a correct per-crew 1..n route_order straight from list
  // position. Local state only; the dispatcher can still drag-tweak before
  // the debounced save fires.
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
      `Zoned ${mappedZones.length} area${mappedZones.length === 1 ? "" : "s"} across ${Math.min(crewIds.length, mappedZones.length)} crew${crewIds.length === 1 ? "" : "s"}.`
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
              Each numbered pin is a stop. <b>Drag the list</b> to set the order
              and assign a <b>crew</b> to each stop — changes save automatically.
              Stops without a pin show <b>Geocode</b> (auto from the address) or{" "}
              <b>On map</b> (click the map to drop it). Numbers on the pins match
              the list.
            </p>
          </div>
          <button onClick={() => setHelpOpen(false)} className="text-blue-400 hover:text-blue-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Desktop: map + toolbar get the wide column, the drag-to-reorder
          list sits beside it like a real dispatch tool. Mobile stays a
          single stacked column (unchanged). */}
      <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-4 lg:items-start">
      <div className="space-y-3">

      {/* Route summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white rounded-lg p-2.5 shadow-sm text-xs">
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
          {dayEndSec !== null && (
            <span className="text-gray-400">
              · ends ≈ {formatClock(dayEndSec)}
              {routeMatrix == null ? " (est.)" : ""}
            </span>
          )}
          {saveState === "saving" && (
            <span className="text-amber-600">· Saving…</span>
          )}
          {saveState === "saved" && <span className="text-green-600">· Saved ✓</span>}
          {saveState === "error" && (
            <span className="text-red-600">· Save failed — will retry</span>
          )}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {nav.url && (
            <a
              href={nav.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-semibold text-green-700 bg-white border border-green-300"
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
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-semibold text-white bg-green-600 border border-green-600 disabled:opacity-50"
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
                <span className="text-white/80 font-normal">
                  ({routeOptRemaining} left)
                </span>
              )}
            </button>
          )}
          {unmapped.length > 0 && (
            <button
              onClick={geocodeAll}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-semibold text-green-700 bg-green-50 border border-green-200 disabled:opacity-50"
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
          just the unassigned ones. The auto-save effect persists it (same
          per-crew contiguous renumber, from current list order), so this is
          a shortcut for "everyone today", not a staged edit. */}
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

      </div>

      {/* Drag-to-reorder list */}
      <div className="mt-3 lg:mt-0">
      <RouteList
        stops={ordered}
        crews={crews}
        crewAssign={crewAssign}
        highlightId={highlightId}
        geocoding={geocoding}
        dropTargetId={dropTargetId}
        etaByStop={etaByStop}
        onReorder={setOrdered}
        onAssign={(id, crew) => setCrewAssign((p) => ({ ...p, [id]: crew }))}
        onHighlight={setHighlightId}
        onGeocode={(id) => {
          const s = ordered.find((o) => o.id === id);
          if (s) geocodeOne(s);
        }}
        onSetOnMap={setDropTargetId}
      />
      </div>

      </div>

      <p className="text-[11px] text-gray-400 text-center">
        Changes save automatically — drag to reorder, pick a crew, or hit Optimize.
        Crews see it in My Route.
      </p>
    </div>
  );
}