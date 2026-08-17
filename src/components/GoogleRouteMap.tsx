"use client";

// Google Maps route map — the Leaflet RouteMapView replacement, shared by the
// office RouteMapPlanner (/lawn/routes) and the crew My Route page
// (/lawn/my-route). Renders a numbered, colored marker per mapped stop (number
// = the stop's position in the ordered list, so the map visually shows the
// route order), and optionally a real DRIVING route line via the Directions API
// (DirectionsService → DirectionsRenderer) with the true total drive time +
// distance reported back up via onDirectionsResult.
//
// Office mode (default): marker click highlights the list row; map click while a
// "drop pin" target is active calls onMapClick so the planner can save that
// stop's pin. Crew mode (readOnly): no click handlers — a read-only driving-path
// view.
//
// Loaded client-only via next/dynamic ssr:false (the map touches window). The
// Google Maps JS API is bootstrapped once through [[googleMaps]] (memoized
// singleton Loader).

import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "@/lib/googleMaps";
import type { RouteStop, LatLng } from "@/lib/lawnRouting";

type Props = {
  stops: RouteStop[]; // ordered list (positions = marker numbers)
  highlightId?: string | null;
  dropTargetId?: string | null;
  onMarkerClick?: (id: string) => void;
  onMapClick?: (lat: number, lng: number) => void;
  readOnly?: boolean;
  showDirections?: boolean;
  // Real drive time (minutes) + distance (miles) from the Directions API, once
  // a route resolves. null = no real value this run (caller falls back to the
  // straight-line estimate). Called on success AND when the route can't be
  // computed (<2 stops, over the 25-waypoint cap, or ZERO_RESULTS) so the caller
  // can revert to its fallback instead of showing a stale real value.
  onDirectionsResult?: (minutes: number | null, miles: number | null) => void;
};

// Directions API caps at 25 waypoints (intermediate stops). With origin +
// destination that's 27 stops max; we keep a conservative 25-stop total guard
// so a planner with a huge day falls back to a plain connecting polyline
// instead of erroring. Lawn routes are normally well under this.
const MAX_STOPS_FOR_DIRECTIONS = 25;

