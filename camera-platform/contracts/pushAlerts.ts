/**
 * Manager rules, build 2: phone alerts (MANAGER-ALERTS-SPEC.md). Pure logic
 * only — no I/O, no clock of its own, no crypto. The pieces that touch a
 * file, a key or the network are agent/push-store.mjs (vapid.json and
 * push-subscriptions.json) and agent/web-push.mjs (the wire protocol,
 * generateVapidKeys/validateSubscription/encryptPayload/sendPush — reused
 * here only through TYPES, never re-implemented: see the `MAX_PLAINTEXT_BYTES
 * is a parameter, not an import` note below).
 *
 * This file answers exactly the four questions MANAGER-ALERTS-SPEC.md's own
 * "Delivery" section asks, and nothing else:
 *  1. who receives a firing (mayReceiveFiring) — build rule: an installer who
 *     never subscribed themselves gets nothing, and a subscription for an
 *     account that lost its permission, or was removed, gets nothing either;
 *  2. the payload (buildPushPayload) — title/body/url/at, refused whole
 *     rather than cut mid-character when it will not fit;
 *  3. the retry schedule (decideDelivery / RETRY_SCHEDULE_MS) — 1 min, 5 min,
 *     30 min, then failed;
 *  4. the 404/410 = gone rule (decideDelivery again — the same function,
 *     because "should this subscription be deleted" and "should this send be
 *     retried" are one decision made from one HTTP status, never two
 *     decisions that could disagree).
 *
 * Plus the pure list transforms agent/push-store.mjs's I/O layer needs to
 * keep push-subscriptions.json's own rules — "one row per account per
 * device", "deduplicate on endpoint", "an account sees and removes only its
 * own", "the installer sees counts per account, never endpoints" — as data
 * transforms it can unit-test without a filesystem, rather than re-deriving
 * that logic inline in the I/O file the way a one-off filter would.
 *
 * THE FEARED FAILURES, by name:
 * - a subscription outliving the account it belongs to (account deleted, or
 *   demoted to a role with neither rules.manage nor events.view) still
 *   getting pushed to — mayReceiveFiring re-checks the account's CURRENT
 *   permissions on every send, never trusts a permission the subscription
 *   itself might have cached from when it was created;
 * - a payload silently truncated at MAX_PLAINTEXT_BYTES instead of refused —
 *   a push notification cut mid-character (a split UTF-8 sequence) is not
 *   just ugly, it can fail to decode at all on the far end;
 * - a 400 or other odd status being treated as "the subscription is gone"
 *   (deleting it) or as "worth retrying forever" (retrying a status that
 *   will never change) — decideDelivery only ever deletes on 404/410 and
 *   only ever retries on 429 or 5xx, exactly the two cases
 *   MANAGER-ALERTS-SPEC.md names, everything else is `failed` at once;
 * - a `title/body` line built from a rule's raw fields instead of the
 *   firing's own already-identity-free `text` (contracts/managerRules.ts's
 *   ManagerRuleFiring) — this file never composes wording of its own, it
 *   only carries the firing's own text and name through unchanged.
 */

import type { Role } from "./access.js";
import { permissionsFor } from "./access.js";
import type { ManagerRuleFiring } from "./managerRules.js";

// ---------------------------------------------------------------- who receives a firing

/**
 * The account side of "who receives a firing" (MANAGER-ALERTS-SPEC.md
 * "Delivery" step 2): "For each subscription whose account may see that
 * rule (rules.manage or events.view) and whose selection includes the rule".
 *
 * `role: null` covers both "the account no longer exists" and "the account
 * is not a `user` at all" (a display cannot hold a push subscription in the
 * first place, but a caller re-deriving this from a stale record should
 * still get `false`, never a guess) — the caller (agent/push-store.mjs's I/O
 * layer, which actually reads the accounts file) is the one place that knows
 * the difference; this function only needs "does a role that still exists
 * carry the permission", so both collapse to the same input on purpose.
 */
export interface AccountStanding {
  role: Role | null;
}

/** "all" every rule this account's account-level permission reaches, or an
 *  explicit allow-list of rule ids — exactly push-subscriptions.json's own
 *  `rules` field (MANAGER-ALERTS-SPEC.md: `rules: "all" | [ruleId]`). */
export type SubscriptionRuleSelection = "all" | readonly string[];

/**
 * Whether a subscription in this standing, with this rule selection, may
 * receive a firing of `ruleId`. Checked fresh against the account's CURRENT
 * permissions every time — a subscription created while an account held
 * `manager` keeps working if that account is still a manager, and stops
 * working the moment it is not, without anyone touching the subscription
 * itself (build rule 22: check the assumption, not just the cached state).
 */
