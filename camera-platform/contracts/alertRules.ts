/**
 * After-hours alert rules: when a detection event should reach a phone.
 * AI-PLAN.md stage D0. Pure: the caller passes the time.
 *
 * THE FEARED FAILURES:
 * - **Daylight saving.** uploadPolicy.ts's OpenHours uses a fixed UTC offset,
 *   which is an hour wrong for half the year. A store closing at 22:00 would
 *   get no alert for 22:00-23:00 all summer. Here hours are in the site's IANA
 *   time zone and every instant is converted with Intl, so the offset is the
 *   one in force on that date.
 * - **Hours past midnight.** A bar open 18:00-02:00 on Friday is still open at
 *   01:30 on Saturday; that half-hour must not alert.
 * - **A rule that silently never fires.** A bad time zone or a mistyped hour is
 *   refused when the rule is saved (checkRule), and decideAlert says
 *   "invalid_rule" rather than a quiet false.
 * - **A flood.** One person pacing the lot is one alert, not forty (cooldown).
 */

import { parseUtc } from "./time.js";
import { EVENT_KINDS } from "./detection.js";
import type { DetectionEvent, EventKind } from "./detection.js";

/** Minutes from local midnight, 0..1440. close < open means it runs past midnight. */
export interface OpenInterval {
  open: number;
  close: number;
}

export interface Schedule {
  /** IANA zone, e.g. "America/Chicago". */
  timeZone: string;
  /** Index 0 = Sunday ... 6 = Saturday. An empty day is closed all day. */
  weekly: OpenInterval[][];
  /** Local dates "YYYY-MM-DD" closed all day, whatever `weekly` says. */
  closedDates: string[];
}

/** A zone as a polygon of at least three points, in frame fractions (0..1). */
export type Zone = Array<[number, number]>;

export interface AlertRule {
  id: string;
  cameraIds: string[];
  kinds: EventKind[];
  /** 0..1. */
  minConfidence: number;
  schedule: Schedule;
  /** Empty: the whole frame. Otherwise the event's feet must be in one of them. */
  zones: Zone[];
  /** Seconds after an alert on a camera before that camera may alert again. */
  cooldownSeconds: number;
}

export type RuleCheck = { ok: true } | { ok: false; reason: string };

export type AlertDecision =
  | { alert: true }
  | {
      alert: false;
      reason:
        | "invalid_rule"
        | "wrong_camera"
        | "wrong_kind"
        | "below_confidence"
        | "open_hours"
        | "outside_zones"
        | "cooldown";
    };

/**
 * The site-local date, weekday and minute of an instant.
 *
 * 1. Use new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23",
 *    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
 *    hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs)).
 * 2. date = `${year}-${month}-${day}`; weekday = index of the "weekday" part in
 *    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]; minute = hour * 60 + minute
 *    (treat an hour of 24 as 0).
 * 3. Throws RangeError for an unknown time zone (Intl does); callers check first.
 */
export function localParts(timeZone: string, utcMs: number): { date: string; weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? "" : part.value;
  };
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  const minute = hour * 60 + Number(get("minute"));
  return { date, weekday, minute };
}

/** The local date one day before "YYYY-MM-DD" (pure calendar arithmetic, UTC-based). */
export function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Validate a rule before it is saved. First failure wins, in this order:
 *
 * 1. id: non-empty string: "bad_id".
 * 2. cameraIds: a non-empty array of non-empty strings: "no_cameras".
 * 3. kinds: a non-empty array, each "person", "vehicle" or "plate": "bad_kinds".
 * 4. minConfidence: finite, 0..1: "bad_confidence".
 * 5. schedule.timeZone: a string that `new Intl.DateTimeFormat("en-US",
 *    { timeZone })` accepts without throwing: "bad_time_zone".
 * 6. schedule.weekly: an array of exactly 7 arrays; every interval has integer
 *    open and close with 0 <= open <= 1440, 0 <= close <= 1440 and
 *    open !== close: "bad_hours".
 * 7. schedule.closedDates: an array of strings each matching
 *    /^\d{4}-\d{2}-\d{2}$/ and naming a real date (round-trips through
 *    Date.UTC): "bad_closed_date".
 * 8. zones: an array; each zone has at least 3 points, each point two finite
 *    numbers in 0..1: "bad_zone".
 * 9. cooldownSeconds: an integer, 0..86400: "bad_cooldown".
 * 10. Otherwise { ok: true }.
 */
