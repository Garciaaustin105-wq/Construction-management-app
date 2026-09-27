/**
 * The clothing signature: matching, learning today's manager, and the
 * today-file it lives in. APPEARANCE-OF-DAY-SPEC.md, MANAGER-RULES-SPEC.md
 * build 3. Pure: no I/O, no clock of its own — "now" and the site's time
 * zone are always handed in, exactly like alertRules.ts's own decideAlert.
 *
 * NO FACE RECOGNITION, EVER. This file never reads a signature apart from the
 * 145 numbers detector/appearance.py computed (upper-body histogram,
 * lower-body histogram, aspect ratio) — there is no face detector, no
 * landmark library, and nothing here ever looks at a pixel, a crop or a box:
 * that is entirely detector/appearance.py's job, upstream of everything in
 * this file. No field here is ever a person's name; every match is a
 * similarity percentage against "today's manager", never an identity.
 *
 * THE FEARED FAILURES:
 * - a malformed signature (wrong length, a non-finite number, a string that
 *   parses as a number) accepted and silently producing a plausible-looking
 *   similarity instead of being refused (build rule 10);
 * - a Bhattacharyya coefficient nudged just over 1 by the histograms' own
 *   3-decimal-place rounding (they do not sum to EXACTLY 1), then multiplied
 *   through into a "similarity" over 100% — every step here is defensively
 *   clamped, so bounded 0..100 is true by construction, not by luck;
 * - learning a manager from too few sightings (build rule 10's twin: "at
 *   least 20 signatures, or it is not learned yet and it keeps trying until
 *   the window ends") — MIN_SIGNATURES_TO_LEARN is a hard gate, not a
 *   suggestion;
 * - a second manager learned from a shift in LIGHTING rather than a
 *   genuinely different person — the 60% ceiling exists precisely because a
 *   same-person, different-lighting signature should usually clear it, and
 *   only a truly different build/colour combination should not;
 * - the file surviving past the day it was learned for: `isAppearanceTodayStale`
 *   is the ONLY thing that says "learn again", and it always asks in the
 *   SITE's own time zone, never UTC (a store that closes near midnight local
 *   would otherwise wipe or keep the file on the wrong side of its own day).
 */

import { parseUtc } from "./time.js";
import { localParts } from "./alertRules.js";
import type { Schedule } from "./alertRules.js";

// ---------------------------------------------------------------- the signature itself

/** upper-body histogram (72) + lower-body histogram (72) + aspect ratio (1). */
export const SIGNATURE_LENGTH = 145;
/** One region's own histogram length (8 hue x 3 sat x 3 value), detector/appearance.py's REGION_LEN. */
export const REGION_LENGTH = 72;

/**
 * 145 numbers: [0..72) upper-body histogram, [72..144) lower-body histogram,
 * [144] the box's aspect ratio. Never anything else — in particular, never a
 * pixel, a crop, or a box: this file only ever sees what detector/appearance.py
 * already reduced a detection to.
 */
export type Signature = readonly number[];

/**
 * Whether `raw` is a real signature: an array of EXACTLY SIGNATURE_LENGTH
 * finite numbers. Anything else — wrong length, a non-number, NaN, Infinity,
 * a string, an object — is not a signature, full stop; there is no partial
 * or "close enough" acceptance here (build rule 10).
 */
