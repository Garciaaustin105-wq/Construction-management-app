"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { loadGoogleMaps, GOOGLE_MAPS_API_KEY } from "@/lib/googleMaps";
import {
  EVENT_OFFLINE,
  EVENT_POSITION,
  PRESENCE_ROLE_CREW,
  PRESENCE_ROLE_VIEWER,
  STALE_MS,
  agoLabel,
  crewChannelName,
  isStale,
  mphFromMps,
  type CrewPosition,
} from "@/lib/crewTracking";
import { MapPin, Navigation, WifiOff, Users } from "lucide-react";

// Office half of live crew tracking. Two jobs:
//
//   1. REGISTER PRESENCE as a viewer. This is not incidental — it is the
//      switch. Crew clients sit silent (GPS off, nothing transmitted) until
//      they see a viewer on the channel, so simply having this component
//      mounted is what turns tracking on, and unmounting turns it off. That
//      presence gate is the feature's whole cost model.
//
//   2. Render a live pin per crew member from broadcast messages. Nothing is
//      read from the database for the live view — no polling, no queries.
//
// A pin is dropped when the crew client says so (EVENT_OFFLINE, sent on
// clock-out or when the last viewer leaves) or when its fix goes older than
// STALE_MS. The stale sweep exists because a phone that dies or loses signal
// never gets to send its goodbye, and a permanently frozen pin is worse than no
// pin — it implies someone is somewhere they are not.

type Props = {
  orgId: string;
  /** The office user's own id — used as the presence key so multiple office
   *  tabs from the same person collapse to one presence entry. */
  viewerId: string;
};

