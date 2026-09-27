/**
 * The cloud-side "who viewed what" log (CLOUD-B1-SPEC.md section 3;
 * cloud/CLOUD-SLICE5-SPEC.md). Pure: no fs, no clock, no network -- the
 * caller holds every `AccessEntry` and supplies any window it wants
 * summarized.
 *
 * Every entry here is defence in depth against a credential ever leaking
 * into a log a customer, an installer or a support agent might read:
 * `checkAccessEntry` refuses anything that even LOOKS like a secret, and
 * `redactForInstaller` narrows what an installer sees before it ever
 * reaches them.
 *
 * See cloud/CLOUD-SLICE5-SPEC.md for the full contract
 * each one must satisfy, and cloud/harness/accessLog.harness.mjs for the
 * checks it must pass.
 */

/** The seven things this log records someone doing. `"live_view"`,
 *  `"playback"`, `"export"` and `"snapshot"` are VIDEO actions -- they
 *  always carry a `transport`. `"settings_change"`, `"claim"` and
 *  `"login"` are not -- they never do. */
export type AccessAction =
  | "live_view"
  | "playback"
  | "export"
  | "snapshot"
  | "settings_change"
  | "claim"
  | "login";

/** How the video for a video action actually reached the viewer. Only
 *  meaningful for the four video actions -- see `AccessAction`. */
export type AccessTransport = "local" | "direct" | "relay";

/** One access-log entry, exactly as stored. */
export interface AccessEntry {
  /** When the access happened, epoch ms. */
  atMs: number;
  /** Who did it. */
  userId: string;
  /** The role they held at the time (owner's role vocabulary; this
   *  contract only checks that it is a non-empty string, it does not
   *  itself enumerate the roles -- that is contracts/scope.ts's job). */
  role: string;
  action: AccessAction;
  siteId: string;
  /** Which camera, when the action names one. `null` for a
   *  site-wide or camera-less action (and, after `redactForInstaller`,
   *  also `null` when the camera was privacy-blocked from that viewer). */
  cameraId: string | null;
  /** How the video reached the viewer, for a video action. Always `null`
   *  for a non-video action -- see `AccessAction`. */
  transport: AccessTransport | null;
  /** Whether the access attempt succeeded. */
  ok: boolean;
  /** Why it did not, or any other note. `null` when there is none. */
  reason: string | null;
}

/** Every problem `checkAccessEntry` can report, in the fixed order the
 *  array lists them when several apply. */
export type CheckAccessEntryReason =
  | "bad_time"
  | "bad_user"
  | "bad_action"
  | "bad_site"
  | "bad_transport"
  | "secret_like";

/**
 * List every structural problem with an access-log entry. Pure and total;
 * never throws (a malformed entry is a value to report, not a crash --
 * build rule 10). Reports EVERY problem that applies, not just the first
 * (build rule 11), except where noted below.
 *
 * Contract, and the fixed order problems are reported in:
 * - `"bad_time"`: `atMs` is not a finite integer.
 * - `"bad_user"`: `userId` is not a non-empty string, or `role` is not a
 *   non-empty string.
 * - `"bad_action"`: `action` is not one of the seven `AccessAction`
 *   values.
 * - `"bad_site"`: `siteId` is not a non-empty string.
 * - `"bad_transport"`: `action` is one of the four video actions
 *   (`"live_view"`, `"playback"`, `"export"`, `"snapshot"`) and
 *   `transport` is `null`; OR `action` is one of the three non-video
 *   actions (`"settings_change"`, `"claim"`, `"login"`) and `transport`
 *   is NOT `null`. This check is skipped entirely when `"bad_action"` was
 *   already reported -- with no valid action to classify as video or not,
 *   a transport check would only manufacture a second, meaningless
 *   problem on top of `"bad_action"`.
 * - `"secret_like"`: at least one string-valued field on the entry
 *   (`userId`, `role`, `siteId`, `cameraId`, `reason` -- every field whose
 *   declared type includes `string`) contains any of:
 *   - the substring `"rtsp://"`;
 *   - an `"@"` inside a URL-like string (a string that also contains
 *     `"://"`);
 *   - the substring `"password="`;
 *   - a run of 40 or more consecutive base64-alphabet characters
 *     (`[A-Za-z0-9+/]`).
 *   This is checked independently of every other reason, and independently
 *   per field -- one hit anywhere is enough to report `"secret_like"`
 *   once.
 * - Problems are independent of each other (aside from the one skip noted
 *   above): an entry can report several at once, always in this fixed
 *   order: `"bad_time"`, `"bad_user"`, `"bad_action"`, `"bad_site"`,
 *   `"bad_transport"`, `"secret_like"`. An empty array means no problem
 *   was found.
 */
