/**
 * Manager rules: templates, validation, and the evaluator that turns
 * occupancy transitions into firings. MANAGER-RULES-SPEC.md section 3.
 * Pure: no I/O, no clock — "now", the site's open hours and the site's time
 * zone are all handed in, exactly like alertRules.ts's own decideAlert.
 *
 * THE FEARED FAILURES:
 * - a rule that reads hours it does not have: a rule using open_hours or
 *   closed_hours while the site's openHours is unset would either silently
 *   never fire or (worse) silently fire always — refused at save time
 *   instead ("set the store's open hours first"), the same discipline
 *   alertRules.ts's checkRule already applies to a rule with a bad schedule;
 * - a "the manager came back" reported for a return that was never actually
 *   watched: an absence that runs into not_watching before returning to
 *   present is NEVER read as a completed away_and_back — reported as
 *   "away from X, then not watching from Y" instead, a MEASUREMENT
 *   (build rule 11), never a guessed return (build rule 17: never blend a
 *   measurement with an assumption);
 * - a firing whose numbers move later: absent_longer_than/present_longer_than
 *   fire at the exact instant their threshold is crossed, with a duration
 *   fixed at that instant — calling the evaluator again with a later `now`
 *   must never change an already-produced firing's start, end or duration
 *   (the same "a quote must never move in a customer's hands" discipline,
 *   build rule 7, applied to a report line instead of a price);
 * - a report that names a person: there is no field for one anywhere in this
 *   file, on purpose — the only names a firing's text can ever contain are
 *   the RULE's own name and, indirectly through the caller, camera and area
 *   names, never a person (MANAGER-RULES-SPEC.md's identity-free mandate).
 *
 * `alertWanted` here is a per-firing recommendation copied from the rule's
 * own `notify.alert` (build 2 is the file that actually sends a phone push);
 * this file only decides whether a firing WANTS one.
 */

import { parseUtc } from "./time.js";
import { isOpen, localParts } from "./alertRules.js";
import type { Schedule } from "./alertRules.js";
import type { OccupancyKind, OccupancyState, OccupancyTransition } from "./zoneOccupancy.js";

// ---------------------------------------------------------------- the rule model

export type ManagerRuleTemplate =
  | "desk_unattended"
  | "away_and_back"
  | "after_hours_person"
  | "lingering"
  | "vehicle_arrives"
  | "vehicle_leaves"
  | "door_used"
  | "custom";

export const MANAGER_RULE_TEMPLATES_KNOWN: readonly ManagerRuleTemplate[] = Object.freeze([
  "desk_unattended",
  "away_and_back",
  "after_hours_person",
  "lingering",
  "vehicle_arrives",
  "vehicle_leaves",
  "door_used",
  "custom",
]);

export type ManagerRuleKind = OccupancyKind;
export type ManagerRuleWhen = "open_hours" | "closed_hours" | "always";

/**
 * The synthetic area id a "whole camera" rule's occupancy lives under
 * (`rule.areaId === null`, MANAGER-RULES-SPEC.md section 1). Shared by
 * agent/detect-service.mjs (the writer — it keeps a real occupancy tracker
 * under this key, same hysteresis and gap/schedule-closed ticks as a drawn
 * area) and agent/api-server.mjs's evaluator (the reader — it maps a rule's
 * `areaId === null` to this key before reading occupancy.db), so the two
 * can never drift into different ideas of which key means "no area". A
 * plain string function, not a real area id: `checkAreasFile` never issues
 * one shaped like this, since no installer-drawn area can collide with it.
 */
export function wholeCameraAreaId(cameraId: string): string {
  return `whole:${cameraId}`;
}

export type ManagerRuleCondition =
  | { type: "enters" }
  | { type: "leaves" }
  | { type: "absent_longer_than"; minutes: number }
  | { type: "present_longer_than"; minutes: number }
  | { type: "away_and_back"; minMinutes: number };

