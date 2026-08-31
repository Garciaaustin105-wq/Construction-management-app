"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  BREADCRUMB_MS,
  BROADCAST_MS,
  EVENT_OFFLINE,
  EVENT_POSITION,
  ON_SITE_PING_MS,
  PRESENCE_ROLE_CREW,
  PRESENCE_ROLE_VIEWER,
  crewChannelName,
  type CrewPosition,
} from "@/lib/crewTracking";
import {
  initialGeofenceState,
  onSiteStopId,
  stepGeofence,
  type GeoStop,
  type GeofenceState,
} from "@/lib/geofence";
import {
  clusterOf,
  clusterStops,
  type Cluster,
} from "@/lib/stopClusters";
import {
  emptyLedger,
  planGeofenceCalls,
  rollbackCall,
  type ActionLedger,
} from "@/lib/geofenceActions";

// Crew-side half of live tracking. Runs on the crew's phone while they are
// CLOCKED IN and broadcasts position only while an office user is actually
// watching.
//
// TWO CONSUMERS, DELIBERATELY DECOUPLED:
//
//   GPS runs for the whole shift, because geofenced auto arrive/depart has to
//   work unattended — arrivals happen all day whether anyone is watching.
//
//   BROADCASTING is presence-gated. Supabase caps CONCURRENT Realtime
//   connections (200 Free / 500 Pro) platform-wide across every tenant, so that
//   ceiling scales with clocked-in crew rather than revenue. Transmitting only
//   while an office viewer is present is what keeps the feature inside it.
//
// So a crew phone with nobody watching: GPS on, geofence running, zero messages.
//
// Two write paths, deliberately different rates:
//   • broadcast  — every BROADCAST_MS (30s), ephemeral, no rows, no Vercel
//   • breadcrumb — every BREADCRUMB_MS (5 min), one insert straight to
//                  PostgREST under RLS, also no Vercel
//
// `enabled` is owned by the caller (the crew time page already knows whether
// there's an open shift) rather than re-derived here — one source of truth for
// "on the clock", and it keeps this hook free of any time-clock coupling.

export type BroadcastStatus =
  | "off" // not clocked in, or tracking not available to this org
  | "standby" // clocked in, channel joined, nobody watching → GPS is OFF
  | "sharing" // office is watching and we are sending fixes
  | "denied" // clocked in and watched, but the device refused location
  | "error"; // channel failed to join

type Options = {
  /** Master switch — pass true only while the user is clocked in AND the org's
   *  plan includes tracking. False tears everything down. */
  enabled: boolean;
  orgId: string | null;
  userId: string | null;
  /** Display name for the office map's pin label. */
  name: string | null;
  /** Today's pending visits for this crew member, with map pins. Visits without
   *  a pin must be omitted — they simply never auto-stamp and fall back to the
   *  manual Start/Done buttons on My Route. */
  stops?: GeoStop[];
};