export function isValidSignature(raw: unknown): raw is Signature {
  if (!Array.isArray(raw) || raw.length !== SIGNATURE_LENGTH) return false;
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- similarity

/**
 * MANAGER-RULES-SPEC.md's own weights: "the overall figure is 0.6 x upper +
 * 0.4 x lower". Upper body (shirt, the largest, least-occluded area) counts
 * for more than lower body (often behind a desk or a counter).
 */
export const SIMILARITY_UPPER_WEIGHT = 0.6;
export const SIMILARITY_LOWER_WEIGHT = 0.4;

/**
 * The Bhattacharyya coefficient of two same-length histograms: sum(sqrt(p_i *
 * q_i)), clamped to [0, 1]. In exact arithmetic, two L1-normalised
 * distributions give a coefficient already in [0, 1] (Cauchy-Schwarz) — the
 * clamp exists only because detector/appearance.py's histograms are each
 * rounded to 3 decimal places before they ever reach here, so their true sum
 * can land a hair off 1, and the coefficient can land a hair off its own
 * bound. Symmetric in p and q by construction (multiplication commutes).
 */
function bhattacharyyaCoefficient(p: readonly number[], q: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const product = (p[i] as number) * (q[i] as number);
    if (product > 0) sum += Math.sqrt(product);
  }
  return sum < 0 ? 0 : sum > 1 ? 1 : sum;
}

/**
 * How well two build (aspect-ratio) readings agree, as a factor in [0, 1]:
 * the smaller over the larger, so it is 1 when they match exactly, falls off
 * symmetrically as they diverge, and is 0 when either is not a positive
 * number (a degenerate box's aspect ratio agrees with nothing, rather than
 * comparing as if it were a real one).
 */
function aspectAgreement(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0;
  return a <= b ? a / b : b / a;
}

/**
 * The overall similarity of two signatures, as a percentage: a Bhattacharyya
 * coefficient per region (0.6 upper + 0.4 lower), times an aspect-agreement
 * factor, times 100 — MANAGER-RULES-SPEC.md's own formula. Symmetric (every
 * piece of it is), and bounded 0..100 by construction (each factor is
 * separately clamped to [0, 1] before they are combined and clamped once
 * more). Throws on a malformed signature rather than guessing a number for
 * one — a caller reaches this only after isValidSignature (or an equivalent
 * check) has already passed, the same discipline travelFrom keeps for an
 * unchecked box.
 */
export function similarity(a: Signature, b: Signature): number {
  if (!isValidSignature(a) || !isValidSignature(b)) {
    throw new TypeError("similarity: both signatures must be exactly SIGNATURE_LENGTH finite numbers");
  }
  const upperA = a.slice(0, REGION_LENGTH);
  const lowerA = a.slice(REGION_LENGTH, REGION_LENGTH * 2);
  const aspectA = a[SIGNATURE_LENGTH - 1] as number;
  const upperB = b.slice(0, REGION_LENGTH);
  const lowerB = b.slice(REGION_LENGTH, REGION_LENGTH * 2);
  const aspectB = b[SIGNATURE_LENGTH - 1] as number;

  const combined = SIMILARITY_UPPER_WEIGHT * bhattacharyyaCoefficient(upperA, upperB) +
    SIMILARITY_LOWER_WEIGHT * bhattacharyyaCoefficient(lowerA, lowerB);
  const percent = combined * aspectAgreement(aspectA, aspectB) * 100;
  return percent < 0 ? 0 : percent > 100 ? 100 : percent;
}

// ---------------------------------------------------------------- the median signature

/**
 * The element-wise median of one or more signatures — "the element-wise
 * median of that person's signatures during the stretch" (MANAGER-RULES-
 * SPEC.md). Null for an empty list (never a guessed all-zero signature —
 * build rule 5's cousin: no signatures is not a signature of all zeros).
 * Throws if any input is not a real signature, rather than silently
 * skipping it and quietly changing what "the median" means.
 */
export function medianSignature(signatures: readonly Signature[]): Signature | null {
  if (signatures.length === 0) return null;
  for (const s of signatures) {
    if (!isValidSignature(s)) {
      throw new TypeError("medianSignature: every signature must be exactly SIGNATURE_LENGTH finite numbers");
    }
  }
  const out: number[] = new Array(SIGNATURE_LENGTH);
  for (let i = 0; i < SIGNATURE_LENGTH; i++) {
    const values = signatures.map((s) => s[i] as number).sort((x, y) => x - y);
    const mid = Math.floor(values.length / 2);
    out[i] = values.length % 2 === 1
      ? (values[mid] as number)
      : ((values[mid - 1] as number) + (values[mid] as number)) / 2;
  }
  return out;
}

