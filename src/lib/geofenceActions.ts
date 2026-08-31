/**
 * One event from the geofence. Mirrors GeofenceEvent in geofence.ts.
 */
export type GeoEvent = { type: "arrive" | "depart"; stopId: string; at: number };

/**
 * Which visits have already had each action fired, so nothing repeats.
 */
export type ActionLedger = {
  started: string[];
  completed: string[];
};

/**
 * A request the caller should perform.
 */
export type PlannedCall = {
  method: "POST";
  url: string;
  /** JSON body, or null when the request has no body. */
  body: Record<string, unknown> | null;
  /** Which visit and which action this call represents. */
  visitId: string;
  kind: "start" | "complete";
};

/**
 * Returns an empty ledger with no visits started or completed.
 */
export function emptyLedger(): ActionLedger {
  return { started: [], completed: [] };
}

/**
 * Decide what to call for a batch of events, given what has already fired.
 * Returns the calls to make and the ledger to use next time. Never mutates
 * the ledger argument.
 */
export function planGeofenceCalls(
  events: GeoEvent[],
  ledger: ActionLedger
): { calls: PlannedCall[]; ledger: ActionLedger } {
  const calls: PlannedCall[] = [];
  const newLedger = { started: [...ledger.started], completed: [...ledger.completed] };

  for (const event of events) {
    const { type, stopId: visitId } = event;

    if (type === "arrive") {
      if (!newLedger.started.includes(visitId)) {
        calls.push({
          method: "POST",
          url: `/api/lawn/visits/${visitId}/start`,
          body: null,
          visitId,
          kind: "start",
        });
        newLedger.started.push(visitId);
      }
    } else if (type === "depart") {
      if (!newLedger.completed.includes(visitId)) {
        calls.push({
          method: "POST",
          url: `/api/lawn/visits/${visitId}/status`,
          body: { status: "done" },
          visitId,
          kind: "complete",
        });
        newLedger.completed.push(visitId);
      }
    }
  }

  return { calls, ledger: newLedger };
}

/**
 * Record that a call FAILED, so it can be retried later. Removes the visit
 * from the relevant list. Never mutates the argument.
 */
export function rollbackCall(ledger: ActionLedger, call: PlannedCall): ActionLedger {
  const newLedger = { started: [...ledger.started], completed: [...ledger.completed] };

  if (call.kind === "start") {
    newLedger.started = newLedger.started.filter(id => id !== call.visitId);
  } else if (call.kind === "complete") {
    newLedger.completed = newLedger.completed.filter(id => id !== call.visitId);
  }

  return newLedger;
}
