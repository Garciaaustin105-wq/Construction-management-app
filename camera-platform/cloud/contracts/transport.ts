/**
 * Choosing the video path for one viewing session (CLOUD-SLICE4-SPEC.md,
 * "choosing the video path, local HTTPS names"). Pure: no fs, no clock, no
 * network -- the caller supplies every `Attempt` it already made and holds
 * the clock itself.
 *
 * Owner's rule, quoted: "always try to connect customer to nvr first," and
 * "use the cloud directly for video for last resort." The cloud does the
 * introduction; the video goes local, then direct peer-to-peer, and through
 * the cloud relay only as the last resort. Always show which path a session
 * got.
 *
 * See cloud/CLOUD-SLICE4-SPEC.md for the full contract
 * each one must satisfy, and cloud/harness/transport.harness.mjs for the
 * checks it must pass.
 */

/** The three ways a viewing session's video can travel. */
export type PathKind = "local" | "direct" | "relay";

/** One attempt to bring up video over one `PathKind`, exactly as the caller
 *  recorded it. `reason` is `null` only when `outcome === "connected"`; any
 *  other outcome should carry a reason string, but this contract does not
 *  enumerate or validate those strings -- it only ever reads `kind` and
 *  `outcome`. */
export interface Attempt {
  kind: PathKind;
  startedMs: number;
  endedMs: number;
  outcome: "connected" | "failed" | "timeout" | "not_tried";
  reason: string | null;
}

/** The fixed order attempts are tried in. Never reordered, and never
 *  filtered by anything other than "already attempted this session" --
 *  see `nextPath`. */
export const TRANSPORT_ORDER: readonly PathKind[] = Object.freeze(["local", "direct", "relay"]);

/** How long, in milliseconds, each path may run before it counts as a
 *  timeout rather than a failure. Advisory to this contract: `nextPath`
 *  itself never reads the clock, and does not compare `TRY_BUDGET_MS`
 *  against any `Attempt`'s timing -- that comparison, if any, is the
 *  caller's job, done before it records an attempt's `outcome` as
 *  `"timeout"`. This export exists so both the caller and the harness read
 *  the same numbers. */
export const TRY_BUDGET_MS: Readonly<Record<PathKind, number>> = Object.freeze({
  local: 1500,
  direct: 6000,
  relay: 8000,
});

/** Inputs `nextPath` needs beyond the attempts already made this session. */
export interface NextPathOptions {
  relayAllowed: boolean;
  lanHint: "same_lan" | "different_lan" | "unknown";
}

/** Why `nextPath` gave up instead of returning a path to try. */
export type GiveUpReason = "relay_not_allowed" | "all_paths_failed" | "already_connected";

/** `nextPath`'s result: either try one more path, or stop and say why. */
export type NextPathResult = { try: PathKind } | { give_up: true; reason: GiveUpReason };

/**
 * Decide which path a session should try next, given every attempt already
 * made this session. Pure and total; never throws.
 *
 * Contract:
 * - If any attempt in `attempts` has `outcome === "connected"`, return
 *   `{ give_up: true, reason: "already_connected" }` immediately -- a
 *   caller bug (asking for a next path after already connecting) made
 *   harmless rather than acted on.
 * - Otherwise walk `TRANSPORT_ORDER` in order and consider each `PathKind`
 *   in turn:
 *   - Skip `"local"` when `opts.lanHint === "different_lan"`. `"unknown"`
 *     and `"same_lan"` both try local first, i.e. do not skip it.
 *   - Skip `"relay"` when `opts.relayAllowed === false`.
 *   - Skip any `PathKind` that already has an attempt for it in `attempts`
 *     (any outcome other than `"connected"`, which was already handled
 *     above) -- a path already attempted this session is not retried.
 *   - The first `PathKind`, in `TRANSPORT_ORDER`, that is not skipped is
 *     returned as `{ try: PathKind }`.
 * - If every path in `TRANSPORT_ORDER` is skipped:
 *   - if `"relay"` was skipped specifically because `opts.relayAllowed` is
 *     `false` (i.e. relay was never attempted and is the reason nothing is
 *     left), return `{ give_up: true, reason: "relay_not_allowed" }`;
 *   - otherwise (every path was skipped because it was already attempted,
 *     or `"relay"` is itself allowed but was already attempted too),
 *     return `{ give_up: true, reason: "all_paths_failed" }`.
 */