export function useCrewLocationBroadcast({
  enabled,
  orgId,
  userId,
  name,
  stops = [],
}: Options): { status: BroadcastStatus; lastSentAt: number | null } {
  // The channel's own status. "off" is NOT stored here — it is derived below
  // from `enabled`, so the disabled case never needs a setState in the effect
  // body (which would be a cascading render, and is what react-hooks/
  // set-state-in-effect correctly objects to).
  const [liveStatus, setLiveStatus] = useState<BroadcastStatus>("standby");
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const active = enabled && !!orgId && !!userId;
  const status: BroadcastStatus = active ? liveStatus : "off";

  // Latest fix from watchPosition, read by the broadcast interval. Held in a
  // ref so a new fix doesn't re-render the crew's screen every second.
  const latest = useRef<GeolocationPosition | null>(null);
  const lastBreadcrumbAt = useRef(0);
  // Mirrors `status` for use inside interval callbacks without adding it to the
  // effect deps (which would tear down and rebuild the channel on every change).
  const watching = useRef(false);
  // Geofence state + the record of which visits have already been started or
  // completed. Refs, not state: these must survive re-renders without tearing
  // down the GPS watch, and nothing renders from them.
  const fence = useRef<GeofenceState>(initialGeofenceState());
  const ledger = useRef<ActionLedger>(emptyLedger());
  // Read inside the GPS callback without making it an effect dependency, which
  // would restart the watch every time the route is refreshed.
  const stopsRef = useRef<GeoStop[]>(stops);
  // Last time we stamped the on-site mark for each CLUSTER, so a 1-second GPS
  // stream does not become a 1-second write stream.
  const onSitePingedAt = useRef<Record<string, number>>({});
  // Today's stops grouped into work areas. Recomputed only when the route
  // changes, never per fix — clustering is O(n^2) over the day's stops.
  const clustersRef = useRef<Cluster[]>([]);

  // Keep the ref in step with the prop OUTSIDE render. The GPS callback reads
  // it, so the stop list can be refreshed mid-shift without `stops` being an
  // effect dependency — which would tear down and restart the GPS watch every
  // time the route reloaded.
  useEffect(() => {
    stopsRef.current = stops;
    clustersRef.current = clusterStops(stops);
  }, [stops]);

  useEffect(() => {
    if (!active || !orgId || !userId) return;

    const supabase = createClient();
    const channel = supabase.channel(crewChannelName(orgId), {
      config: { presence: { key: userId } },
    });

    let cancelled = false;
    let watchId: number | null = null;
    let broadcastTimer: ReturnType<typeof setInterval> | null = null;

    // ── GPS runs for the WHOLE SHIFT, independently of who is watching ──────
    //
    // It used to start only when an office viewer appeared. That was right when
    // the live map was the only consumer, but geofenced auto arrive/depart has
    // to work unattended — arrivals happen all day whether or not anyone has
    // the map open.
    //
    // Crucially this does NOT mean holding the Realtime socket all shift. The
    // geofence is a pure local state machine; it needs GPS and the stop list and
    // nothing else. Only BROADCASTING is presence-gated, because Supabase caps
    // CONCURRENT connections (200 Free / 500 Pro) platform-wide across every
    // tenant — that ceiling scales with clocked-in crew rather than revenue, and
    // socket-all-shift would be roughly 4x the connection-hours for no benefit.
    // Fold each fix through the geofence and perform whatever it decides.
    //
    // A "depart" marks the visit DONE, which emails the customer — so the
    // ledger guarantees at-most-once per visit, and a failed call is rolled
    // back so it can be retried on a later fix rather than lost.
    const runGeofence = async (pos: GeolocationPosition) => {
      const current = stopsRef.current;
      if (current.length === 0) return;

      const { state: nextFence, events } = stepGeofence(
        fence.current,
        {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          at: Date.now(),
        },
        current
      );
      fence.current = nextFence;

      // ── MEASUREMENT, deliberately independent of STATUS ──────────────────
      //
      // This runs before the events check, and that placement is the point: a
      // fix that produces no arrive/depart still proves the crew is standing on
      // the property. Measuring only on state changes would record two
      // timestamps per visit and nothing in between, and would stop entirely
      // for a crew that never triggers a clean depart.
      //
      // Risk asymmetry drives the whole design here (see the crew-model doc
      // §4): getting COMPLETION wrong emails a customer mid-job, so it stays
      // deliberate. Getting MEASUREMENT wrong costs a row in a dataset nobody
      // but the office sees, so it can be fully automatic. Separating them is
      // what lets the pricing dataset accumulate from day one with no taps.
      //
      // THE GATE: inside AND arrived, both required.
      //
      //   arrived  — a crew driving past stop #5 on the way to stop #1 must not
      //              stamp on_site_first_at hours early. The dwell (90s) is far
      //              longer than the ~15s it takes to cross the radius at road
      //              speed, so presence alone is not enough.
      //   inside   — arrivedStopId STAYS set through the 3-minute depart dwell,
      //              so keying on it alone would keep pushing the high-water
      //              mark for three minutes after the truck has physically
      //              gone, inflating every visit by that much.
      //
      // Known cost: on_site_first_at therefore lands ~90s after real arrival, a
      // systematic under-measurement of one dwell per visit. That is ~7% of a
      // 20-minute stop. It is under-measurement rather than over-, which is the
      // safe direction for a pricing floor, and it is fixable later by passing
      // the observed insideSince to the RPC instead of using its clock.
      // MEASURE THE CLUSTER, NOT THE PROPERTY.
      //
      // Standing on one lawn of a four-house street does not mean the other
      // three are idle — the mower, edger and blower are on different lawns at
      // the same time, and GPS cannot separate lots 25-30 m apart anyway. So
      // the whole adjacent group is stamped together, which is both honest
      // about the sensor and the only way the pricing maths comes out right:
      // one window over the cluster's summed area, never a per-house rate
      // derived from a shared window.
      //
      // One call for the whole cluster, not one per visit — a five-property
      // street worked by four crew would otherwise be 20 round trips a minute
      // from phones on cellular data. Throttling is keyed by CLUSTER to match.
      const onSiteId = onSiteStopId(nextFence);
      const cluster = onSiteId ? clusterOf(onSiteId, clustersRef.current) : null;
      if (cluster) {
        const last = onSitePingedAt.current[cluster.id] ?? 0;
        const now = Date.now();
        if (now - last >= ON_SITE_PING_MS) {
          // Claim the slot BEFORE awaiting, so two fixes arriving together
          // cannot both fire; roll back on failure so the next fix retries.
          onSitePingedAt.current[cluster.id] = now;
          try {
            const { error } = await supabase.rpc("record_cluster_on_site", {
              p_visit_ids: cluster.stopIds,
            });
            if (error) onSitePingedAt.current[cluster.id] = last;
          } catch {
            onSitePingedAt.current[cluster.id] = last;
          }
        }
      }

      if (events.length === 0) return;

      const { calls, ledger: nextLedger } = planGeofenceCalls(
        events,
        ledger.current
      );
      ledger.current = nextLedger;

      for (const call of calls) {
        try {
          const res = await fetch(call.url, {
            method: call.method,
            headers: call.body ? { "Content-Type": "application/json" } : undefined,
            body: call.body ? JSON.stringify(call.body) : undefined,
          });
          if (!res.ok) ledger.current = rollbackCall(ledger.current, call);
        } catch {
          // Network blip mid-route is expected. Roll back so the next fix
          // retries; never leave a visit silently un-completed.
          ledger.current = rollbackCall(ledger.current, call);
        }
      }
    };

    const startGps = () => {
      if (watchId !== null || typeof navigator === "undefined") return;
      if (!("geolocation" in navigator)) {
        setLiveStatus("denied");
        return;
      }
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          latest.current = pos;
          if (!cancelled) setLiveStatus(watching.current ? "sharing" : "standby");
          void runGeofence(pos);
        },
        () => {
          if (!cancelled) setLiveStatus("denied");
        },
        {
          // Deliberately NOT high accuracy. A truck's position to ~50m is all
          // the office needs, and enableHighAccuracy over an 8-hour shift is
          // the difference between a phone lasting the day and not.
          enableHighAccuracy: false,
          maximumAge: BROADCAST_MS,
          timeout: 20_000,
        }
      );
    };

    const stopGps = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      latest.current = null;
    };

    const send = async () => {
      const pos = latest.current;
      if (!pos || !watching.current) return;

      const payload: CrewPosition = {
        userId,
        name,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy ?? null,
        headingDeg: Number.isFinite(pos.coords.heading as number)
          ? (pos.coords.heading as number)
          : null,
        speedMps: Number.isFinite(pos.coords.speed as number)
          ? (pos.coords.speed as number)
          : null,
        at: Date.now(),
      };

      await channel.send({
        type: "broadcast",
        event: EVENT_POSITION,
        payload,
      });
      if (!cancelled) setLastSentAt(payload.at);

      // Sparse breadcrumb. Failures are swallowed on purpose: a dropped history
      // row must never break the live view, which is the part being watched.
      const now = Date.now();
      if (now - lastBreadcrumbAt.current >= BREADCRUMB_MS) {
        lastBreadcrumbAt.current = now;
        try {
          await supabase.from("crew_locations").insert({
            organization_id: orgId,
            user_id: userId,
            lat: payload.lat,
            lng: payload.lng,
            accuracy_m: payload.accuracyM,
            heading_deg: payload.headingDeg,
            speed_mps: payload.speedMps,
          });
        } catch {
          // ignore — history is best-effort
        }
      }
    };

    // ── Presence: are any office viewers on the channel right now? ──────────
    const evaluatePresence = () => {
      const state = channel.presenceState<{ role?: string }>();
      const viewers = Object.values(state)
        .flat()
        .filter((p) => p?.role === PRESENCE_ROLE_VIEWER).length;

      if (viewers > 0) {
        if (!watching.current) {
          watching.current = true;
          // GPS is already running (it starts with the shift) — presence only
          // decides whether we transmit.
          broadcastTimer ??= setInterval(send, BROADCAST_MS);
          if (!cancelled) setLiveStatus("sharing");
        }
      } else if (watching.current) {
        watching.current = false;
        if (broadcastTimer) {
          clearInterval(broadcastTimer);
          broadcastTimer = null;
        }
        if (!cancelled) setLiveStatus("standby");
        // Tell the map to drop our pin now rather than let it age out.
        void channel.send({
          type: "broadcast",
          event: EVENT_OFFLINE,
          payload: { userId },
        });
      }
    };

    channel
      .on("presence", { event: "sync" }, evaluatePresence)
      .on("presence", { event: "join" }, evaluatePresence)
      .on("presence", { event: "leave" }, evaluatePresence)
      .subscribe((s) => {
        if (cancelled) return;
        if (s === "SUBSCRIBED") {
          setLiveStatus("standby");
          startGps();
          void channel.track({ role: PRESENCE_ROLE_CREW, userId, name });
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
          setLiveStatus("error");
        }
      });

    return () => {
      cancelled = true;
      watching.current = false;
      stopGps();
      if (broadcastTimer) clearInterval(broadcastTimer);
      // Best-effort goodbye so the office pin disappears immediately on clock-out.
      void channel
        .send({ type: "broadcast", event: EVENT_OFFLINE, payload: { userId } })
        .catch(() => {})
        .finally(() => {
          void supabase.removeChannel(channel);
        });
    };
  }, [active, orgId, userId, name]);

  return { status, lastSentAt };
}