export function checkAccessEntry(raw: AccessEntry): CheckAccessEntryReason[] {
  const reasons: CheckAccessEntryReason[] = [];

  const isNonEmptyString = (value: unknown): boolean =>
    typeof value === "string" && value.length > 0;

  // "bad_time": atMs must be a finite integer (Number.isInteger rejects
  // NaN, +/-Infinity, non-integers and non-numbers alike).
  if (!Number.isInteger(raw.atMs)) {
    reasons.push("bad_time");
  }

  // "bad_user": userId and role must each be a non-empty string.
  if (!isNonEmptyString(raw.userId) || !isNonEmptyString(raw.role)) {
    reasons.push("bad_user");
  }

  // "bad_action": action must be one of the seven AccessAction values.
  const videoActions: readonly AccessAction[] = [
    "live_view",
    "playback",
    "export",
    "snapshot",
  ];
  const allActions: readonly AccessAction[] = [
    ...videoActions,
    "settings_change",
    "claim",
    "login",
  ];
  const actionKnown = allActions.includes(raw.action);
  if (!actionKnown) {
    reasons.push("bad_action");
  }

  // "bad_site": siteId must be a non-empty string.
  if (!isNonEmptyString(raw.siteId)) {
    reasons.push("bad_site");
  }

  // "bad_transport": a video action must carry a transport, a non-video
  // action must not. Skipped entirely when the action itself was invalid
  // -- with no valid action there is nothing to classify as video or not.
  if (actionKnown) {
    const isVideoAction = videoActions.includes(raw.action);
    const transportWrong = isVideoAction
      ? raw.transport === null
      : raw.transport !== null;
    if (transportWrong) {
      reasons.push("bad_transport");
    }
  }

  // "secret_like": any string-valued field carrying an rtsp URL, a
  // password= fragment, an "@" inside a URL-like string (one that also
  // contains "://"), or a run of 40+ base64-alphabet characters.
  const isSecretLike = (value: unknown): boolean => {
    if (typeof value !== "string") {
      return false;
    }
    return (
      value.includes("rtsp://") ||
      value.includes("password=") ||
      (value.includes("@") && value.includes("://")) ||
      /[A-Za-z0-9+\/]{40}/.test(value)
    );
  };
  if (
    isSecretLike(raw.userId) ||
    isSecretLike(raw.role) ||
    isSecretLike(raw.siteId) ||
    isSecretLike(raw.cameraId) ||
    isSecretLike(raw.reason)
  ) {
    reasons.push("secret_like");
  }

  return reasons;
}

/**
 * Narrow an entry for an installer viewer when the client has privacy-
 * blocked that installer (slice 2). Pure and total; never throws. Always
 * returns a NEW object -- it never mutates `entry`.
 *
 * Contract:
 * - When `privacyBlocked` is `false`, return a shallow copy of `entry`,
 *   unchanged field-for-field.
 * - When `privacyBlocked` is `true` and `entry.action` is one of the four
 *   video actions, return a copy with `cameraId: null` -- the installer
 *   still sees THAT the access happened (action, transport, ok, reason,
 *   siteId, atMs, userId, role all pass through unchanged), just never
 *   WHICH camera.
 * - When `privacyBlocked` is `true` but `entry.action` is not a video
 *   action, return a shallow copy unchanged -- there is no camera identity
 *   to redact from a non-video action in the first place.
 */
export function redactForInstaller(entry: AccessEntry, privacyBlocked: boolean): AccessEntry {
  const videoActions: readonly AccessAction[] = ["live_view", "playback", "export", "snapshot"];
  if (!privacyBlocked || !videoActions.includes(entry.action)) {
    return { ...entry };
  }
  return { ...entry, cameraId: null };
}

/** Rolled-up counts over a window of entries. */
export interface AccessSummary {
  /** How many entries fell inside the window, of any action. */
  total: number;
  /** Count per action, for all seven `AccessAction` values -- every key is
   *  present, `0` when an action never occurred in the window (a blank is
   *  not a zero, but here the zero itself is the honestly-computed
   *  answer, so every key is always populated rather than omitted). */
  byAction: Record<AccessAction, number>;
  /** Count per transport, over VIDEO actions only, plus `"none"` for
   *  every entry that carries no transport (every non-video action). */
  byTransport: { local: number; direct: number; relay: number; none: number };
  /** `relay / (local + direct + relay)`, i.e. the relay share among video
   *  actions only (the `"none"` bucket never enters this ratio). `null`
   *  when the window contains no video actions at all -- never `0`, which
   *  would falsely claim "zero relay use" when there was no video access
   *  to measure in the first place. */
  relayShare: number | null;
}

/**
 * Summarize every entry whose `atMs` falls in `[fromMs, toMs)` -- a
 * half-open window, so an entry at exactly `toMs` is excluded and belongs
 * to the next window, never counted twice across adjacent windows. Pure
 * and total; never throws.
 *
 * Contract:
 * - `total` is the count of entries with `fromMs <= atMs < toMs`.
 * - `byAction` counts those same in-window entries by `action`, with all
 *   seven `AccessAction` keys present (`0` where an action did not occur).
 * - `byTransport` counts those same in-window entries: a video action
 *   bucketed by its `transport` (`"local"`, `"direct"` or `"relay"`); a
 *   non-video action (`transport === null`) bucketed as `"none"`.
 * - `relayShare` is `relay / (local + direct + relay)` over the
 *   `byTransport` counts just computed; `null` when
 *   `local + direct + relay === 0` (no video actions in the window).
 */
export function summarize(entries: AccessEntry[], fromMs: number, toMs: number): AccessSummary {
  const byAction: Record<AccessAction, number> = {
    live_view: 0,
    playback: 0,
    export: 0,
    snapshot: 0,
    settings_change: 0,
    claim: 0,
    login: 0,
  };
  const byTransport = { local: 0, direct: 0, relay: 0, none: 0 };
  let total = 0;
  for (const e of entries) {
    if (e.atMs >= fromMs && e.atMs < toMs) {
      total += 1;
      byAction[e.action] += 1;
      if (e.transport === null) {
        byTransport.none += 1;
      } else {
        byTransport[e.transport] += 1;
      }
    }
  }
  const videoCount = byTransport.local + byTransport.direct + byTransport.relay;
  const relayShare = videoCount === 0 ? null : byTransport.relay / videoCount;
  return { total, byAction, byTransport, relayShare };
}