export function nextPath(attempts: Attempt[], opts: NextPathOptions): NextPathResult {
  for (const attempt of attempts) {
    if (attempt.outcome === "connected") {
      return { give_up: true, reason: "already_connected" };
    }
  }
  const attempted = new Set<PathKind>();
  for (const attempt of attempts) {
    attempted.add(attempt.kind);
  }
  for (const kind of TRANSPORT_ORDER) {
    if (kind === "local" && opts.lanHint === "different_lan") continue;
    if (kind === "relay" && !opts.relayAllowed) continue;
    if (attempted.has(kind)) continue;
    return { try: kind };
  }
  if (!opts.relayAllowed && !attempted.has("relay")) {
    return { give_up: true, reason: "relay_not_allowed" };
  }
  return { give_up: true, reason: "all_paths_failed" };
}

/** What a viewing session ended up with, and how it got there -- what the
 *  app shows ("Connected: direct") and what the cost report counts. */
export interface SessionSummary {
  connectedVia: PathKind | null;
  triedInOrder: PathKind[];
  msToConnect: number | null;
  relayUsed: boolean;
}

/**
 * Summarize one session's attempts. Pure and total; never throws.
 *
 * Contract:
 * - `triedInOrder`: the `kind` of every attempt in `attempts`, in the same
 *   order `attempts` was given (this contract does not re-sort by
 *   `TRANSPORT_ORDER` or by time -- it reports what the caller recorded, in
 *   the order the caller recorded it).
 * - `connectedVia`: the `kind` of the attempt whose `outcome` is
 *   `"connected"`, or `null` when no attempt connected. At most one attempt
 *   is ever expected to have connected; if more than one somehow does, the
 *   first such attempt in `attempts` order wins.
 * - `relayUsed`: `true` exactly when `connectedVia === "relay"`.
 * - `msToConnect`: `null` when `connectedVia` is `null`. Otherwise, the
 *   connected attempt's `endedMs` minus the FIRST attempt in `attempts`'
 *   `startedMs` (index 0 of `attempts`, not the first attempt of any
 *   particular kind) -- the whole session's time-to-connect, including
 *   every path that was tried and failed before the one that worked.
 */
export function sessionSummary(attempts: Attempt[]): SessionSummary {
  const triedInOrder: PathKind[] = attempts.map((a) => a.kind);
  const connected = attempts.find((a) => a.outcome === "connected");
  const connectedVia: PathKind | null = connected === undefined ? null : connected.kind;
  let msToConnect: number | null = null;
  if (connected !== undefined) {
    const first = attempts[0];
    if (first !== undefined) {
      msToConnect = connected.endedMs - first.startedMs;
    }
  }
  return { connectedVia, triedInOrder, msToConnect, relayUsed: connectedVia === "relay" };
}

/** How often sessions ended up on the relay, across a batch of sessions. */
export interface RelayShare {
  sessions: number;
  relay: number;
  share: number | null;
}

/**
 * Roll up relay usage across many sessions' summaries. Pure and total;
 * never throws.
 *
 * Contract:
 * - `sessions`: `summaries.length`.
 * - `relay`: the count of summaries with `relayUsed === true`.
 * - `share`: `relay / sessions` when `sessions > 0`. `null` when
 *   `summaries` is empty -- never `0` for an empty batch, since "0 sessions,
 *   0 on relay" is not the same fact as "sessions ran and none used relay"
 *   (build rule 5: a blank is not a zero).
 */
export function relayShare(summaries: SessionSummary[]): RelayShare {
  const sessions = summaries.length;
  let relay = 0;
  for (const summary of summaries) {
    if (summary.relayUsed === true) {
      relay += 1;
    }
  }
  const share = sessions > 0 ? relay / sessions : null;
  return { sessions, relay, share };
}
