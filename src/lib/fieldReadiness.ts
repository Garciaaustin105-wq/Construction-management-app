// What to tell a lawn org about whether its field workflow will actually work
// today. Pure: no clock, no I/O, no mutation.
//
// A lawn business runs in one of two modes, and the switch between them is
// silent, which is the problem this module exists to fix:
//
//   SOLO — no crew member has a login. The owner IS the field worker, and a
//          visit with nobody assigned automatically appears on their route.
//          Everything works with zero setup, which is why new orgs feel fine.
//   CREW — at least one crew member has a login. The owner becomes a dispatcher
//          and is redirected away from My Route, and a visit with nobody
//          assigned now appears on NOBODY's route.
//
// Hiring one person flips the first into the second with no error message. A
// live customer sat in exactly that state with 45 unassigned visits, an owner
// who could no longer open his own route, and no way to find out why. The
// database now emits a one-shot notice at the transition; this module is the
// other half — the live, always-current answer to "is today going to work".

export type FieldMode = "solo" | "crew";

export type ReadinessInput = {
  /** Crew members with a linked login. Members with no login do NOT count —
   *  nobody can sign in as them, so they cannot be the field worker. */
  crewMembersWithLogin: number;
  /** Today's pending visits. */
  visitsToday: number;
  /** Of those, how many have neither a crew nor a crew team assigned. */
  unassignedToday: number;
  /** Of those, how many have a map pin. */
  withPinToday: number;
  /** Of those, how many have a lot square footage on file. */
  withSqftToday: number;
};

export type IssueCode =
  | "unassigned_visits"
  | "missing_pins"
  | "missing_sqft"
  | "no_visits";

export type Severity = "blocking" | "warning" | "info";

export type ReadinessIssue = {
  code: IssueCode;
  severity: Severity;
  count: number;
};

export type Readiness = {
  mode: FieldMode;
  issues: ReadinessIssue[];
  /** Visits today the geofence can actually auto-stamp: they must reach
   *  somebody's route AND have a pin. */
  autoStampableToday: number;
};

/** A member with no login is a name on a roster, not a field worker — the same
 *  rule My Route and the geofence use, kept identical on purpose so the banner
 *  can never disagree with the behaviour it is describing. */
export function fieldMode(crewMembersWithLogin: number): FieldMode {
  return crewMembersWithLogin >= 1 ? "crew" : "solo";
}

/**
 * The severity of "unassigned visits" is the crux, and it inverts with mode:
 *
 *   SOLO — not an issue at all, and must not be reported as one. Unassigned IS
 *          the owner's route. Warning about it would train people to fix
 *          something that is working correctly.
 *   CREW — blocking. Those visits reach nobody, no route shows them, and the
 *          geofence never sees them. Same facts, opposite meaning.
 */
export function assessReadiness(input: ReadinessInput): Readiness {
  const mode = fieldMode(input.crewMembersWithLogin);
  const issues: ReadinessIssue[] = [];

  // Nothing scheduled is not a misconfiguration, and listing pin/sqft gaps
  // against a day with no work would be noise. Report it alone.
  if (input.visitsToday === 0) {
    return {
      mode,
      issues: [{ code: "no_visits", severity: "info", count: 0 }],
      autoStampableToday: 0,
    };
  }

  if (mode === "crew" && input.unassignedToday > 0) {
    issues.push({
      code: "unassigned_visits",
      severity: "blocking",
      count: input.unassignedToday,
    });
  }

  // A pinless visit is not broken — it falls back to the manual Start/Done
  // buttons. Warning, not blocking.
  const missingPins = input.visitsToday - input.withPinToday;
  if (missingPins > 0) {
    issues.push({ code: "missing_pins", severity: "warning", count: missingPins });
  }

  // Time is still recorded without a lot size; only the price-per-sqft figure
  // is unavailable. Informational, and never phrased as the crew's fault.
  const missingSqft = input.visitsToday - input.withSqftToday;
  if (missingSqft > 0) {
    issues.push({ code: "missing_sqft", severity: "info", count: missingSqft });
  }

  // In crew mode we know how many visits are pinned and how many are reachable,
  // but not which visits are BOTH. Rather than guess, report the count that
  // must overlap by pigeonhole — max(0, pinned + reachable - total), which
  // reduces to max(0, pinned - unassigned). Understating what will work is the
  // safe direction: the alternative is promising automation that silently
  // does not happen.
  const autoStampableToday =
    mode === "solo"
      ? input.withPinToday
      : Math.max(0, input.withPinToday - input.unassignedToday);

  return { mode, issues, autoStampableToday };
}

/** Anything that means today will not work until someone acts. */
export function hasBlocking(r: Readiness): boolean {
  return r.issues.some((issue) => issue.severity === "blocking");
}