export default function CrewTrackMap({ orgId, viewerId }: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapObj = useRef<google.maps.Map | null>(null);
  const markers = useRef<Map<string, google.maps.Marker>>(new Map());
  const didFit = useRef(false);

  const [positions, setPositions] = useState<Record<string, CrewPosition>>({});
  const [onShift, setOnShift] = useState(0);
  // A missing key is knowable at RENDER time (it's a build-time constant), so
  // it is derived rather than set from inside the effect — no cascading render,
  // and the panel shows on first paint instead of after a flash of empty map.
  // Only genuine runtime load failures go through state.
  const [loadError, setLoadError] = useState<string | null>(null);
  const mapError = GOOGLE_MAPS_API_KEY
    ? loadError
    : "Google Maps key not configured.";
  const [connected, setConnected] = useState(false);
  // Re-render on a timer so "2 min ago" labels age and stale pins disappear
  // even when no new broadcast arrives.
  const [, setTick] = useState(0);

  // ── Map bootstrap ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) return;
    let cancelled = false;
    loadGoogleMaps()
      .then((g) => {
        if (cancelled || !mapRef.current) return;
        mapObj.current = new g.maps.Map(mapRef.current, {
          // Continental US until the first fix arrives and we fit to bounds.
          center: { lat: 39.5, lng: -98.35 },
          zoom: 4,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Map failed to load.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Realtime channel: register as viewer, receive positions ─────────────
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(crewChannelName(orgId), {
      config: { presence: { key: viewerId } },
    });

    let cancelled = false;

    channel
      .on("broadcast", { event: EVENT_POSITION }, ({ payload }) => {
        const p = payload as CrewPosition;
        if (!p?.userId || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
        setPositions((prev) => ({ ...prev, [p.userId]: p }));
      })
      .on("broadcast", { event: EVENT_OFFLINE }, ({ payload }) => {
        const id = (payload as { userId?: string })?.userId;
        if (!id) return;
        setPositions((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ role?: string }>();
        const crew = Object.values(state)
          .flat()
          .filter((p) => p?.role === PRESENCE_ROLE_CREW).length;
        if (!cancelled) setOnShift(crew);
      })
      .subscribe((s) => {
        if (cancelled) return;
        setConnected(s === "SUBSCRIBED");
        if (s === "SUBSCRIBED") {
          // THIS is what wakes the crew clients.
          void channel.track({ role: PRESENCE_ROLE_VIEWER, viewerId });
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [orgId, viewerId]);

  // ── Age out stale pins + refresh relative labels ────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1);
      setPositions((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, CrewPosition> = {};
        for (const [id, p] of Object.entries(prev)) {
          if (isStale(p, now)) changed = true;
          else next[id] = p;
        }
        return changed ? next : prev;
      });
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  const live = useMemo(
    () =>
      Object.values(positions).sort((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? "")
      ),
    [positions]
  );

  // ── Sync markers to positions ──────────────────────────────────────────
  useEffect(() => {
    const map = mapObj.current;
    if (!map || typeof google === "undefined") return;

    const seen = new Set<string>();
    for (const p of live) {
      seen.add(p.userId);
      const existing = markers.current.get(p.userId);
      const pos = { lat: p.lat, lng: p.lng };
      if (existing) {
        existing.setPosition(pos);
        existing.setTitle(`${p.name ?? "Crew"} · ${agoLabel(p.at)}`);
      } else {
        markers.current.set(
          p.userId,
          new google.maps.Marker({
            position: pos,
            map,
            title: `${p.name ?? "Crew"} · ${agoLabel(p.at)}`,
            icon: {
              url: crewPinIcon(),
              scaledSize: new google.maps.Size(28, 36),
              anchor: new google.maps.Point(14, 36),
            },
          })
        );
      }
    }
    // Remove markers for crew that went offline or stale.
    for (const [id, m] of markers.current) {
      if (!seen.has(id)) {
        m.setMap(null);
        markers.current.delete(id);
      }
    }

    // Fit once on the first batch; after that leave the viewport alone so the
    // map doesn't yank itself out from under someone who panned or zoomed.
    if (!didFit.current && live.length > 0) {
      didFit.current = true;
      if (live.length === 1) {
        map.setCenter({ lat: live[0].lat, lng: live[0].lng });
        map.setZoom(14);
      } else {
        const b = new google.maps.LatLngBounds();
        for (const p of live) b.extend({ lat: p.lat, lng: p.lng });
        map.fitBounds(b, 64);
      }
    }
  }, [live]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5 text-gray-600">
          <Users className="w-4 h-4" />
          {onShift} on shift
        </span>
        <span className="inline-flex items-center gap-1.5 text-gray-600">
          <MapPin className="w-4 h-4" />
          {live.length} sharing location
        </span>
        {!connected && (
          <span className="inline-flex items-center gap-1.5 text-amber-600">
            <WifiOff className="w-4 h-4" />
            connecting…
          </span>
        )}
      </div>

      {mapError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {mapError}
        </div>
      ) : (
        <div
          ref={mapRef}
          className="w-full h-[420px] lg:h-[560px] rounded-lg border border-gray-200 bg-gray-100"
        />
      )}

      <div className="bg-white rounded-lg shadow-sm divide-y">
        {live.length === 0 ? (
          <div className="p-4 text-sm text-gray-500">
            {onShift > 0
              ? "Crew are on shift — waiting for their first location fix. This can take up to a minute after you open this tab."
              : "No crew are clocked in right now. Location sharing only runs while someone is on the clock."}
          </div>
        ) : (
          live.map((p) => {
            const mph = mphFromMps(p.speedMps);
            return (
              <button
                key={p.userId}
                type="button"
                onClick={() => {
                  const map = mapObj.current;
                  if (!map) return;
                  map.panTo({ lat: p.lat, lng: p.lng });
                  map.setZoom(15);
                }}
                className="w-full text-left p-3 flex items-center gap-3 active:bg-gray-50"
              >
                <Navigation className="w-4 h-4 text-green-600 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-gray-900 truncate">
                    {p.name ?? "Crew member"}
                  </div>
                  <div className="text-xs text-gray-500">
                    {agoLabel(p.at)}
                    {mph != null && mph > 1 ? ` · ${mph} mph` : ""}
                    {p.accuracyM != null
                      ? ` · ±${Math.round(p.accuracyM)}m`
                      : ""}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      <p className="text-xs text-gray-500">
        Crew share location only while clocked in and only while this tab is
        open. Positions older than {Math.round(STALE_MS / 60000)} minutes are
        dropped.
      </p>
    </div>
  );
}

// Green teardrop, matching the pin style GoogleRouteMap already uses so the two
// lawn maps look like one system.
function crewPinIcon(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36"><path d="M14 1C7.1 1 1.5 6.6 1.5 13.5c0 9 12.5 21 12.5 21s12.5-12 12.5-21C26.5 6.6 20.9 1 14 1z" fill="#16a34a" stroke="#14532d" stroke-width="2"/><circle cx="14" cy="13.5" r="4.5" fill="#fff"/></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