export function checkRule(rule: unknown): RuleCheck {
  if (typeof rule !== "object" || rule === null) {
    return { ok: false, reason: "bad_id" };
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") {
    return { ok: false, reason: "bad_id" };
  }
  const cameraIds = r.cameraIds;
  if (!Array.isArray(cameraIds) || cameraIds.length === 0 ||
      cameraIds.some((c) => typeof c !== "string" || c === "")) {
    return { ok: false, reason: "no_cameras" };
  }
  const kinds = r.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 ||
      kinds.some((k) => typeof k !== "string" || !(EVENT_KINDS as readonly string[]).includes(k))) {
    return { ok: false, reason: "bad_kinds" };
  }
  const minConfidence = r.minConfidence;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) ||
      minConfidence < 0 || minConfidence > 1) {
    return { ok: false, reason: "bad_confidence" };
  }
  const schedule = r.schedule;
  if (typeof schedule !== "object" || schedule === null) {
    return { ok: false, reason: "bad_time_zone" };
  }
  const s = schedule as Record<string, unknown>;
  if (typeof s.timeZone !== "string") {
    return { ok: false, reason: "bad_time_zone" };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timeZone });
  } catch {
    return { ok: false, reason: "bad_time_zone" };
  }
  const weekly = s.weekly;
  if (!Array.isArray(weekly) || weekly.length !== 7 ||
      weekly.some((day) => !Array.isArray(day) ||
        day.some((interval) => {
          if (typeof interval !== "object" || interval === null) {
            return true;
          }
          const open = interval.open;
          const close = interval.close;
          return typeof open !== "number" || typeof close !== "number" ||
            !Number.isInteger(open) || !Number.isInteger(close) ||
            open < 0 || open > 1440 || close < 0 || close > 1440 || open === close;
        }))) {
    return { ok: false, reason: "bad_hours" };
  }
  const closedDates = s.closedDates;
  if (!Array.isArray(closedDates) ||
      closedDates.some((date) => {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return true;
        }
        const year = Number(date.slice(0, 4));
        const month = Number(date.slice(5, 7));
        const day = Number(date.slice(8, 10));
        const back = new Date(Date.UTC(year, month - 1, day));
        return back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day;
      })) {
    return { ok: false, reason: "bad_closed_date" };
  }
  const zones = r.zones;
  if (!Array.isArray(zones) ||
      zones.some((zone) => !Array.isArray(zone) || zone.length < 3 ||
        zone.some((point) => !Array.isArray(point) || point.length !== 2 ||
          typeof point[0] !== "number" || !Number.isFinite(point[0]) || point[0] < 0 || point[0] > 1 ||
          typeof point[1] !== "number" || !Number.isFinite(point[1]) || point[1] < 0 || point[1] > 1))) {
    return { ok: false, reason: "bad_zone" };
  }
  const cooldownSeconds = r.cooldownSeconds;
  if (typeof cooldownSeconds !== "number" || !Number.isInteger(cooldownSeconds) ||
      cooldownSeconds < 0 || cooldownSeconds > 86_400) {
    return { ok: false, reason: "bad_cooldown" };
  }
  return { ok: true };
}