export function mayReceiveFiring(standing: AccountStanding, selection: SubscriptionRuleSelection, ruleId: string): boolean {
  if (standing.role === null) return false;
  const permissions = permissionsFor(standing.role);
  if (!permissions.includes("rules.manage") && !permissions.includes("events.view")) return false;
  if (selection === "all") return true;
  return selection.includes(ruleId);
}

// ---------------------------------------------------------------- the payload

export interface PushPayload {
  /** The rule's own name, snapshotted on the firing (build rule 7 — never
   *  re-read from a possibly-since-renamed rule). */
  title: string;
  /** The firing's own identity-free wording, unchanged. */
  body: string;
  /** Always the Review deep link for this firing's own camera and start —
   *  see reviewLinkFor's own comment for why this file never falls back to
   *  "/reports?day=": a stored firing always has both fields. */
  url: string;
  /** ISO instant: when the firing ended (or, for one still open, started —
   *  see buildPushPayload's own comment), for the notification's own display. */
  at: string;
}

export type PushPayloadCheck =
  | { ok: true; payload: PushPayload; bytes: number }
  | { ok: false; reason: string; bytes: number };

/**
 * The Review deep link for one firing — REVIEW-UI-SPEC.md / MANAGER-RULES-
 * SPEC.md section 5's own "/review?camera=&at=", built byte-for-byte the way
 * agent/ui/reports-client.mjs's own `reviewLinkFor` already builds it for the
 * Reports page, so a phone alert and that page's own link for the SAME
 * firing are identical: both key it to the firing's own `startMs` (when it
 * BEGAN, the moment worth looking at), never `endMs`.
 *
 * Built by hand with `encodeURIComponent`, not `URLSearchParams` — this file
 * is compiled with `lib: ["ES2022"]` only (no `dom`), so `URLSearchParams`
 * has no type here at all (confirmed the same way contracts/deviceCheckin.ts's
 * own header comment confirms `Buffer` has none). For the two inputs this
 * function ever sees — a camera id (contracts/apiQuery.ts's own
 * `CAMERA_ID_PATTERN`: letters, digits, `-`/`_` only) and an ISO timestamp
 * (digits, `-`, `:`, `.`, `T`, `Z` only) — `encodeURIComponent` and
 * `URLSearchParams`'s own encoding agree on every character in that set (the
 * one place they could differ, a literal space becoming `%20` vs `+`, never
 * occurs in either input), so the two builders stay byte-identical without
 * sharing code across the .mjs/.ts boundary.
 *
 * MANAGER-ALERTS-SPEC.md's own "Delivery" wording also mentions
 * "/reports?day=..." as an alternative — that is the OTHER place a firing's
 * time is linked from (the Reports page's own day view), not a second choice
 * this function has to make: a stored firing (rules.db's own NOT NULL
 * columns) always has a `cameraId` and a `startMs`, so the Review deep link
 * is always buildable and is always the more specific, more useful tap
 * target for a notification that exists to say "look at this camera, now" —
 * refusing to guess a fallback path that never has to be taken.
 */
export function reviewLinkFor(cameraId: string, startMs: number): string {
  const at = new Date(startMs).toISOString();
  return `/review?camera=${encodeURIComponent(cameraId)}&at=${encodeURIComponent(at)}`;
}

/**
 * The exact byte count `JSON.stringify(payload)` would take as UTF-8 —
 * without `Buffer` or `TextEncoder`, neither of which this file can name
 * (see reviewLinkFor's own comment on why `dom`/`node` types are absent).
 * Counts by Unicode code point (`for...of` over a string yields code points,
 * combining a surrogate pair into one), applying RFC 3629's own byte-length
 * rule per code point — the identical count `Buffer.byteLength(s, "utf8")`
 * would produce, checked against it in the harness.
 */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const codePoint = ch.codePointAt(0) as number;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * The push payload for one firing, or a refusal — never a truncated payload.
 *
 * `maxPlaintextBytes` is a PARAMETER, not an import of agent/web-push.mjs's
 * own `MAX_PLAINTEXT_BYTES`: this file is compiled from contracts/ alone
 * (tsconfig's own `rootDir`), and agent/web-push.mjs is untyped runtime
 * crypto code this brief says to reuse, never rewrite — so the one number
 * both files need to agree on travels as a value the CALLER (which already
 * has both modules loaded) passes in, the same way checkCameraAiSettings
 * takes the site's storing floor as a parameter rather than importing
 * detect-service.mjs to re-derive it.
 *
 * `firing.endMs` is used for `at` when the firing is complete; an incomplete
 * `away_and_back` (cut short by not_watching, `endMs: null`) falls back to
 * `startMs` — a display timestamp for the notification, not a claim about
 * when anything ended, so falling back here is not the guessed-return the
 * spec forbids in the FIRING's own `endMs` column (that column stays
 * genuinely null; only this unrelated display field needs *a* timestamp).
 */