// ---------------------------------------------------------------- learning today's manager

/** "At least 20 signatures, or it is not learned yet" (MANAGER-RULES-SPEC.md). */
export const MIN_SIGNATURES_TO_LEARN = 20;
/** "A second person with at least 30 minutes of desk presence in the first two hours". */
export const SECOND_MANAGER_MIN_PRESENCE_MINUTES = 30;
/** "...and a signature under 60% similarity to the first". */
export const SECOND_MANAGER_MAX_SIMILARITY_PERCENT = 60;

/**
 * One person's own contribution to a learning window: everything gathered
 * for one continuous track (contracts/detectStream.ts's fold event id —
 * "linked to that person's own detections through the detection fold's
 * event id", MANAGER-RULES-SPEC.md), scoped to whichever window the caller
 * is asking about (the first open hour for the primary manager, the first
 * two hours for the rare second one). This file does not itself decide WHICH
 * detections fall inside a window or how long a desk presence lasted — that
 * judgement belongs to whoever correlates occupancy.ts's own presence
 * tracking with this event id (agent/ code, not a pure contract) — it only
 * ever consumes the result: a desk-presence duration and the signatures
 * collected alongside it.
 */
export interface PersonSignatureRun {
  /** The detection fold's own event id for this person's track. */
  eventId: string;
  /** How long this person was present at the manager's desk, within the window, in ms. */
  deskPresenceMs: number;
  /** Every non-null signature computed for this person's detections in the window. */
  signatures: Signature[];
}

export type ManagerLearnFailureReason = "no_runs" | "too_few_signatures";

export type PrimaryManagerLearnResult =
  | { ok: true; signature: Signature; fromEventId: string; signatureCount: number }
  | { ok: false; reason: ManagerLearnFailureReason };

/**
 * The primary manager: "the person present longest inside the area named as
 * the manager's desk" in the first open hour. Picks the run with the longest
 * `deskPresenceMs`; refuses ("no_runs") when there is nothing to pick from,
 * or ("too_few_signatures") when even the longest run has fewer than
 * MIN_SIGNATURES_TO_LEARN — in either case the caller keeps trying on later
 * calls (the window is not over yet) rather than being handed a guess.
 */
export function learnPrimaryManager(runs: readonly PersonSignatureRun[]): PrimaryManagerLearnResult {
  if (runs.length === 0) return { ok: false, reason: "no_runs" };
  let longest = runs[0] as PersonSignatureRun;
  for (const r of runs) {
    if (r.deskPresenceMs > longest.deskPresenceMs) longest = r;
  }
  if (longest.signatures.length < MIN_SIGNATURES_TO_LEARN) {
    return { ok: false, reason: "too_few_signatures" };
  }
  return {
    ok: true,
    signature: medianSignature(longest.signatures) as Signature,
    fromEventId: longest.eventId,
    signatureCount: longest.signatures.length,
  };
}

export type SecondManagerFailureReason = "no_candidate" | "too_few_signatures" | "too_similar";

export type SecondManagerLearnResult =
  | { ok: true; signature: Signature; fromEventId: string; signatureCount: number; similarityToFirstPercent: number }
  | { ok: false; reason: SecondManagerFailureReason };

/**
 * "A rare second manager: a second person with at least 30 minutes of desk
 * presence in the first two hours, and a signature under 60% similarity to
 * the first." Candidates are every run OTHER than the primary's own event,
 * with at least SECOND_MANAGER_MIN_PRESENCE_MINUTES of desk presence; among
 * those, the longest-present one is the candidate — the same "longest
 * presence" rule the primary itself used, applied to whoever is left.
 * Refused ("too_similar") when that candidate's own median signature is NOT
 * under the 60% ceiling: a similar reading is read as the SAME manager under
 * different lighting, never as a second person (this file's own stated
 * failure to guard against).
 */
