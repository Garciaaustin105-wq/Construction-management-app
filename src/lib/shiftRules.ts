// Time-clock rules for lawn shifts. Pure: the caller passes the time.
//
// Every limit here is ALSO enforced by the database (guard_time_entry_clock_in).
// This copy exists so the UI can disable a button and say why, instead of
// letting someone submit and be handed a Postgres error. The database is the
// rule; this is the explanation. If they ever disagree, the database wins — so
// change them together.
//
// All three rules come from problems observed in live data: the shortest shift
// on record is 18 seconds, one entry stayed open for a week, and a crew member
// who forgets to press Start currently has no way to record real hours.

/** Below this, ending a shift should OFFER to discard rather than record. */
export const TRIVIAL_SHIFT_MS = 300_000; // 5 minutes
/** Furthest back a crew member may set their own start time. */
export const MAX_BACKDATE_MS = 57_600_000; // 16 hours
/** So a slow tap is not treated as a future start. */
export const FUTURE_TOLERANCE_MS = 300_000; // 5 minutes

export type BackdateCheck =
  | { ok: true }
  | { ok: false; reason: "future" | "too_old"; message: string };

export type ShiftFlags = {
  backdated?: boolean;
  autoClosed?: boolean;
  crewSize?: number | null;
};

/**
 * Whether a shift is short enough that it was probably a mis-tap.
 *
 * The caller must OFFER to discard, never discard automatically. A genuinely
 * short visit is real — someone pops back to a property for ten minutes to
 * redo an edge — and silently deleting a crew member's recorded time because
 * an algorithm judged it too short is how a time clock loses trust. Ask.
 */
export function isTriviallyShort(durationMs: number): boolean {
  return durationMs < TRIVIAL_SHIFT_MS;
}

/**
 * Whether a self-reported start time is allowed at all.
 *
 * Backdating exists so a forgotten clock-in does not cost someone their hours.
 * The two limits keep it a correction rather than a blank cheque: nobody claims
 * tomorrow's hours today, and anything older than a working day is a real
 * timesheet correction the office should make deliberately.
 */
export function validateBackdate(startMs: number, nowMs: number): BackdateCheck {
  if (startMs > nowMs + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: "future", message: "A shift cannot start in the future" };
  }
  if (startMs < nowMs - MAX_BACKDATE_MS) {
    return {
      ok: false,
      reason: "too_old",
      message: "A shift cannot be backdated more than 16 hours — ask the office to add it",
    };
  }
  return { ok: true };
}

/**
 * Whether this start time counts as self-reported rather than measured.
 *
 * The man-hours figure the pricing model rests on is only meaningful if
 * measured time and typed-in time can be told apart, so this label has to
 * follow the entry all the way to whoever approves it.
 */
export function isBackdated(startMs: number, nowMs: number): boolean {
  return startMs < nowMs - 120_000;
}

/**
 * Short phrases for anything about a shift the office should see before
 * approving it. All three describe a REDUCED claim about the data, never a
 * judgement about the crew — "ended automatically" is a fact about the sweep,
 * not an accusation about the person.
 */
export function describeShiftFlags(flags: ShiftFlags): string[] {
  const out: string[] = [];
  if (flags.backdated) out.push("Start time entered by hand");
  if (flags.autoClosed) out.push("Ended automatically — the crew did not clock out");
  // == null catches both null and undefined: a missing crew size, not a zero.
  if (flags.crewSize == null) out.push("Crew size not recorded");
  return out;
}

/** Durations read on a phone in daylight, so short and unpunctuated. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
