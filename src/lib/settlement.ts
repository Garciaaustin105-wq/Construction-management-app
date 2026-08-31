// When "your yard is done" may be sent to a customer. Pure: the caller passes
// the time, so every rule is testable without a clock or a database.
//
// THIS MODULE DECIDES NOTHING. The database is authoritative — settleable_visits()
// applies the same gates and the cron acts on them. This mirrors those rules so
// the UI can say "settles in 12 minutes" or "waiting for office approval"
// without guessing. If the two ever disagree, the database is right.
//
// The gates, and why each exists:
//
//   1 + 2  The whole crew has left AND stayed gone. These collapse into ONE
//          check, which is the elegant part. on_site_last_at is a high-water
//          mark that ANY crew phone pushes forward while ANY of them is on the
//          property, so it stops advancing at the exact moment the last person
//          leaves. "now - on_site_last_at >= grace" therefore already means
//          "everyone left, and stayed gone" — no occupancy set, no per-phone
//          bookkeeping. Walking back for a trimmer, or eating lunch under a
//          tree on the lawn, pushes the mark forward and resets the clock with
//          no special-case code at all.
//
//   3      A minimum on-site duration. Without it, parking on the wrong street
//          for a phone call eventually tells a customer their untouched lawn is
//          finished — the worst output this system can produce.
//
//   4      Office approval, and it DEFAULTS ON. The difference between "the
//          software emailed my customer" and "I approved it" is the whole
//          reason an operator would trust the automation, and the first
//          real-world mistakes should be caught by a human rather than by a
//          homeowner.

export type CompletionMode = "auto" | "office_approval";

export type SettlementSettings = {
  /** Minutes the crew must have been gone. */
  graceMinutes?: number;
  /** Minimum minutes on site for the visit to count. */
  minOnSiteMinutes?: number;
  completionMode?: CompletionMode;
};

export const SETTLEMENT_DEFAULTS: Required<SettlementSettings> = {
  graceMinutes: 30,
  minOnSiteMinutes: 4,
  // The safe default, deliberately. This is the only path that emails a
  // customer, so a new org opts IN to automation rather than out of it.
  completionMode: "office_approval",
};

export type SettlementInput = {
  /** Epoch ms the crew first arrived, or null if never measured. */
  onSiteFirstAt: number | null;
  /** Epoch ms of the last observation, or null. */
  onSiteLastAt: number | null;
  /** Epoch ms "now". */
  now: number;
};

export type SettlementState =
  | "not_measured"
  | "on_site"
  | "too_short"
  | "ready"
  | "awaiting_approval";

export type Settlement = {
  state: SettlementState;
  /** Epoch ms the grace period elapses, or null when not applicable. */
  settlesAt: number | null;
  /** Ms until settlesAt; 0 once passed; null when not applicable. */
  msRemaining: number | null;
  /** Measured on-site duration in ms, or null. */
  onSiteMs: number | null;
};

/** Apply the gates in order. Order matters: a visit still inside its grace
 *  window is reported as "on_site" even if it would later fail the duration
 *  gate, because the crew may yet come back and make it long enough. */
export function assessSettlement(
  input: SettlementInput,
  settings?: SettlementSettings
): Settlement {
  const { graceMinutes, minOnSiteMinutes, completionMode } = {
    ...SETTLEMENT_DEFAULTS,
    ...settings,
  };

  if (input.onSiteFirstAt === null || input.onSiteLastAt === null) {
    return { state: "not_measured", settlesAt: null, msRemaining: null, onSiteMs: null };
  }

  // Clamped: an out-of-order write must not produce a negative duration.
  const onSiteMs = Math.max(0, input.onSiteLastAt - input.onSiteFirstAt);
  const settlesAt = input.onSiteLastAt + graceMinutes * 60_000;
  const msRemaining = Math.max(0, settlesAt - input.now);

  if (input.now < settlesAt) {
    return { state: "on_site", settlesAt, msRemaining, onSiteMs };
  }
  if (onSiteMs < minOnSiteMinutes * 60_000) {
    return { state: "too_short", settlesAt, msRemaining, onSiteMs };
  }
  return {
    state: completionMode === "auto" ? "ready" : "awaiting_approval",
    settlesAt,
    msRemaining,
    onSiteMs,
  };
}

/** Passed every gate. Whether that means SEND or QUEUE depends on the mode. */
export function isSettleable(s: Settlement): boolean {
  return s.state === "ready" || s.state === "awaiting_approval";
}

/** One short sentence for the UI. No trailing period — callers compose. */
export function describeSettlement(s: Settlement): string {
  switch (s.state) {
    case "not_measured":
      return "No on-site time recorded";
    case "on_site": {
      const mins = Math.ceil((s.msRemaining ?? 0) / 60_000);
      return `Settles in ${mins} ${mins === 1 ? "minute" : "minutes"}`;
    }
    case "too_short":
      return "On site too briefly to count";
    case "ready":
      return "Ready to send";
    case "awaiting_approval":
      return "Waiting for office approval";
  }
}