export interface ManagerRuleNotify {
  alert: boolean;
  report: boolean;
  /** Minutes; 0 means no throttling beyond "fires once per stretch". */
  cooldownMinutes: number;
}

export interface ManagerRule {
  id: string;
  name: string;
  enabled: boolean;
  template: ManagerRuleTemplate;
  cameraId: string;
  /** null = "whole camera" (no area). */
  areaId: string | null;
  kind: ManagerRuleKind;
  condition: ManagerRuleCondition;
  when: ManagerRuleWhen;
  notify: ManagerRuleNotify;
  createdBy: string;
  updatedUtc: string;
  updatedBy: string;
}

// ---------------------------------------------------------------- templates

/**
 * One row of "Templates" (MANAGER-RULES-SPEC.md section 3). A template only
 * pre-fills a rule's kind/condition/when/notify — cameraId, areaId, id,
 * name, createdBy/updatedUtc/updatedBy are filled in by whoever applies it,
 * never guessed here. `wholeCamera: true` means the picker should not offer
 * an area at all ("Person after hours" is "person, whole camera").
 *
 * "away_and_back" appears TWICE — once for the manager's desk (person), once
 * for the manager's car (vehicle) — sharing one `template` id, because the
 * enum names the CONDITION SHAPE a rule was seeded from, not a 1:1 picker
 * row; the row itself is told apart by `label` and `kind`.
 *
 * "Manager's desk unattended" is first, per the spec.
 */
export interface ManagerRuleTemplateDef {
  template: ManagerRuleTemplate;
  label: string;
  kind: ManagerRuleKind;
  wholeCamera: boolean;
  condition: ManagerRuleCondition;
  when: ManagerRuleWhen;
  notify: ManagerRuleNotify;
}

export const MANAGER_RULE_TEMPLATES: readonly ManagerRuleTemplateDef[] = Object.freeze([
  {
    template: "desk_unattended",
    label: "Manager's desk unattended",
    kind: "person",
    wholeCamera: false,
    condition: { type: "absent_longer_than", minutes: 20 },
    when: "open_hours",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
  },
  {
    template: "away_and_back",
    label: "Manager away and back (desk)",
    kind: "person",
    wholeCamera: false,
    condition: { type: "away_and_back", minMinutes: 5 },
    when: "open_hours",
    notify: { alert: false, report: true, cooldownMinutes: 0 },
  },
  {
    template: "away_and_back",
    label: "Manager's car away and back",
    kind: "vehicle",
    wholeCamera: false,
    condition: { type: "away_and_back", minMinutes: 10 },
    when: "open_hours",
    notify: { alert: false, report: true, cooldownMinutes: 0 },
  },
  {
    template: "after_hours_person",
    label: "Person after hours",
    kind: "person",
    wholeCamera: true,
    condition: { type: "enters" },
    when: "closed_hours",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
  },
  {
    template: "lingering",
    label: "Lingering",
    kind: "person",
    wholeCamera: false,
    condition: { type: "present_longer_than", minutes: 10 },
    when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
  },
  {
    template: "vehicle_arrives",
    label: "Vehicle arrives",
    kind: "vehicle",
    wholeCamera: false,
    condition: { type: "enters" },
    when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
  },
  {
    template: "vehicle_leaves",
    label: "Vehicle leaves",
    kind: "vehicle",
    wholeCamera: false,
    condition: { type: "leaves" },
    when: "always",
    notify: { alert: true, report: true, cooldownMinutes: 0 },
  },
  {
    template: "door_used",
    label: "Door used",
    kind: "person",
    wholeCamera: false,
    condition: { type: "enters" },
    when: "always",
    notify: { alert: false, report: true, cooldownMinutes: 0 },
  },
]);

// ---------------------------------------------------------------- validation

export interface FieldProblem {
  field: string;
  reason: string;
}

