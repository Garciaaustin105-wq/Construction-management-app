/**
 * Validating what a client sends the local API: instants, windows, ids.
 *
 * Every one of these arrives as a string from a query or a path, typed by a
 * person with curl or built by a client we did not write. The failure feared is
 * not a crash — it is a plausible answer to a question nobody asked:
 *
 * - `2026-09-10T12:00:00` with no offset. `Date.parse` reads that as LOCAL time,
 *   so the same request returns a different hour depending on the appliance's
 *   timezone. Refused: an instant must say Z or ±hh:mm.
 * - `2026-02-30T00:00:00Z`. `Date.parse` rolls it over to 2 March and answers.
 *   Refused: a date that does not exist is a typo, not a request.
 * - `...T12:00:00+02:00` in a query string, where `+` decodes as a space. The
 *   refusal says so, because nobody guesses that from "bad instant".
 * - A window partly in the future is answered up to now, and says it was clipped.
 *   A window wholly in the future is refused — there is nothing to answer.
 *
 * Refusals are returned, not thrown: each carries the HTTP status and a stable
 * code the transport maps one-to-one, so no status is chosen in two places.
 */

import { SECONDS_PER_DAY, parseUtc, toUtc, type UtcRange } from "./time.js";

/** Buckets in a review timeline when the client does not say. About a phone's width. */
export const DEFAULT_BUCKETS = 240;

/**
 * The longest window one request may ask for, measured on the window as
 * requested (before clipping to now). A little over the 30-day retention target,
 * so "the whole of retention" is always one request and "a year" never is.
 */
export const MAX_WINDOW_SECONDS = 35 * SECONDS_PER_DAY;

/** Camera ids as the config assigns them. Narrow on purpose: they reach file paths. */
export const CAMERA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ApiRefusalCode =
  | "missing_parameter"
  | "bad_instant"
  | "inverted_window"
  | "window_too_large"
  | "window_in_future"
  | "bad_buckets"
  | "bad_camera_id"
  | "bad_segment_id";

export interface ApiRefusal {
  ok: false;
  /** 400 for a malformed request; 422 for a well-formed one that cannot be answered. */
  status: 400 | 422;
  code: ApiRefusalCode;
  /** For a person reading curl output. Never echoes more than the offending parameter. */
  message: string;
}

export interface ParsedInstant {
  ok: true;
  ms: number;
  /** Normalised: `toUtc(ms)`, always Z and milliseconds. */
  utc: string;
}

/**
 * Parse one instant from a client.
 *
 * Accepts exactly `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by `Z` or `±HH:MM`.
 * Upper-case T and Z only. The fraction may have 1..9 digits and is truncated
 * (not rounded) to milliseconds. Hours 00..23, minutes and seconds 00..59, offset
 * hours 00..14 and offset minutes 00..59. The calendar date must exist.
 *
 * Every refusal is status 400, code `bad_instant`, except `null`, `undefined` or
 * blank, which is `missing_parameter`. When the input ends in ` HH:MM` (a space
 * where the `+` was), the message must mention `%2B`.
 */
