"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  BREADCRUMB_MS,
  BROADCAST_MS,
  EVENT_OFFLINE,
  EVENT_POSITION,
  PRESENCE_ROLE_CREW,
  PRESENCE_ROLE_VIEWER,
  crewChannelName,
  type CrewPosition,
} from "@/lib/crewTracking";

// Crew-side half of live tracking. Runs on the crew's phone while they are
// CLOCKED IN and broadcasts position only while an office user is actually
// watching.
//
// The presence gate is the whole cost model. The client joins the org channel
// and tracks presence, but `navigator.geolocation.watchPosition` is not even
// started until Presence reports at least one PRESENCE_ROLE_VIEWER. With nobody
// on the tracking tab this hook is idle: no GPS, no battery drain, no messages.
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
};

export function useCrewLocationBroadcast({
  enabled,
  orgId,
  userId,
  name,
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

  useEffect(() => {
    if (!active || !orgId || !userId) return;

    const supabase = createClient();
    const channel = supabase.channel(crewChannelName(orgId), {
      config: { presence: { key: userId } },
    });

    let cancelled = false;
    let watchId: number | null = null;
    let broadcastTimer: ReturnType<typeof setInterval> | null = null;

    // ── GPS is started ONLY when someone is watching, and stopped the moment
    //    they leave. This is what makes "standby" genuinely free.
    const startGps = () => {
      if (watchId !== null || typeof navigator === "undefined") return;
      if (!("geolocation" in navigator)) {
        setLiveStatus("denied");
        return;
      }
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          latest.current = pos;
          if (!cancelled) setLiveStatus("sharing");
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
          startGps();
          // Send as soon as a fix lands rather than waiting a full interval, so
          // the office map populates quickly after opening.
          broadcastTimer ??= setInterval(send, BROADCAST_MS);
        }
      } else if (watching.current) {
        watching.current = false;
        stopGps();
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