export function buildPushPayload(
  firing: Pick<ManagerRuleFiring, "ruleName" | "cameraId" | "startMs" | "endMs" | "text">,
  maxPlaintextBytes: number,
): PushPayloadCheck {
  if (!Number.isInteger(maxPlaintextBytes) || maxPlaintextBytes <= 0) {
    throw new TypeError("maxPlaintextBytes must be a positive integer (agent/web-push.mjs's own MAX_PLAINTEXT_BYTES)");
  }
  const payload: PushPayload = {
    title: firing.ruleName,
    body: firing.text,
    url: reviewLinkFor(firing.cameraId, firing.startMs),
    at: new Date(firing.endMs ?? firing.startMs).toISOString(),
  };
  const json = JSON.stringify(payload);
  const bytes = utf8ByteLength(json);
  if (bytes > maxPlaintextBytes) {
    return {
      ok: false,
      bytes,
      reason: `push payload of ${bytes} bytes exceeds the ${maxPlaintextBytes}-byte plaintext budget (agent/web-push.mjs's MAX_PLAINTEXT_BYTES) — refused whole, never cut mid-character`,
    };
  }
  return { ok: true, payload, bytes };
}

// ---------------------------------------------------------------- retry schedule and the gone rule

/** 1 minute, 5 minutes, 30 minutes (MANAGER-ALERTS-SPEC.md: "429 or 5xx is
 *  retried with backoff (1 min, 5 min, 30 min), then given up"). The Nth
 *  retry (0-indexed: the delay before the FIRST retry, after the first
 *  failure) uses `RETRY_SCHEDULE_MS[N]`; once every entry has been used, the
 *  send is `failed`. */
export const RETRY_SCHEDULE_MS: readonly number[] = Object.freeze([60_000, 300_000, 1_800_000]);

export type DeliveryDecision =
  | { kind: "sent" }
  /** 404/410: the push service no longer has this subscription. */
  | { kind: "delete" }
  | { kind: "retry"; delayMs: number; attempt: number }
  | { kind: "failed" };

/**
 * What to do after one send attempt, from the HTTP status alone (agent/web-
 * push.mjs's own `sendPush` already turns the response into this same status
 * plus an `outcome` label; this function works from the status directly
 * rather than that label, so it never has to trust a THIRD place's reading of
 * the same response).
 *
 * `attempt`: how many retries have already happened for this (firing,
 * subscription) pair — 0 on the very first failure. Every status this
 * function does not name (2xx other than 201/202, any other 4xx including
 * 413 "too large", any 3xx) is `failed` at once, never retried and never
 * treated as gone — MANAGER-ALERTS-SPEC.md names exactly 404/410 and
 * 429/5xx; refusing to guess a THIRD behaviour for a status it does not name
 * (build rule 10) is deliberate: retrying a 413 forever would never succeed
 * (the payload itself is the problem, not the moment), and deleting a
 * subscription over a 400 the push service should never send would be
 * treating a bug in this codebase's OWN request as the browser's fault.
 */
export function decideDelivery(status: number, attempt: number): DeliveryDecision {
  if (!Number.isInteger(status)) {
    throw new TypeError("status must be an integer HTTP status code");
  }
  if (status === 201 || status === 202) return { kind: "sent" };
  if (status === 404 || status === 410) return { kind: "delete" };
  if (status === 429 || (status >= 500 && status <= 599)) {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new TypeError("attempt must be a non-negative integer");
    }
    if (attempt >= RETRY_SCHEDULE_MS.length) return { kind: "failed" };
    return { kind: "retry", delayMs: RETRY_SCHEDULE_MS[attempt] as number, attempt: attempt + 1 };
  }
  return { kind: "failed" };
}

// ---------------------------------------------------------------- push-subscriptions.json row shape

/** A subscription-selected label ("iPhone Safari") — matches
 *  siteSettings.ts's own `checkDisplayName` shape (a trimmed string of at
 *  most this many characters, no control characters, blank becomes null) —
 *  the same kind of field, a different owner, so the same rule. */