export function learnSecondManager(
  runs: readonly PersonSignatureRun[],
  primaryEventId: string,
  primarySignature: Signature,
): SecondManagerLearnResult {
  const minPresenceMs = SECOND_MANAGER_MIN_PRESENCE_MINUTES * 60_000;
  const candidates = runs.filter((r) => r.eventId !== primaryEventId && r.deskPresenceMs >= minPresenceMs);
  if (candidates.length === 0) return { ok: false, reason: "no_candidate" };
  let longest = candidates[0] as PersonSignatureRun;
  for (const r of candidates) {
    if (r.deskPresenceMs > longest.deskPresenceMs) longest = r;
  }
  if (longest.signatures.length < MIN_SIGNATURES_TO_LEARN) {
    return { ok: false, reason: "too_few_signatures" };
  }
  const signature = medianSignature(longest.signatures) as Signature;
  const similarityToFirstPercent = similarity(primarySignature, signature);
  if (similarityToFirstPercent >= SECOND_MANAGER_MAX_SIMILARITY_PERCENT) {
    return { ok: false, reason: "too_similar" };
  }
  return { ok: true, signature, fromEventId: longest.eventId, signatureCount: longest.signatures.length, similarityToFirstPercent };
}

export type LearnTodaysManagerFailureReason = "no_open_hours" | ManagerLearnFailureReason;

export type LearnTodaysManagerResult =
  | {
      ok: true;
      primary: { signature: Signature; fromEventId: string; signatureCount: number };
      secondary: { signature: Signature; fromEventId: string; signatureCount: number; similarityToFirstPercent: number } | null;
    }
  | { ok: false; reason: LearnTodaysManagerFailureReason };

/**
 * The whole of "Learning today's manager (automatic)": refuses outright
 * ("no_open_hours") when the site has no openHours at all — "it needs
 * openHours; without them, today's manager is not learned and the page says
 * why" — before ever looking at a single run. Otherwise learns the primary
 * from `runsFirstHour` and, only once that succeeds, the rare second manager
 * from `runsFirstTwoHours` (a superset window: the first two hours contain
 * the first hour). A missing second manager is not a failure of this
 * function — `secondary: null` is the ordinary, most-common outcome ("very
 * rarely two").
 */
export function learnTodaysManager(
  openHours: Schedule | null,
  runsFirstHour: readonly PersonSignatureRun[],
  runsFirstTwoHours: readonly PersonSignatureRun[],
): LearnTodaysManagerResult {
  if (openHours === null) return { ok: false, reason: "no_open_hours" };
  const primary = learnPrimaryManager(runsFirstHour);
  if (!primary.ok) return primary;
  const secondary = learnSecondManager(runsFirstTwoHours, primary.fromEventId, primary.signature);
  return {
    ok: true,
    primary: { signature: primary.signature, fromEventId: primary.fromEventId, signatureCount: primary.signatureCount },
    secondary: secondary.ok
      ? {
          signature: secondary.signature,
          fromEventId: secondary.fromEventId,
          signatureCount: secondary.signatureCount,
          similarityToFirstPercent: secondary.similarityToFirstPercent,
        }
      : null,
  };
}

// ---------------------------------------------------------------- the today-file

export const APPEARANCE_TODAY_VERSION = 1;

const APPEARANCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `<stateDir>/appearance-today.json` (0600). `date` is the LOCAL date (site
 * tz) this file was learned for — never UTC — because the deletion rule
 * ("at local midnight, and on any start where its date is not today") only
 * means anything measured in the site's own day.
 */
export interface AppearanceTodayFile {
  version: 1;
  date: string;
  primary: Signature;
  secondary: Signature | null;
  learnedAtUtc: string;
}

export interface FieldProblem {
  field: string;
  reason: string;
}