export function parseInstant(raw: string | null | undefined, name = "instant"): ParsedInstant | ApiRefusal {
  const value: unknown = raw;
  if (value === null || value === undefined || value === "") {
    return refuse(400, "missing_parameter", `${name} is required`);
  }
  if (typeof value !== "string") {
    return refuse(400, "bad_instant", `${name} must be a string, not a ${typeof value}`);
  }
  const m = INSTANT_PATTERN.exec(value);
  if (m === null) {
    // A '+' in an unencoded query string arrives as a space, so a correct
    // instant shows up here as "...T14:00:00 02:00". Nobody guesses that from
    // "bad instant", so the refusal says which character to write instead.
    if (SPACE_OFFSET_PATTERN.test(value)) {
      return refuse(400, "bad_instant",
        `${name} has a space where its offset sign was: a '+' in a query string must be written %2B`);
    }
    return refuse(400, "bad_instant",
      `${name} must be YYYY-MM-DDTHH:MM[:SS[.fraction]] with Z or +HH:MM, got ${JSON.stringify(value)}`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zoneText] = m;
  if (yearText === undefined || monthText === undefined || dayText === undefined
    || hourText === undefined || minuteText === undefined || zoneText === undefined) {
    return refuse(400, "bad_instant", `${name} is not a complete instant`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return refuse(400, "bad_instant",
      `${name} names a date that does not exist: ${yearText}-${monthText}-${dayText}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return refuse(400, "bad_instant", `${name} has a clock field out of range: ${hourText}:${minuteText}`);
  }
  // Truncated, never rounded: .9999 is 999 ms, not the next second.
  const millisecond = fractionText === undefined ? 0 : Number(`${fractionText}00`.slice(0, 3));
  let offsetMs = 0;
  if (zoneText !== "Z") {
    const offsetHour = Number(zoneText.slice(1, 3));
    const offsetMinute = Number(zoneText.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59) {
      return refuse(400, "bad_instant", `${name} has an offset that does not exist: ${zoneText}`);
    }
    offsetMs = (offsetHour * 60 + offsetMinute) * 60_000 * (zoneText.startsWith("-") ? -1 : 1);
  }
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0..99 as 1900..1999.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, millisecond);
  const ms = at.getTime() - offsetMs;
  return { ok: true, ms, utc: toUtc(ms) };
}

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** The shape a '+' offset takes when a query string was not encoded. */
const SPACE_OFFSET_PATTERN = /\d \d{2}:\d{2}$/;

function refuse(status: 400 | 422, code: ApiRefusalCode, message: string): ApiRefusal {
  return { ok: false, status, code, message };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export interface WindowQuery {
  start?: string | null;
  end?: string | null;
  buckets?: string | null;
}

export interface ParsedWindow {
  ok: true;
  /** As asked for, normalised to Z. */
  requested: UtcRange;
  /** What will be answered: `requested` with its end pulled back to now if needed. */
  effective: UtcRange;
  clippedToNow: boolean;
  bucketCount: number;
}

/**
 * Validate a timeline window. `nowUtc` is an input so the harness controls time.
 *
 * In this order, first failure wins:
 * 1. `start` then `end` through parseInstant (named "start" / "end").
 * 2. end <= start: 400 `inverted_window`. Zero length is inverted too.
 * 3. requested length > MAX_WINDOW_SECONDS: 422 `window_too_large`.
 * 4. start >= now: 422 `window_in_future`.
 * 5. `buckets`: absent or blank means DEFAULT_BUCKETS; otherwise digits only and
 *    1..10000, else 400 `bad_buckets`.
 * Then `effective.endUtc` is min(end, now), and `clippedToNow` is end > now.
 */
export function parseWindow(query: WindowQuery, nowUtc: string): ParsedWindow | ApiRefusal {
  const start = parseInstant(query.start, "start");
  if (start.ok === false) return start;
  const end = parseInstant(query.end, "end");
  if (end.ok === false) return end;

  if (end.ms <= start.ms) {
    return refuse(400, "inverted_window", `end (${end.utc}) is not after start (${start.utc})`);
  }
  // Measured on the window as requested: a caller asking for an hour of the past
  // and forty days of the future is asking for forty days, whatever we can answer.
  const requestedSeconds = (end.ms - start.ms) / 1000;
  if (requestedSeconds > MAX_WINDOW_SECONDS) {
    return refuse(422, "window_too_large",
      `the window asks for ${requestedSeconds} seconds; one request may ask for ${MAX_WINDOW_SECONDS}`);
  }
  const nowMs = parseUtc(nowUtc);
  if (start.ms >= nowMs) {
    return refuse(422, "window_in_future",
      `the window starts at ${start.utc}, which is not before now (${toUtc(nowMs)})`);
  }

  let bucketCount = DEFAULT_BUCKETS;
  const buckets: unknown = query.buckets;
  if (buckets !== undefined && buckets !== null && buckets !== "") {
    if (typeof buckets !== "string" || !DIGITS_PATTERN.test(buckets)) {
      return refuse(400, "bad_buckets", `buckets must be digits only, got ${JSON.stringify(buckets)}`);
    }
    const count = Number(buckets);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BUCKETS) {
      return refuse(400, "bad_buckets", `buckets must be between 1 and ${MAX_BUCKETS}, got ${buckets}`);
    }
    bucketCount = count;
  }

  const clippedToNow = end.ms > nowMs;
  return {
    ok: true,
    requested: { startUtc: start.utc, endUtc: end.utc },
    effective: { startUtc: start.utc, endUtc: clippedToNow ? toUtc(nowMs) : end.utc },
    clippedToNow,
    bucketCount,
  };
}

const DIGITS_PATTERN = /^[0-9]+$/;

/** As many buckets as a wide screen has pixels; beyond that it is not a timeline. */
const MAX_BUCKETS = 10_000;

export function isCameraId(raw: unknown): raw is string {
  return typeof raw === "string" && CAMERA_ID_PATTERN.test(raw);
}

/**
 * The opaque id a client uses to fetch one segment: `<cameraId>.<startMs>`.
 *
 * A client never sends a file path and the server never builds one from what a
 * client sent — it looks the id up in the index and serves the path the index
 * holds. Throws on an invalid camera id or a start that is not a non-negative
 * safe integer: those are programming errors on our side, not client input.
 */
export function segmentId(cameraId: string, startMs: number): string {
  if (!isCameraId(cameraId)) {
    throw new Error(`not a camera id: ${JSON.stringify(cameraId)}`);
  }
  if (!Number.isSafeInteger(startMs) || startMs < 0) {
    throw new Error(`not a non-negative safe integer of epoch ms: ${startMs}`);
  }
  return `${cameraId}.${startMs}`;
}

/**
 * Parse a client-supplied segment id. Refuses (400 `bad_segment_id`) anything
 * that `segmentId` could not have produced: a bad camera id, a non-digit or
 * signed start, a leading zero (unless the start is exactly 0), a start beyond
 * Number.MAX_SAFE_INTEGER, a path separator, `..`, or trailing text.
 */
export function parseSegmentId(
  raw: string | null | undefined,
): { ok: true; cameraId: string; startMs: number } | ApiRefusal {
  const value: unknown = raw;
  if (typeof value !== "string" || value === "") {
    return refuse(400, "bad_segment_id", `a segment id is required, got ${JSON.stringify(value)}`);
  }
  // One pattern for the whole id: the camera part cannot hold a separator or a
  // dot, so no id parses to a name outside the index whatever a client sends.
  const m = SEGMENT_ID_PATTERN.exec(value);
  const cameraId = m === null ? undefined : m[1];
  const startText = m === null ? undefined : m[2];
  if (cameraId === undefined || startText === undefined) {
    return refuse(400, "bad_segment_id",
      `not a segment id: ${JSON.stringify(value)}; expected <cameraId>.<startMs>`);
  }
  const startMs = Number(startText);
  if (!Number.isSafeInteger(startMs)) {
    return refuse(400, "bad_segment_id", `segment start is beyond the safe integer range: ${startText}`);
  }
  return { ok: true, cameraId, startMs };
}

/** The exact shape segmentId mints: no leading zero unless the start is 0. */
const SEGMENT_ID_PATTERN = /^([A-Za-z0-9_-]{1,64})\.(0|[1-9][0-9]*)$/;