export type ManagerRuleCheck = { ok: true; rule: ManagerRule } | { ok: false; errors: FieldProblem[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkCondition(raw: unknown, errors: FieldProblem[]): ManagerRuleCondition | null {
  if (!isRecord(raw)) {
    errors.push({ field: "condition", reason: "not_an_object" });
    return null;
  }
  const type = raw.type;
  const otherKeys = (allowed: readonly string[]) => Object.keys(raw).filter((k) => !allowed.includes(k));
  switch (type) {
    case "enters":
    case "leaves": {
      const extra = otherKeys(["type"]);
      if (extra.length > 0) {
        errors.push({ field: "condition", reason: "unknown_field" });
        return null;
      }
      return { type };
    }
    case "absent_longer_than":
    case "present_longer_than": {
      const extra = otherKeys(["type", "minutes"]);
      let ok = extra.length === 0;
      if (!ok) errors.push({ field: "condition", reason: "unknown_field" });
      const minutes = raw.minutes;
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
        errors.push({ field: "condition.minutes", reason: "bad_minutes" });
        ok = false;
      }
      return ok ? { type, minutes: minutes as number } : null;
    }
    case "away_and_back": {
      const extra = otherKeys(["type", "minMinutes"]);
      let ok = extra.length === 0;
      if (!ok) errors.push({ field: "condition", reason: "unknown_field" });
      const minMinutes = raw.minMinutes;
      if (typeof minMinutes !== "number" || !Number.isFinite(minMinutes) || minMinutes <= 0) {
        errors.push({ field: "condition.minMinutes", reason: "bad_min_minutes" });
        ok = false;
      }
      return ok ? { type, minMinutes: minMinutes as number } : null;
    }
    default:
      errors.push({ field: "condition.type", reason: "bad_condition_type" });
      return null;
  }
}

function checkNotify(raw: unknown, errors: FieldProblem[]): ManagerRuleNotify | null {
  if (!isRecord(raw)) {
    errors.push({ field: "notify", reason: "not_an_object" });
    return null;
  }
  let ok = true;
  if (typeof raw.alert !== "boolean") {
    errors.push({ field: "notify.alert", reason: "bad_flag" });
    ok = false;
  }
  if (typeof raw.report !== "boolean") {
    errors.push({ field: "notify.report", reason: "bad_flag" });
    ok = false;
  }
  const cooldownMinutes = raw.cooldownMinutes;
  if (typeof cooldownMinutes !== "number" || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
    errors.push({ field: "notify.cooldownMinutes", reason: "bad_cooldown" });
    ok = false;
  }
  return ok ? { alert: raw.alert as boolean, report: raw.report as boolean, cooldownMinutes: cooldownMinutes as number } : null;
}

/**
 * Validate a manager rule before it is saved, listing EVERY problem (the
 * rules form shows them all at once, not one fix-and-resave at a time).
 *
 * `openHours` is the site's CURRENT openHours (site.json), at save time — a
 * rule using `when: "open_hours"` or `"closed_hours"` while it is null is
 * refused with reason "hours_not_set" (shown to the installer/manager as
 * "set the store's open hours first"); it is never guessed at, and a rule
 * using `"always"` needs no hours at all.
 */
export function checkManagerRule(raw: unknown, openHours: Schedule | null): ManagerRuleCheck {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "rule", reason: "not_an_object" }] };
  }
  const errors: FieldProblem[] = [];

  if (typeof raw.id !== "string" || raw.id === "") errors.push({ field: "id", reason: "bad_id" });
  if (typeof raw.name !== "string" || raw.name.trim() === "") errors.push({ field: "name", reason: "bad_name" });
  if (typeof raw.enabled !== "boolean") errors.push({ field: "enabled", reason: "bad_enabled" });
  if (typeof raw.template !== "string" || !MANAGER_RULE_TEMPLATES_KNOWN.includes(raw.template as ManagerRuleTemplate)) {
    errors.push({ field: "template", reason: "bad_template" });
  }
  if (typeof raw.cameraId !== "string" || raw.cameraId === "") errors.push({ field: "cameraId", reason: "bad_camera" });
  if (raw.areaId !== null && (typeof raw.areaId !== "string" || raw.areaId === "")) {
    errors.push({ field: "areaId", reason: "bad_area" });
  }
  if (raw.kind !== "person" && raw.kind !== "vehicle") errors.push({ field: "kind", reason: "bad_kind" });

  const condition = checkCondition(raw.condition, errors);

  let when: ManagerRuleWhen | null = null;
  if (raw.when !== "open_hours" && raw.when !== "closed_hours" && raw.when !== "always") {
    errors.push({ field: "when", reason: "bad_when" });
  } else {
    when = raw.when;
    if (when !== "always" && openHours === null) {
      errors.push({ field: "when", reason: "hours_not_set" });
    }
  }

  const notify = checkNotify(raw.notify, errors);

  if (typeof raw.createdBy !== "string" || raw.createdBy.trim() === "") errors.push({ field: "createdBy", reason: "bad_actor" });

  let updatedUtc: string | null = null;
  if (typeof raw.updatedUtc !== "string") {
    errors.push({ field: "updatedUtc", reason: "bad_time" });
  } else {
    try {
      parseUtc(raw.updatedUtc);
      updatedUtc = raw.updatedUtc;
    } catch {
      errors.push({ field: "updatedUtc", reason: "bad_time" });
    }
  }
  if (typeof raw.updatedBy !== "string" || raw.updatedBy.trim() === "") errors.push({ field: "updatedBy", reason: "bad_actor" });

  if (errors.length > 0 || condition === null || when === null || notify === null || updatedUtc === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    rule: {
      id: raw.id as string,
      name: (raw.name as string).trim(),
      enabled: raw.enabled as boolean,
      template: raw.template as ManagerRuleTemplate,
      cameraId: raw.cameraId as string,
      areaId: raw.areaId === null ? null : (raw.areaId as string),
      kind: raw.kind as ManagerRuleKind,
      condition,
      when,
      notify,
      createdBy: (raw.createdBy as string).trim(),
      updatedUtc,
      updatedBy: (raw.updatedBy as string).trim(),
    },
  };
}

