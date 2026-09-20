/**
 * Validating what a client sends to /events: kinds filter and limit.
 *
 * THE FEARED FAILURES:
 * - a kind the server does not recognise silently answered as "nothing found"
 *   for footage that has a person in it;
 * - a limit that lets one request read the whole table without knowing the
 *   rest exist.
 */

import { EVENT_KINDS, type EventKind } from "./detection.js";
import { type ApiRefusal } from "./apiQuery.js";

export const EVENT_LIMIT_DEFAULT = 500;
export const EVENT_LIMIT_MAX = 5000;

/**
 * Parse an event kind filter from a client.
 *
 * 1. If `raw` is null, undefined, or blank/whitespace-only, return a fresh
 *    copy of EVENT_KINDS in its canonical order.
 * 2. Otherwise parse as a comma-separated list: split by comma, trim each part.
 * 3. De-duplicate and keep only the kinds that exist in EVENT_KINDS, returned
 *    in EVENT_KINDS order.
 * 4. If any item is empty, an unknown kind, or the wrong case, refuse with
 *    status 400, code "bad_kind", and message listing what kinds ARE allowed.
 * 5. Never silently ignore a kind you do not know: that would answer "no
 *    person found" for footage that has a person in it.
 */
export function parseEventKinds(raw: unknown): EventKind[] | ApiRefusal {
  if (raw === null || raw === undefined) {
    return [...EVENT_KINDS];
  }
  if (typeof raw !== "string") {
    return refuse(400, "bad_kind", `kinds must be a string, not a ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [...EVENT_KINDS];
  }
  const parts = raw.split(",");
  const seen = new Set<string>();
  const kindSet = new Set(EVENT_KINDS);

  for (const part of parts) {
    const kind = part.trim();
    if (kind === "") {
      const allowed = [...EVENT_KINDS].join(", ");
      return refuse(400, "bad_kind", `kinds list has an empty item; allowed: ${allowed}`);
    }
    if (!kindSet.has(kind as EventKind)) {
      const allowed = [...EVENT_KINDS].join(", ");
      return refuse(400, "bad_kind", `unknown kind: ${JSON.stringify(kind)}; allowed: ${allowed}`);
    }
    seen.add(kind);
  }

  // Return in EVENT_KINDS order, de-duplicated
  return EVENT_KINDS.filter((k) => seen.has(k));
}

/**
 * Parse an event limit from a client.
 *
 * 1. If `raw` is null, undefined, or blank, return EVENT_LIMIT_DEFAULT.
 * 2. Otherwise the string must be plain digits only: no sign, decimal point,
 *    exponent, or leading/trailing space.
 * 3. The value must be at least 1 and at most EVENT_LIMIT_MAX.
 * 4. Anything else is refused with status 400 and code "bad_limit".
 * 5. A limit that lets one request read the whole table without knowing the
 *    rest exist is the feared failure: cap at EVENT_LIMIT_MAX.
 */
export function parseEventLimit(raw: unknown): number | ApiRefusal {
  if (raw === null || raw === undefined) {
    return EVENT_LIMIT_DEFAULT;
  }
  if (typeof raw !== "string") {
    return refuse(400, "bad_limit", `limit must be a string, not a ${typeof raw}`);
  }
  if (raw === "") {
    return EVENT_LIMIT_DEFAULT;
  }
  if (!/^\d+$/.test(raw)) {
    return refuse(400, "bad_limit", `limit must be digits only, got ${JSON.stringify(raw)}`);
  }
  const num = Number(raw);
  if (num < 1 || num > EVENT_LIMIT_MAX) {
    return refuse(400, "bad_limit", `limit must be between 1 and ${EVENT_LIMIT_MAX}, got ${num}`);
  }
  return num;
}

function refuse(
  status: 400 | 422,
  code: "bad_kind" | "bad_limit",
  message: string,
): ApiRefusal {
  return { ok: false, status, code, message };
}
