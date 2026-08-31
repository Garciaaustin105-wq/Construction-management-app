/**
 * Turning geofence events into API calls.
 *
 * A DEPART DELIBERATELY EMITS NOTHING, and that is the most important thing in
 * this file.
 *
 * It used to complete the visit — POST /status {done} — which sends the
 * customer "your yard is done". That bypassed every safeguard the settlement
 * design exists to provide: it fired the moment ONE phone drifted out of the
 * geofence, so a crew member walking to the truck for a trimmer could tell a
 * homeowner their half-cut lawn was finished, and there was no grace period, no
 * minimum on-site time, and no office approval.
 *
 * Completion now happens through settlement, which requires all four gates: the
 * whole crew gone, gone long enough, on site long enough, and (by default) a
 * human's approval. Departure still matters to the state machine — it is what
 * lets on_site_last_at stop advancing, which is the signal settlement measures
 * — but it must never itself finish a visit.
 *
 * Arrival still stamps started_at. That is safe: it is invisible to the
 * customer, /start is idempotent, and it is the only way a visit gets a
 * duration at all.
 */

/** One event from the geofence. Mirrors GeofenceEvent in geofence.ts. */
export type GeoEvent = { type: "arrive" | "depart"; stopId: string; at: number };

/** Which visits have already been started, so nothing repeats. */
export type ActionLedger = {
  started: string[];
};

/** A request the caller should perform. */
export type PlannedCall = {
  method: "POST";
  url: string;
  /** JSON body, or null when the request has no body. */
  body: Record<string, unknown> | null;
  visitId: string;
  kind: "start";
};

/** An empty ledger with nothing started. */
export function emptyLedger(): ActionLedger {
  return { started: [] };
}

/**
 * Decide what to call for a batch of events, given what has already fired.
 * Never mutates the ledger argument.
 *
 * Only arrivals produce calls. See the file header for why a depart must not.
 */
export function planGeofenceCalls(
  events: GeoEvent[],
  ledger: ActionLedger
): { calls: PlannedCall[]; ledger: ActionLedger } {
  const calls: PlannedCall[] = [];
  const newLedger: ActionLedger = { started: [...ledger.started] };

  for (const event of events) {
    if (event.type !== "arrive") continue;
    const visitId = event.stopId;
    if (newLedger.started.includes(visitId)) continue;
    calls.push({
      method: "POST",
      url: `/api/lawn/visits/${visitId}/start`,
      body: null,
      visitId,
      kind: "start",
    });
    newLedger.started.push(visitId);
  }

  return { calls, ledger: newLedger };
}

/**
 * Record that a call FAILED so it can be retried on a later fix. Never mutates
 * the argument. A network blip mid-route is expected; losing the start stamp
 * silently is not.
 */
export function rollbackCall(ledger: ActionLedger, call: PlannedCall): ActionLedger {
  return { started: ledger.started.filter((id) => id !== call.visitId) };
}