// ---------------------------------------------------------------- firings

export type ManagerRuleFiringKind = ManagerRuleCondition["type"];

export interface ManagerRuleFiring {
  ruleId: string;
  /** A snapshot of the rule's name AT FIRE TIME (build rule 7: a firing keeps the name it had). */
  ruleName: string;
  cameraId: string;
  areaId: string | null;
  kind: ManagerRuleKind;
  what: ManagerRuleFiringKind;
  /**
   * false only for an away_and_back stretch cut short by not_watching before
   * it returned to present — reported, but never with a guessed return
   * (`endMs`/`durationMs` describe what was actually measured: when the
   * absence started and when tracking was lost, not how long it "really"
   * lasted).
   */
  complete: boolean;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  /** Identity-free wording, e.g. "Manager's desk unattended 2:10-2:55 (45 min)". */
  text: string;
  alertWanted: boolean;
  reportWanted: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function clockLabel(timeZone: string, ms: number): string {
  const { minute } = localParts(timeZone, ms);
  return `${Math.floor(minute / 60)}:${pad2(minute % 60)}`;
}

interface RawFiring {
  what: ManagerRuleFiringKind;
  complete: boolean;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  /** The instant `when` is checked against (the return, the crossing, the transition itself). */
  gateAtMs: number;
}

function describeFiring(ruleName: string, f: RawFiring, timeZone: string): string {
  if (f.what === "away_and_back" && !f.complete) {
    // f.endMs is always set for an incomplete away_and_back (the not_watching instant).
    return `${ruleName} away from ${clockLabel(timeZone, f.startMs)}, then not watching from ${clockLabel(timeZone, f.endMs as number)}`;
  }
  if (f.endMs === null || f.endMs === f.startMs) {
    return `${ruleName} ${clockLabel(timeZone, f.startMs)}`;
  }
  const minutes = Math.round((f.durationMs ?? f.endMs - f.startMs) / 60_000);
  return `${ruleName} ${clockLabel(timeZone, f.startMs)}-${clockLabel(timeZone, f.endMs)} (${minutes} min)`;
}

// ---------------------------------------------------------------- the evaluator

/**
 * enters/leaves candidates: a transition into present FROM absent (enters),
 * or into absent FROM present (leaves) — never involving not_watching on
 * either side, per the spec ("A transition from or into not_watching never
 * counts as entering or leaving"). The very first transition in the array
 * has no known prior state, so it can never itself be an enter/leave.
 */
function edgeCandidates(
  transitions: readonly OccupancyTransition[],
  type: "enters" | "leaves",
): RawFiring[] {
  const from: OccupancyState = type === "enters" ? "absent" : "present";
  const to: OccupancyState = type === "enters" ? "present" : "absent";
  const out: RawFiring[] = [];
  for (let i = 1; i < transitions.length; i++) {
    const prev = transitions[i - 1] as OccupancyTransition;
    const cur = transitions[i] as OccupancyTransition;
    if (prev.state === from && cur.state === to) {
      out.push({ what: type, complete: true, startMs: cur.atMs, endMs: cur.atMs, durationMs: 0, gateAtMs: cur.atMs });
    }
  }
  return out;
}

interface Stretch {
  startMs: number;
  /** The real end, or `nowMs` when the stretch is still ongoing. */
  boundaryMs: number;
  ongoing: boolean;
}

/**
 * Maximal unbroken runs of `state === target`, each one starting fresh at
 * every entry into `target` — including a re-entry straight after
 * `not_watching`, which is exactly what makes a not_watching visit "restart
 * the clock" (MANAGER-RULES-SPEC.md): not_watching is simply not `target`,
 * so it always closes a run in progress like any other state would, and the
 * next entry into `target` opens a brand new one.
 */
function cleanStretches(
  transitions: readonly OccupancyTransition[],
  target: OccupancyState,
  nowMs: number,
): Stretch[] {
  const stretches: Stretch[] = [];
  let prevState: OccupancyState | null = null;
  let startMs: number | null = null;
  for (const t of transitions) {
    if (prevState !== target && t.state === target) {
      startMs = t.atMs;
    } else if (prevState === target && t.state !== target) {
      if (startMs !== null) stretches.push({ startMs, boundaryMs: t.atMs, ongoing: false });
      startMs = null;
    }
    prevState = t.state;
  }
  if (prevState === target && startMs !== null) {
    stretches.push({ startMs, boundaryMs: nowMs, ongoing: true });
  }
  return stretches;
}

/**
 * absent_longer_than / present_longer_than candidates. Each clean stretch
 * (see cleanStretches) contributes AT MOST ONE candidate — the instant it
 * crosses the threshold, fixed at `stretch.startMs + thresholdMs` regardless
 * of how much longer the stretch goes on or how much later `nowMs` is on a
 * later call — which is what makes "fires once per stretch" true by
 * construction, and what keeps a firing's own numbers from moving later.
 */
function longerThanCandidates(
  transitions: readonly OccupancyTransition[],
  target: OccupancyState,
  thresholdMs: number,
  nowMs: number,
  what: "absent_longer_than" | "present_longer_than",
): RawFiring[] {
  const out: RawFiring[] = [];
  for (const stretch of cleanStretches(transitions, target, nowMs)) {
    const crossing = stretch.startMs + thresholdMs;
    if (crossing <= stretch.boundaryMs) {
      out.push({ what, complete: true, startMs: stretch.startMs, endMs: crossing, durationMs: thresholdMs, gateAtMs: crossing });
    }
  }
  return out;
}

/**
 * away_and_back candidates: a present-to-absent departure, ended EITHER by a
 * return to present (a completed away, fired at the return) OR by a slide
 * into not_watching (an incomplete record, fired at that instant) — never
 * both, and never a departure that started from not_watching itself (only a
 * departure FROM present is "bounded by present" on that end). Either way,
 * only departures that had already lasted at least minMinutes by the time
 * they ended are reported at all; a short away-and-back is not an away-and-
 * back, and a short excursion into not_watching is not worth "then not
 * watching from" either.
 */
function awayAndBackCandidates(transitions: readonly OccupancyTransition[], thresholdMs: number): RawFiring[] {
  const out: RawFiring[] = [];
  let prevState: OccupancyState | null = null;
  let departAtMs: number | null = null;
  for (const t of transitions) {
    if (prevState !== "absent" && t.state === "absent") {
      departAtMs = prevState === "present" ? t.atMs : null;
    } else if (prevState === "absent" && t.state !== "absent") {
      if (departAtMs !== null) {
        const elapsed = t.atMs - departAtMs;
        if (elapsed >= thresholdMs) {
          if (t.state === "present") {
            out.push({
              what: "away_and_back",
              complete: true,
              startMs: departAtMs,
              endMs: t.atMs,
              durationMs: elapsed,
              gateAtMs: t.atMs,
            });
          } else {
            // t.state === "not_watching"
            out.push({
              what: "away_and_back",
              complete: false,
              startMs: departAtMs,
              endMs: t.atMs,
              durationMs: null,
              gateAtMs: t.atMs,
            });
          }
        }
      }
      departAtMs = null;
    }
    prevState = t.state;
  }
  return out;
}

function candidatesFor(rule: ManagerRule, transitions: readonly OccupancyTransition[], nowMs: number): RawFiring[] {
  switch (rule.condition.type) {
    case "enters":
      return edgeCandidates(transitions, "enters");
    case "leaves":
      return edgeCandidates(transitions, "leaves");
    case "absent_longer_than":
      return longerThanCandidates(transitions, "absent", rule.condition.minutes * 60_000, nowMs, "absent_longer_than");
    case "present_longer_than":
      return longerThanCandidates(transitions, "present", rule.condition.minutes * 60_000, nowMs, "present_longer_than");
    case "away_and_back":
      return awayAndBackCandidates(transitions, rule.condition.minMinutes * 60_000);
  }
}

// ---------------------------------------------------------------- reports: a local day's UTC bounds

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ReportDayCheck = { ok: true; startMs: number; endMs: number } | { ok: false; reason: "bad_day" | "bad_time_zone" };

/**
 * `[startMs, endMs)`: the UTC bounds of local calendar day `day` in
 * `timeZone` — GET /reports' own `?day=YYYY-MM-DD` "in the site tz"
 * (MANAGER-RULES-SPEC.md section 5). Correct across a DST day (a 23 h or
 * 25 h local day): start and end are each resolved independently against
 * the zone's own offset AT THAT INSTANT, exactly the "convert with Intl, so
 * the offset is the one in force on that date" discipline alertRules.ts's own
 * `isOpen` already keeps — this file does not invent a second one.
 *
 * The "guess as UTC, measure the zone's offset there, correct once" step
 * below (`resolve`) mirrors the well-known local-time-to-UTC algorithm: a
 * wall clock is guessed to BE the UTC instant, the zone's offset at that
 * guess is read back out with `localParts` (already imported for `isOpen`),
 * and the guess is corrected by that offset — then corrected once more in
 * case the correction itself crossed a DST transition (it never has to a
 * third time: no real zone's offset changes twice inside one day).
 */
export function reportDayRange(timeZone: string, day: string): ReportDayCheck {
  const m = DAY_PATTERN.exec(day);
  if (m === null) return { ok: false, reason: "bad_day" };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dateOfMonth = Number(m[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, dateOfMonth));
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== dateOfMonth) {
    return { ok: false, reason: "bad_day" };
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return { ok: false, reason: "bad_time_zone" };
  }
  const offsetOf = (guessMs: number): number => {
    const p = localParts(timeZone, guessMs);
    const [py, pm, pd] = p.date.split("-").map(Number) as [number, number, number];
    const asUtcIfLocalWereUtc = Date.UTC(py, pm - 1, pd) + p.minute * 60_000;
    return asUtcIfLocalWereUtc - guessMs;
  };
  const resolve = (guessMs: number): number => {
    const offset1 = offsetOf(guessMs);
    const resolved1 = guessMs - offset1;
    const offset2 = offsetOf(resolved1);
    return offset2 === offset1 ? resolved1 : guessMs - offset2;
  };
  const startGuessMs = Date.UTC(year, month - 1, dateOfMonth);
  const endGuessMs = startGuessMs + 86_400_000;
  return { ok: true, startMs: resolve(startGuessMs), endMs: resolve(endGuessMs) };
}