/**
 * Whether the site is open at an instant. Assumes a rule that passed checkRule.
 *
 * 1. p = localParts(schedule.timeZone, utcMs).
 * 2. Today's intervals: if p.date is in closedDates, none; else weekly[p.weekday].
 *    Open when some interval has open < close and open <= p.minute < close,
 *    or open > close (past midnight) and p.minute >= open.
 * 3. Yesterday's intervals that run past midnight: let y = previousDate(p.date)
 *    and yw = (p.weekday + 6) % 7. If y is not in closedDates, open when some
 *    interval in weekly[yw] has open > close and p.minute < close.
 * 4. Otherwise closed.
 */
export function isOpen(schedule: Schedule, utcMs: number): boolean {
  const p = localParts(schedule.timeZone, utcMs);
  const closed = new Set(schedule.closedDates);
  if (!closed.has(p.date)) {
    for (const interval of schedule.weekly[p.weekday] ?? []) {
      if (interval.open < interval.close && interval.open <= p.minute && p.minute < interval.close) {
        return true;
      }
      if (interval.open > interval.close && p.minute >= interval.open) {
        return true;
      }
    }
  }
  if (!closed.has(previousDate(p.date))) {
    for (const interval of schedule.weekly[(p.weekday + 6) % 7] ?? []) {
      if (interval.open > interval.close && p.minute < interval.close) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether an event alerts. Checks run in this order, first refusal wins:
 *
 * 1. checkRule(rule) not ok: "invalid_rule".
 * 2. event.cameraId not in rule.cameraIds: "wrong_camera".
 * 3. event.kind not in rule.kinds: "wrong_kind".
 * 4. event.bestConfidence < rule.minConfidence: "below_confidence".
 * 5. isOpen(rule.schedule, parseUtc(event.firstUtc)): "open_hours".
 * 6. rule.zones is non-empty and the feet point (bestBox.x + bestBox.w / 2,
 *    bestBox.y + bestBox.h) is inside none of them (ray casting; a point exactly
 *    on an edge may go either way): "outside_zones".
 * 7. lastAlertUtc is a string and parseUtc(event.firstUtc) - parseUtc(lastAlertUtc)
 *    is >= 0 and < cooldownSeconds * 1000: "cooldown". (`lastAlertUtc` is the
 *    last alert this rule sent for this camera, or null.)
 * 8. Otherwise { alert: true }.
 */
export function decideAlert(rule: AlertRule, event: DetectionEvent, lastAlertUtc: string | null): AlertDecision {
  if (!checkRule(rule).ok) {
    return { alert: false, reason: "invalid_rule" };
  }
  if (!rule.cameraIds.includes(event.cameraId)) {
    return { alert: false, reason: "wrong_camera" };
  }
  if (!rule.kinds.includes(event.kind)) {
    return { alert: false, reason: "wrong_kind" };
  }
  if (event.bestConfidence < rule.minConfidence) {
    return { alert: false, reason: "below_confidence" };
  }
  if (isOpen(rule.schedule, parseUtc(event.firstUtc))) {
    return { alert: false, reason: "open_hours" };
  }
  if (rule.zones.length > 0) {
    const px = event.bestBox.x + event.bestBox.w / 2;
    const py = event.bestBox.y + event.bestBox.h;
    let inside = false;
    for (const zone of rule.zones) {
      let inZone = false;
      let prev = zone[zone.length - 1] as [number, number];
      for (const pt of zone) {
        const xi = pt[0];
        const yi = pt[1];
        const xj = prev[0];
        const yj = prev[1];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
          inZone = !inZone;
        }
        prev = pt;
      }
      if (inZone) {
        inside = true;
        break;
      }
    }
    if (!inside) {
      return { alert: false, reason: "outside_zones" };
    }
  }
  if (typeof lastAlertUtc === "string") {
    const sinceMs = parseUtc(event.firstUtc) - parseUtc(lastAlertUtc);
    if (sinceMs >= 0 && sinceMs < rule.cooldownSeconds * 1000) {
      return { alert: false, reason: "cooldown" };
    }
  }
  return { alert: true };
}