function pinIconSrc(bg: string, ring: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36"><path d="M14 1C7.1 1 1.5 6.6 1.5 13.5c0 9 12.5 21 12.5 21s12.5-12 12.5-21C26.5 6.6 20.9 1 14 1z" fill="${bg}" stroke="${ring}" stroke-width="2"/></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export default function GoogleRouteMap({
  stops,
  highlightId = null,
  dropTargetId = null,
  onMarkerClick,
  onMapClick,
  readOnly = false,
  showDirections = false,
  onDirectionsResult,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const rendererRef = useRef<google.maps.DirectionsRenderer | null>(null);
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const lastBoundsSigRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Keep latest callbacks in refs so the map-init / directions effects don't
  // tear down and rebuild the map whenever the parent recreates a handler.
  // Assigned in a deps-free effect (runs after every render) rather than during
  // render — writing refs during render is disallowed by react-hooks/refs.
  const onMapClickRef = useRef(onMapClick);
  const onMarkerClickRef = useRef(onMarkerClick);
  const onResultRef = useRef(onDirectionsResult);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
    onMarkerClickRef.current = onMarkerClick;
    onResultRef.current = onDirectionsResult;
  });

  // --- Map init (mount once) ---
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        const mapped = stops.filter((s) => s.pos);
        const center: LatLng =
          mapped.length > 0
            ? {
                lat: mapped.reduce((a, s) => a + (s.pos!.lat), 0) / mapped.length,
                lng: mapped.reduce((a, s) => a + (s.pos!.lng), 0) / mapped.length,
              }
            : { lat: 39.5, lng: -98.35 };
        const map = new g.maps.Map(containerRef.current, {
          center,
          zoom: mapped.length > 1 ? 12 : 13,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          clickableIcons: false,
          // `greedy` so one-finger pan works on mobile (vs cooperative scroll).
          gestureHandling: "greedy",
        });
        mapRef.current = map;
        if (!readOnly && onMapClickRef.current) {
          clickListenerRef.current = map.addListener("click", (e: google.maps.MapMouseEvent) => {
            const lat = e.latLng?.lat();
            const lng = e.latLng?.lng();
            if (typeof lat === "number" && typeof lng === "number") {
              onMapClickRef.current?.(lat, lng);
            }
          });
        }
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load Google Maps");
      });
    return () => {
      cancelled = true;
      clickListenerRef.current?.remove();
      clickListenerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Markers (rebuild on stop order/highlight change) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const g = google;
    // Clear previous markers.
    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = [];

    stops.forEach((s, i) => {
      if (!s.pos) return;
      const done = s.status === "done";
      const highlighted = highlightId === s.id;
      const bg = done ? "#9ca3af" : "#16a34a"; // gray done, green pending
      const ring = highlighted ? "#1d4ed8" : "#ffffff";
      const marker = new g.maps.Marker({
        position: { lat: s.pos.lat, lng: s.pos.lng },
        map,
        icon: {
          url: pinIconSrc(bg, ring),
          scaledSize: new g.maps.Size(28, 36),
          anchor: new g.maps.Point(14, 35),
          labelOrigin: new g.maps.Point(14, 14),
        },
        label: {
          text: String(i + 1),
          color: "#ffffff",
          fontSize: "12px",
          fontWeight: "bold",
        },
        zIndex: highlighted ? 1000 : 1,
      });
      if (!readOnly) {
        marker.addListener("click", () => onMarkerClickRef.current?.(s.id));
      }
      markersRef.current.push(marker);
    });
  }, [stops, highlightId, ready, readOnly]);

  // --- Fit bounds when the set of pinned positions changes (NOT on reorder) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const mapped = stops.filter((s) => s.pos);
    if (mapped.length === 0) return;
    // Signature of id+position so a pure reorder (same positions, new order)
    // doesn't re-fit and yank the viewport around while the dispatcher drags.
    const sig = mapped
      .map((s) => `${s.id}:${s.pos!.lat.toFixed(6)},${s.pos!.lng.toFixed(6)}`)
      .sort()
      .join("|");
    if (sig === lastBoundsSigRef.current) return;
    lastBoundsSigRef.current = sig;

    if (mapped.length === 1) {
      map.setCenter({ lat: mapped[0].pos!.lat, lng: mapped[0].pos!.lng });
      map.setZoom(13);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const s of mapped) bounds.extend({ lat: s.pos!.lat, lng: s.pos!.lng });
    map.fitBounds(bounds, 40);
  }, [stops, ready]);

  // --- Driving directions (real path + real drive time/distance) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    // Tear down any previous route rendering.
    rendererRef.current?.setMap(null);
    rendererRef.current = null;
    polylineRef.current?.setMap(null);
    polylineRef.current = null;

    const mapped = stops.filter((s) => s.pos);

    if (!showDirections || mapped.length < 2) {
      onResultRef.current?.(null, null);
      return;
    }

    // Over the Directions waypoint cap → plain connecting polyline, no real ETA.
    if (mapped.length > MAX_STOPS_FOR_DIRECTIONS) {
      const path = mapped.map((s) => ({ lat: s.pos!.lat, lng: s.pos!.lng }));
      polylineRef.current = new google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: "#16a34a",
        strokeWeight: 4,
        strokeOpacity: 0.8,
        map,
      });
      onResultRef.current?.(null, null);
      return;
    }

    const origin = { lat: mapped[0].pos!.lat, lng: mapped[0].pos!.lng };
    const destination = {
      lat: mapped[mapped.length - 1].pos!.lat,
      lng: mapped[mapped.length - 1].pos!.lng,
    };
    const waypoints = mapped.slice(1, -1).map((s) => ({
      location: { lat: s.pos!.lat, lng: s.pos!.lng },
      stopover: true,
    }));

    const renderer = new google.maps.DirectionsRenderer({
      suppressMarkers: true, // our numbered pins are the markers
      polylineOptions: { strokeColor: "#16a34a", strokeWeight: 5, strokeOpacity: 0.85 },
    });
    renderer.setMap(map);
    rendererRef.current = renderer;

    const service = new google.maps.DirectionsService();
    service.route(
      {
        origin,
        destination,
        waypoints,
        travelMode: google.maps.TravelMode.DRIVING,
        optimizeWaypoints: false, // keep the dispatcher's saved order
      },
      (result, status) => {
        if (status === google.maps.DirectionsStatus.OK && result) {
          renderer.setDirections(result);
          let secs = 0;
          let meters = 0;
          for (const leg of result.routes[0]?.legs ?? []) {
            secs += leg.duration?.value ?? 0;
            meters += leg.distance?.value ?? 0;
          }
          onResultRef.current?.(secs / 60, meters / 1609.34);
        } else {
          // ZERO_RESULTS / over limit / etc. — fall back to a plain polyline so
          // the crew still sees a connecting path, and tell the caller to revert
          // to its straight-line estimate.
          renderer.setMap(null);
          rendererRef.current = null;
          polylineRef.current = new google.maps.Polyline({
            path: mapped.map((s) => ({ lat: s.pos!.lat, lng: s.pos!.lng })),
            geodesic: true,
            strokeColor: "#16a34a",
            strokeWeight: 4,
            strokeOpacity: 0.8,
            map,
          });
          onResultRef.current?.(null, null);
        }
      }
    );
  }, [stops, showDirections, ready]);

  if (error) {
    return (
      <div className="w-full h-[320px] lg:h-[560px] rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center p-4 text-center">
        <p className="text-xs text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div
      className={`relative w-full h-[320px] lg:h-[560px] rounded-lg overflow-hidden shadow-sm border ${
        dropTargetId ? "border-blue-500 ring-2 ring-blue-300" : "border-gray-200"
      }`}
    >
      <div ref={containerRef} className="w-full h-full" />
      {dropTargetId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow pointer-events-none">
          Click the map to drop this stop&rsquo;s pin
        </div>
      )}
    </div>
  );
}