function whenGate(when: ManagerRuleWhen, openHours: Schedule | null, atMs: number): boolean {
  if (when === "always") return true;
  if (openHours === null) {
    // checkManagerRule refuses this combination at save time; reaching here
    // means a caller evaluated a rule it should never have been able to save.
    throw new TypeError("evaluateManagerRule: rule needs open hours but openHours is null");
  }
  const open = isOpen(openHours, atMs);
  return when === "open_hours" ? open : !open;
}

/**
 * Turn one rule's occupancy transitions into firings. Called on a timer
 * (MANAGER-RULES-SPEC.md: "reads occupancy.db every 5 s plus a timer") so
 * duration-based conditions (absent_longer_than, present_longer_than,
 * away_and_back) can be noticed purely because time passed, without any new
 * transition arriving.
 *
 * `transitions` is this rule's own (camera, area, kind) transition stream,
 * chronological — the caller (agent/api-server.mjs) picks the right stream;
 * this function does not know or care whether it came from an area or a
 * whole camera. `lastFiredAtMs` is the last time THIS rule fired (across all
 * its past firings, from rules.db) — cooldownMinutes is measured from there,
 * the same shape as alertRules.ts's decideAlert taking `lastAlertUtc`.
 *
 * Deterministic and side-effect-free: calling this again with a later `now`
 * over the same transitions never changes an already-produced firing's
 * numbers, only whether MORE firings now qualify.
 */