export const MAX_LABEL_LENGTH = 60;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** One row of push-subscriptions.json (MANAGER-ALERTS-SPEC.md: "one row per
 *  account per device"). `endpoint`/`p256dh`/`auth` are validated for their
 *  CRYPTOGRAPHIC shape by agent/web-push.mjs's own `validateSubscription`
 *  (decoded lengths, the `https:` scheme, the uncompressed-point marker) —
 *  this file only checks that they are present, non-empty strings, the same
 *  split contracts/cameraAiSettings.ts keeps from agent/camera-ai-settings.mjs
 *  reading a camera's own OTHER settings. */
export interface StoredPushSubscription {
  id: string;
  username: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdUtc: string;
  label: string | null;
  rules: SubscriptionRuleSelection;
}

export interface FieldProblem {
  field: string;
  reason: string;
}

export type PushSubscriptionRowCheck =
  | { ok: true; row: StoredPushSubscription }
  | { ok: false; errors: FieldProblem[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function checkLabel(raw: unknown, errors: FieldProblem[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || CONTROL.test(raw) || raw.length > MAX_LABEL_LENGTH) {
    errors.push({ field: "label", reason: "bad_label" });
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function checkRuleSelection(raw: unknown, errors: FieldProblem[]): SubscriptionRuleSelection {
  if (raw === "all") return "all";
  if (Array.isArray(raw) && raw.length > 0 && raw.every((v) => nonEmptyString(v))) {
    // De-duplicated, order-preserving: a repeated ruleId in a hand-edited or
    // replayed body is not a second reason to notify, and dedup here means
    // the store never has to do it again on every read.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw as string[]) {
      if (!seen.has(v)) { seen.add(v); out.push(v); }
    }
    return Object.freeze(out);
  }
  errors.push({ field: "rules", reason: "bad_rule_selection" });
  return "all";
}

/**
 * Validates one stored row's shape (never its cryptographic fields — see
 * this interface's own doc comment). Every problem at once, never the first
 * alone (the same discipline every other `checkX` in this codebase keeps).
 */
export function checkPushSubscriptionRow(raw: unknown): PushSubscriptionRowCheck {
  if (!isRecord(raw)) return { ok: false, errors: [{ field: "row", reason: "not_an_object" }] };
  const errors: FieldProblem[] = [];
  if (!nonEmptyString(raw.id)) errors.push({ field: "id", reason: "missing_id" });
  if (!nonEmptyString(raw.username)) errors.push({ field: "username", reason: "missing_username" });
  if (!nonEmptyString(raw.endpoint)) errors.push({ field: "endpoint", reason: "missing_endpoint" });
  if (!nonEmptyString(raw.p256dh)) errors.push({ field: "p256dh", reason: "missing_p256dh" });
  if (!nonEmptyString(raw.auth)) errors.push({ field: "auth", reason: "missing_auth" });
  if (typeof raw.createdUtc !== "string" || Number.isNaN(Date.parse(raw.createdUtc))) {
    errors.push({ field: "createdUtc", reason: "bad_time" });
  }
  const label = checkLabel(raw.label, errors);
  const rules = checkRuleSelection(raw.rules, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    row: {
      id: raw.id as string,
      username: raw.username as string,
      endpoint: raw.endpoint as string,
      p256dh: raw.p256dh as string,
      auth: raw.auth as string,
      createdUtc: raw.createdUtc as string,
      label,
      rules,
    },
  };
}

// ---------------------------------------------------------------- list transforms (pure I/O-adjacent helpers)

/**
 * `rows` with any existing row for the SAME endpoint removed, then `row`
 * appended — "Deduplicate on endpoint" (MANAGER-ALERTS-SPEC.md): a browser
 * that subscribes again (a new registration replacing an old one, or the
 * same browser now signed in as a different account) gets exactly one row
 * for that endpoint, never two receiving the same notification twice.
 */
export function upsertByEndpoint(
  rows: readonly StoredPushSubscription[],
  row: StoredPushSubscription,
): StoredPushSubscription[] {
  return [...rows.filter((r) => r.endpoint !== row.endpoint), row];
}

/** Every row belonging to `username` — "an account sees ... only its own." */
export function subscriptionsForAccount(rows: readonly StoredPushSubscription[], username: string): StoredPushSubscription[] {
  return rows.filter((r) => r.username === username);
}

/** `rows` with the one row matching BOTH `username` and `id` removed —
 *  "removes ... only its own": a row that exists but belongs to a DIFFERENT
 *  account is left untouched, not removed and not reported as removed —
 *  this function's own return is compared by length, not a boolean, so the
 *  caller can tell "removed" from "no such row of mine" itself. */
export function removeOwnSubscription(
  rows: readonly StoredPushSubscription[],
  username: string,
  id: string,
): StoredPushSubscription[] {
  return rows.filter((r) => !(r.username === username && r.id === id));
}

/** One count per account, in no particular account's favour — "the installer
 *  can see a count per account, but never the endpoints": this function
 *  never receives or returns an endpoint, so it structurally cannot leak one
 *  even if a caller passed its result straight to a response. */
export function subscriptionCountsByAccount(rows: readonly StoredPushSubscription[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.username] = (out[r.username] ?? 0) + 1;
  return out;
}