export type AppearanceTodayFileCheck = { ok: true; file: AppearanceTodayFile } | { ok: false; errors: FieldProblem[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a stored (or about-to-be-stored) appearance-today.json, listing
 * every problem at once. `secondary` may be `null` (no second manager
 * learned — the common case) but, when present, must be a real signature
 * just like `primary`; there is no partial acceptance of one field while the
 * other is silently dropped.
 */
export function checkAppearanceTodayFile(raw: unknown): AppearanceTodayFileCheck {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "file", reason: "not_an_object" }] };
  }
  const errors: FieldProblem[] = [];

  if (raw.version !== APPEARANCE_TODAY_VERSION) {
    errors.push({ field: "version", reason: "bad_version" });
  }

  let date: string | null = null;
  if (typeof raw.date !== "string" || !APPEARANCE_DATE_PATTERN.test(raw.date)) {
    errors.push({ field: "date", reason: "bad_date" });
  } else {
    date = raw.date;
  }

  let primary: Signature | null = null;
  if (!isValidSignature(raw.primary)) {
    errors.push({ field: "primary", reason: "bad_signature" });
  } else {
    primary = raw.primary;
  }

  let secondary: Signature | null = null;
  let secondaryOk = true;
  if (raw.secondary !== null) {
    if (!isValidSignature(raw.secondary)) {
      errors.push({ field: "secondary", reason: "bad_signature" });
      secondaryOk = false;
    } else {
      secondary = raw.secondary;
    }
  }

  let learnedAtUtc: string | null = null;
  if (typeof raw.learnedAtUtc !== "string") {
    errors.push({ field: "learnedAtUtc", reason: "bad_time" });
  } else {
    try {
      parseUtc(raw.learnedAtUtc);
      learnedAtUtc = raw.learnedAtUtc;
    } catch {
      errors.push({ field: "learnedAtUtc", reason: "bad_time" });
    }
  }

  if (errors.length > 0 || date === null || primary === null || !secondaryOk || learnedAtUtc === null) {
    return { ok: false, errors };
  }
  return { ok: true, file: { version: APPEARANCE_TODAY_VERSION, date, primary, secondary, learnedAtUtc } };
}

/**
 * Whether `file` is stale and must be deleted / relearned: "DELETED at local
 * midnight, and on any start where its date is not today" — always measured
 * against the SITE's own time zone, never UTC or the machine's own zone.
 */
export function isAppearanceTodayStale(file: Pick<AppearanceTodayFile, "date">, timeZone: string, nowUtc: string): boolean {
  const today = localParts(timeZone, parseUtc(nowUtc)).date;
  return file.date !== today;
}

// ---------------------------------------------------------------- matching

/** "The threshold is a per-site setting, default 80%." (contracts/siteSettings.ts's own `appearanceMatchPercent`.) */
export const DEFAULT_APPEARANCE_MATCH_PERCENT = 80;

export type AppearanceMatchDecision =
  | { match: true; which: "primary" | "secondary"; similarityPercent: number }
  | { match: false; similarityPercent: number };

/**
 * "On each person detection on any camera, detect-service compares the
 * signature with today's. At or above the match threshold, that detection
 * is a 'manager match' with its %." Checked against BOTH today's signatures
 * when a second manager was learned, and the BETTER of the two wins — a
 * detection that matches either manager is a manager match, and the report
 * says which one (never by name — `which` is only ever "primary" or
 * "secondary", an index into today's own file, not an identity).
 */
export function matchAppearance(
  detectionSignature: Signature,
  today: Pick<AppearanceTodayFile, "primary" | "secondary">,
  thresholdPercent: number,
): AppearanceMatchDecision {
  let best: { which: "primary" | "secondary"; sim: number } = { which: "primary", sim: similarity(detectionSignature, today.primary) };
  if (today.secondary !== null) {
    const simSecondary = similarity(detectionSignature, today.secondary);
    if (simSecondary > best.sim) best = { which: "secondary", sim: simSecondary };
  }
  if (best.sim >= thresholdPercent) {
    return { match: true, which: best.which, similarityPercent: best.sim };
  }
  return { match: false, similarityPercent: best.sim };
}