export function evaluateManagerRule(
  rule: ManagerRule,
  transitions: readonly OccupancyTransition[],
  nowMs: number,
  openHours: Schedule | null,
  timeZone: string,
  lastFiredAtMs: number | null,
): ManagerRuleFiring[] {
  const candidates = candidatesFor(rule, transitions, nowMs);
  const gated = candidates.filter((c) => whenGate(rule.when, openHours, c.gateAtMs));
  gated.sort((a, b) => a.gateAtMs - b.gateAtMs);

  const cooldownMs = rule.notify.cooldownMinutes * 60_000;
  const out: ManagerRuleFiring[] = [];
  let lastKeptAtMs = lastFiredAtMs;
  for (const f of gated) {
    // A candidate at or before the rule's own last-recorded firing has
    // ALREADY been turned into a firing — re-derive it and it is a verbatim
    // duplicate, not a new event. This check is independent of
    // cooldownMinutes on purpose: cooldown is a business throttle on how
    // OFTEN a rule may re-alert, never the mechanism that keeps an
    // unchanged, already-fired instant from being written twice. Every
    // shipped template defaults cooldownMinutes to 0, so without this `<=`
    // gate the `< cooldownMs` check below alone lets an exact repeat
    // (diff === 0) slip through on every subsequent evaluator tick.
    if (lastKeptAtMs !== null && f.gateAtMs <= lastKeptAtMs) continue;
    if (lastKeptAtMs !== null && f.gateAtMs - lastKeptAtMs < cooldownMs) continue;
    out.push({
      ruleId: rule.id,
      ruleName: rule.name,
      cameraId: rule.cameraId,
      areaId: rule.areaId,
      kind: rule.kind,
      what: f.what,
      complete: f.complete,
      startMs: f.startMs,
      endMs: f.endMs,
      durationMs: f.durationMs,
      text: describeFiring(rule.name, f, timeZone),
      alertWanted: f.complete && rule.notify.alert,
      reportWanted: rule.notify.report,
    });
    lastKeptAtMs = f.gateAtMs;
  }
  return out;
}
