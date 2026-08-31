// Geofence state machine for automatic arrive/depart at lawn properties.
//
// Pure: no timers, no Date.now(), no I/O, no mutation. Every decision comes from
// the fix you feed it, so it is fully testable and deterministic. The caller
// owns GPS, the clock, and the side effects.
//
// The parameters below are chosen, not guessed — geofencing fails in known ways:
//
//   * HYSTERESIS is the important one. Entering uses a SMALLER radius than
//     leaving, and the gap between them must exceed GPS error. Without it a
//     truck parked on the property line flaps arrive/depart forever, which in
//     this app means repeatedly completing and reopening a customer's visit.
//   * DWELL stops a drive-by opening a visit. Guidance is 30-60s minimum; a lawn
//     stop is never under a couple of minutes, so 90s costs nothing.
//   * DEPART DWELL IS LONGER THAN ARRIVE on purpose: a crew member walking to
//     the truck for a trimmer must not end the visit.
//   * An ACCURACY FLOOR matters because a fix with a 200m accuracy radius cannot
//     tell you which property you are standing on. Drop it rather than act on it.

/** A property the crew may arrive at — a lawn visit plus its map pin. */
export type GeoStop = { id: string; lat: number; lng: number };

/** One GPS reading. */
export type Fix = {
  lat: number;
  lng: number;
  /** Accuracy radius in metres, or null when the device does not report it. */
  accuracyM: number | null;
  /** Epoch milliseconds the fix was taken. The only clock this module has. */
  at: number;
};

export type GeofenceState = {
  /** Stop currently considered inside, or null. */
  insideStopId: string | null;
  /** Epoch ms we first went inside `insideStopId`. */
  insideSince: number | null;
  /** Stop we have already emitted an "arrive" for, or null. */
  arrivedStopId: string | null;
  /** Epoch ms we first went outside `arrivedStopId`; cleared on return. */
  outsideSince: number | null;
};

export type GeofenceEvent =
  | { type: "arrive"; stopId: string; at: number }
  | { type: "depart"; stopId: string; at: number };

export type GeofenceOptions = {
  enterRadiusM?: number;
  exitRadiusM?: number;
  arriveDwellMs?: number;
  departDwellMs?: number;
  maxAccuracyM?: number;
};

export const GEOFENCE_DEFAULTS: Required<GeofenceOptions> = {
  /** Residential lots are small; larger and you capture the neighbour. */
  enterRadiusM: 100,
  /** 50m of hysteresis over the enter radius — comfortably above GPS drift. */
  exitRadiusM: 150,
  arriveDwellMs: 90_000,
  departDwellMs: 180_000,
  maxAccuracyM: 75,
};

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two points (haversine). */
export function distanceMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fresh state: nothing inside, nothing arrived. */
export function initialGeofenceState(): GeofenceState {
  return {
    insideStopId: null,
    insideSince: null,
    arrivedStopId: null,
    outsideSince: null,
  };
}

/**
 * Fold one GPS fix into the state, returning the new state and any events it
 * caused. Never mutates its arguments.
 *
 * A single fix can produce BOTH a depart (of the previous stop) and an arrive
 * (of the next) — driving from one property to the next. They are returned
 * depart-first.
 */
export function stepGeofence(
  state: GeofenceState,
  fix: Fix,
  stops: GeoStop[],
  options?: GeofenceOptions
): { state: GeofenceState; events: GeofenceEvent[] } {
  const opts = { ...GEOFENCE_DEFAULTS, ...options };
  const events: GeofenceEvent[] = [];
  let next: GeofenceState = { ...state };

  // A fix too imprecise to attribute to a property is worse than no fix.
  if (fix.accuracyM !== null && fix.accuracyM > opts.maxAccuracyM) {
    return { state: next, events };
  }

  // ── Which stop, if any, are we inside right now? Nearest wins. ───────────
  let nearest: GeoStop | null = null;
  let nearestDist = Infinity;
  for (const stop of stops) {
    const d = distanceMeters(fix.lat, fix.lng, stop.lat, stop.lng);
    if (d <= opts.enterRadiusM && d < nearestDist) {
      nearest = stop;
      nearestDist = d;
    }
  }

  if (nearest) {
    // Dwell must be CONTINUOUS on one stop, so switching restarts the clock.
    if (next.insideStopId !== nearest.id) {
      next = { ...next, insideStopId: nearest.id, insideSince: fix.at };
    }
  } else if (next.insideStopId !== null) {
    next = { ...next, insideStopId: null, insideSince: null };
  }

  // ── DEPART is evaluated BEFORE arrive, and the order is load-bearing ─────
  //
  // Doing arrive first is the natural way to write this and it is wrong:
  // driving from property A to property B, the arrive branch overwrites
  // arrivedStopId with B and clears outsideSince, so A's departure is never
  // evaluated and A's visit stays open forever. Since a depart is what marks a
  // visit done, that is a visit that never completes. Evaluating depart first
  // also yields the documented depart-then-arrive ordering for free.
  if (next.arrivedStopId !== null) {
    const arrivedId = next.arrivedStopId;
    const arrived = stops.find((s) => s.id === arrivedId);
    // The arrived stop can legitimately disappear from `stops` — the route is
    // reloaded, the visit is reassigned or rescheduled. Hold state rather than
    // dereferencing undefined, which would throw inside the caller's GPS
    // handler and kill tracking for the rest of the shift.
    if (arrived) {
      const d = distanceMeters(fix.lat, fix.lng, arrived.lat, arrived.lng);
      if (d > opts.exitRadiusM) {
        if (next.outsideSince === null) {
          next = { ...next, outsideSince: fix.at };
        } else if (fix.at - next.outsideSince >= opts.departDwellMs) {
          events.push({ type: "depart", stopId: arrivedId, at: fix.at });
          next = { ...next, arrivedStopId: null, outsideSince: null };
        }
      } else {
        // Back inside the exit ring before the dwell finished — walked to the
        // truck and returned. Cancel the pending departure.
        next = { ...next, outsideSince: null };
      }
    }
  }

  // ── ARRIVE ───────────────────────────────────────────────────────────────
  if (next.insideStopId !== null && next.insideSince !== null) {
    const dwelled = fix.at - next.insideSince;
    if (dwelled >= opts.arriveDwellMs && next.arrivedStopId !== next.insideStopId) {
      // IMPLICIT DEPART. Arriving at a different property necessarily means you
      // left the previous one — you can only be at one at a time.
      //
      // Without this, neighbouring properties never complete. Lawn routes are
      // built by geographic clustering, so adjacent jobs are the NORMAL case,
      // and suburban lots are ~25-30 m apart — well inside the 150 m exit
      // radius. Standing on B you are still ~30 m from A, so the distance-based
      // depart above can never fire and A's visit stays open forever. Measured:
      // four neighbours on one street produced 3 arrivals and 0 departures.
      //
      // The distance-based depart above still handles the ordinary case of
      // driving away from the last property of the day, where there is no next
      // stop to imply it.
      if (next.arrivedStopId !== null) {
        events.push({ type: "depart", stopId: next.arrivedStopId, at: fix.at });
      }
      events.push({ type: "arrive", stopId: next.insideStopId, at: fix.at });
      next = { ...next, arrivedStopId: next.insideStopId, outsideSince: null };
    }
  }

  return { state: next, events };
}
