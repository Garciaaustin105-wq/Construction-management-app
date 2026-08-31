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

/** A property the crew may arrive at — a lawn visit plus its map pin.
 *
 *  `routeOrder` is the visit's position in the day's planned route. It is the
 *  tie-breaker when two properties are too close together for GPS to separate
 *  them: crews work a route in sequence, so "the next one I have not done yet"
 *  is stronger evidence than a distance difference smaller than the error bar. */
export type GeoStop = {
  id: string;
  lat: number;
  lng: number;
  routeOrder?: number | null;
};

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
  /** Two candidates whose distances differ by less than this (or less than the
   *  fix's own accuracy, whichever is larger) are treated as tied, and route
   *  order decides. Default 30 m — about one suburban lot. */
  tieBreakMarginM?: number;
};

export const GEOFENCE_DEFAULTS: Required<GeofenceOptions> = {
  /** Residential lots are small; larger and you capture the neighbour. */
  enterRadiusM: 100,
  /** 50m of hysteresis over the enter radius — comfortably above GPS drift. */
  exitRadiusM: 150,
  arriveDwellMs: 90_000,
  departDwellMs: 180_000,
  maxAccuracyM: 75,
  tieBreakMarginM: 30,
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
 * Which stop the crew is ON SITE at right now, for MEASUREMENT purposes, or
 * null. Both conditions are required and each rules out a different error:
 *
 *   insideStopId === arrivedStopId (arrived)
 *     A crew driving past a later stop must not stamp it as visited. The arrive
 *     dwell is far longer than the time it takes to cross the radius at road
 *     speed, so mere presence is not evidence of working.
 *
 *   insideStopId !== null (still inside)
 *     arrivedStopId deliberately STAYS set through the whole depart dwell, so a
 *     mark keyed on it alone would keep advancing for minutes after the truck
 *     had left, inflating every visit by one depart dwell.
 *
 * Deliberately NOT the same question as "is this visit started" — measurement
 * is independent of status. See the crew-model design, §4.
 */
export function onSiteStopId(state: GeofenceState): string | null {
  return state.insideStopId !== null && state.insideStopId === state.arrivedStopId
    ? state.insideStopId
    : null;
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

  // ── Which stop are we inside? Nearest wins, but route order breaks ties ──
  //
  // Pure nearest-wins misattributes in exactly the case that matters most:
  // neighbouring properties. Suburban lots are ~25-30 m apart and GPS error is
  // 10-20 m, so the "nearest" pin can easily be the house next door. When two
  // candidates are closer to each other than the error bar, geometry has no
  // real opinion — but the ROUTE does. Crews work a route in sequence, so among
  // tied candidates the earliest unfinished one in route order wins.
  //
  // The tie margin widens with the fix's own accuracy: a sloppy fix should make
  // more candidates count as tied, not fewer.
  const inRange: { stop: GeoStop; d: number }[] = [];
  for (const stop of stops) {
    const d = distanceMeters(fix.lat, fix.lng, stop.lat, stop.lng);
    if (d <= opts.enterRadiusM) inRange.push({ stop, d });
  }

  let nearest: GeoStop | null = null;
  if (inRange.length > 0) {
    const closest = inRange.reduce((a, b) => (b.d < a.d ? b : a));
    const margin = Math.max(opts.tieBreakMarginM, fix.accuracyM ?? 0);
    const tied = inRange.filter((c) => c.d - closest.d <= margin);
    if (tied.length === 1) {
      nearest = closest.stop;
    } else {
      // Lowest routeOrder wins; stops without one sort last, and distance
      // decides between two that are equally unordered.
      const rank = (c: { stop: GeoStop; d: number }) =>
        c.stop.routeOrder ?? Number.POSITIVE_INFINITY;
      nearest = tied.reduce((a, b) => {
        if (rank(b) !== rank(a)) return rank(b) < rank(a) ? b : a;
        return b.d < a.d ? b : a;
      }).stop;
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
