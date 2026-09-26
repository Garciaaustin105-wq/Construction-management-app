/**
 * Per-camera AI settings: zones, schedule, sensitivity, kinds.
 * CAMERA-AI-SETTINGS-SPEC.md, phase 4 round 1. Pure: no I/O, no clock of its
 * own — every "now" is passed in, and the caller (agent/detect-service.mjs)
 * re-reads camera-ai.json and calls in.
 *
 * THE FEARED FAILURES:
 * - a blank read as a zero: an installer who never touched a field must get
 *   the SAME behaviour as before this feature existed (whole frame, always
 *   watching, camera default, both kinds) — never "0 confidence", "empty
 *   schedule = never open", or "no kinds = nothing detected" (build rule 5);
 * - a minimum confidence saved below the site's storing floor: the worker
 *   never keeps what the floor already dropped, so a camera "watching" below
 *   it would be watching for events that can never arrive (build rule 12's
 *   sibling: this is licensed-adjacent enough that a wrong number here reads
 *   as "it's more sensitive" when it is actually inert);
 * - the first bad field found hiding every other one from the installer, so
 *   they fix it, save again, and hit the next problem one at a time;
 * - a detection HIDDEN read as a detection DELETED — build rule 13's "nothing
 *   auto-applies" does not apply to this file the way it does not apply to
 *   known objects (Austin's call is the same shape: a setting decides
 *   automatically, and the belt is that hiding is always a flag, never a
 *   drop) — but nobody clicks to approve a zone or a schedule, so the file
 *   must never let a setting destroy what a human never saw;
 * - a point exactly on a zone's edge going either way depending on which side
 *   of a rounding error it fell on (unlike alertRules.ts's own zone test,
 *   this spec asks for an edge to count as inside, so this file cannot just
 *   reuse that ray cast unmodified — see pointInZone).
 *
 * WHAT `Box` ALREADY IS (found, not guessed, per build rule 22 — this feature
 * does not get to invent new units for numbers that already have one):
 * `contracts/detection.ts`'s `Box` — the shape of every `DetectionEvent.bestBox`
 * — is a fraction of the frame's width and height (0..1), not a pixel
 * rectangle: "A box in the frame, as fractions of its width and height
 * (0..1)." `agent/events-db.mjs` stores and reads back the same four numbers
 * unchanged (`best_x..best_h`, "Unlike species... these two are always
 * PRESENT"), and `contracts/alertRules.ts`'s own zone test computes the feet
 * point straight from those fractions with no division by any frame size at
 * all: `px = event.bestBox.x + event.bestBox.w / 2`, `py = event.bestBox.y +
 * event.bestBox.h`. So `boxGroundPointFraction`'s `frameSize` argument below
 * is accepted and CHECKED — a real frame, the same `{ width, height }` in
 * PIXELS that `contracts/eventThumb.ts`'s `FrameSize` already uses for
 * drawing a mark on a still — but it is never used to rescale the point,
 * because the box is already resolution-independent. Multiplying by a frame
 * size and never using the product would be a silent no-op at best and a
 * wrong-unit bug at worst (build rule 6) if some future caller ever mixed a
 * pixel box in without noticing; refusing an unreadable frame outright is the
 * cheap insurance against that, not a use of the number.
 */

import { parseUtc } from "./time.js";
import type { Box, EventKind } from "./detection.js";
import { checkRule, isOpen } from "./alertRules.js";
import type { Schedule } from "./alertRules.js";

// ---------------------------------------------------------------- constants

/** Minimum confidence: 0.30 to 0.90 in steps of 0.05 ("The zone test" / "Minimum confidence"). */
export const MIN_CONFIDENCE = 0.3;
export const MAX_CONFIDENCE = 0.9;
export const CONFIDENCE_STEP = 0.05;

/** "A zone has 3 to 32 points; there are at most 8 zones per camera." */
export const MIN_ZONE_POINTS = 3;
export const MAX_ZONE_POINTS = 32;
export const MAX_ZONES = 8;

export const CAMERA_AI_SETTINGS_VERSION = 1;

// ---------------------------------------------------------------- shapes

export type ZoneMode = "watch" | "ignore";

/** A zone drawn over the still: at least 3, at most 32 points, frame fractions (0..1). */
export interface Zone {
  id: string;
  mode: ZoneMode;
  points: Array<[number, number]>;
}

export interface CameraKinds {
  person: boolean;
  vehicle: boolean;
}

/**
 * One camera's settings, always fully populated — never a field left out to
 * mean "unset". `null` IS the unset value where the spec calls for one
 * (schedule: always; minConfidence: site default), so a reader never has to
 * guess whether an absent key meant zero or was never asked.
 */
export interface CameraAiSettings {
  /** Empty: the whole frame is watched (build rule 5 — no zones is not "watch nothing"). */
  zones: Zone[];
  /** null: always (no schedule restriction). */
  schedule: Schedule | null;
  /** null: inherit the site's storing floor. Otherwise MIN_CONFIDENCE..MAX_CONFIDENCE on CONFIDENCE_STEP, and never below the floor passed in at save time. */
  minConfidence: number | null;
  kinds: CameraKinds;
}

/** As stored in camera-ai.json's `cameras[cameraId]`. */
export interface StoredCameraAiSettings extends CameraAiSettings {
  updatedUtc: string;
  updatedBy: string;
}

export interface CameraAiSettingsFile {
  version: 1;
  cameras: Record<string, StoredCameraAiSettings>;
}

/** "Whole frame, always, inherit, both kinds" — the behaviour before this feature existed. */
export const DEFAULT_CAMERA_AI_SETTINGS: Readonly<CameraAiSettings> = Object.freeze({
  zones: Object.freeze([]) as unknown as Zone[],
  schedule: null,
  minConfidence: null,
  kinds: Object.freeze({ person: true, vehicle: true }),
});

function defaultSettings(): CameraAiSettings {
  return { zones: [], schedule: null, minConfidence: null, kinds: { person: true, vehicle: true } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  try {
    const j = JSON.stringify(v);
    return j === undefined ? String(v) : j;
  } catch {
    return String(v);
  }
}

function checkFloor(floor: unknown, who: string): number {
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    // A bad floor is a caller bug (it comes from detect.json, already
    // validated by detect-service.mjs before this is ever called), not data
    // an installer typed — the same discipline as knownObjects.ts's
    // checkCeiling: a typo here must not quietly turn the floor off.
    throw new TypeError(`${who}: floor must be a number 0..1 (detect.json's minConfidence), got ${describe(floor)}`);
  }
  return floor;
}

// ---------------------------------------------------------------- validation

export interface FieldProblem {
  /** "zones", "zones[2].mode", "schedule", "minConfidence", "kinds.person", ... */
  field: string;
  reason: string;
}

export type CameraSettingsCheck = { ok: true; settings: CameraAiSettings } | { ok: false; errors: FieldProblem[] };

function checkZones(raw: unknown, errors: FieldProblem[]): Zone[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field: "zones", reason: "not_an_array" });
    return [];
  }
  if (raw.length > MAX_ZONES) {
    errors.push({ field: "zones", reason: "too_many_zones" });
  }
  const zones: Zone[] = [];
  const ids = new Set<string>();
  raw.forEach((z: unknown, i: number) => {
    const field = `zones[${i}]`;
    if (!isRecord(z)) {
      errors.push({ field, reason: "not_an_object" });
      return;
    }
    let ok = true;
    if (typeof z.id !== "string" || z.id === "") {
      errors.push({ field: `${field}.id`, reason: "bad_zone_id" });
      ok = false;
    } else if (ids.has(z.id)) {
      errors.push({ field: `${field}.id`, reason: "duplicate_zone_id" });
      ok = false;
    } else {
      ids.add(z.id);
    }
    if (z.mode !== "watch" && z.mode !== "ignore") {
      errors.push({ field: `${field}.mode`, reason: "bad_zone_mode" });
      ok = false;
    }
    const pts = z.points;
    if (!Array.isArray(pts) || pts.length < MIN_ZONE_POINTS || pts.length > MAX_ZONE_POINTS) {
      errors.push({ field: `${field}.points`, reason: "bad_zone_point_count" });
      ok = false;
    } else {
      pts.forEach((p: unknown, j: number) => {
        if (
          !Array.isArray(p) ||
          p.length !== 2 ||
          typeof p[0] !== "number" ||
          !Number.isFinite(p[0]) ||
          p[0] < 0 ||
          p[0] > 1 ||
          typeof p[1] !== "number" ||
          !Number.isFinite(p[1]) ||
          p[1] < 0 ||
          p[1] > 1
        ) {
          errors.push({ field: `${field}.points[${j}]`, reason: "bad_zone_point" });
          ok = false;
        }
      });
    }
    if (ok) {
      zones.push({
        id: z.id as string,
        mode: z.mode as ZoneMode,
        points: (pts as unknown[]).map((p) => [(p as [number, number])[0], (p as [number, number])[1]] as [number, number]),
      });
    }
  });
  return zones;
}

/**
 * Reuse alertRules.ts's own schedule checks (build rule: one owner for this
 * logic) by handing its `checkRule` a synthetic rule that is valid in every
 * field except `schedule` — so the only reasons it can come back with are the
 * schedule ones (bad_time_zone, bad_hours, bad_closed_date), never a rule
 * problem this file invented meanings for.
 */
function checkSchedule(raw: unknown, errors: FieldProblem[]): Schedule | null {
  if (raw === undefined || raw === null) return null;
  const dummy = {
    id: "camera-ai-settings",
    cameraIds: ["x"],
    kinds: ["person"],
    minConfidence: 0.5,
    schedule: raw,
    zones: [],
    cooldownSeconds: 0,
  };
  const result = checkRule(dummy);
  if (!result.ok) {
    errors.push({ field: "schedule", reason: result.reason });
    return null;
  }
  const s = raw as Schedule;
  return {
    timeZone: s.timeZone,
    weekly: s.weekly.map((day) => day.map((iv) => ({ open: iv.open, close: iv.close }))),
    closedDates: [...s.closedDates],
  };
}

function checkMinConfidence(raw: unknown, floor: number, errors: FieldProblem[]): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    errors.push({ field: "minConfidence", reason: "bad_confidence" });
    return null;
  }
  if (raw < MIN_CONFIDENCE - 1e-9 || raw > MAX_CONFIDENCE + 1e-9) {
    errors.push({ field: "minConfidence", reason: "bad_confidence_range" });
    return null;
  }
  const steps = (raw - MIN_CONFIDENCE) / CONFIDENCE_STEP;
  const rounded = Math.round(steps);
  if (Math.abs(steps - rounded) > 1e-6) {
    errors.push({ field: "minConfidence", reason: "bad_confidence_step" });
    return null;
  }
  // Killed float noise (0.30 + 0.05*n does not always land on a clean decimal).
  const normalized = Math.round((MIN_CONFIDENCE + rounded * CONFIDENCE_STEP) * 1e6) / 1e6;
  // "It is never below the floor, because the worker does not keep what the
  // floor drops" — checked against the floor the CALLER passed in (the site's
  // detect.json minConfidence at save time), not guessed at.
  if (normalized < floor - 1e-9) {
    errors.push({ field: "minConfidence", reason: "below_storing_floor" });
    return null;
  }
  return normalized;
}

function checkKinds(raw: unknown, errors: FieldProblem[]): CameraKinds {
  if (raw === undefined) return { person: true, vehicle: true };
  if (!isRecord(raw)) {
    errors.push({ field: "kinds", reason: "not_an_object" });
    return { person: true, vehicle: true };
  }
  const extra = Object.keys(raw).filter((k) => k !== "person" && k !== "vehicle");
  if (extra.length > 0) errors.push({ field: "kinds", reason: "unknown_field" });
  const personOk = typeof raw.person === "boolean";
  const vehicleOk = typeof raw.vehicle === "boolean";
  if (!personOk) errors.push({ field: "kinds.person", reason: "bad_kind_flag" });
  if (!vehicleOk) errors.push({ field: "kinds.vehicle", reason: "bad_kind_flag" });
  if (personOk && vehicleOk && extra.length === 0) {
    return { person: raw.person as boolean, vehicle: raw.vehicle as boolean };
  }
  // A half-written kinds object (one flag given, the other missing) is not a
  // measurement of what the installer wants for the field that IS missing —
  // build rule 5 again, this time inside one field rather than across the
  // whole camera. Refused as a whole rather than guessed at per-flag.
  return { person: true, vehicle: true };
}

/**
 * Validate one camera's settings against the spec, returning EVERY problem —
 * not the first (the install page shows them all at once, not one fix-and-
 * resave at a time). `raw` absent or null validates as the defaults (a
 * missing camera behaves exactly as one that was never configured).
 *
 * `floor` is the site's storing floor (detect.json's minConfidence) at save
 * time — a trusted number the caller passes in, not something read from
 * `raw`; a camera's minConfidence can never be saved below it.
 */
export function checkCameraAiSettings(raw: unknown, floor: number): CameraSettingsCheck {
  checkFloor(floor, "checkCameraAiSettings");
  if (raw === undefined || raw === null) {
    return { ok: true, settings: defaultSettings() };
  }
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "camera", reason: "not_an_object" }] };
  }
  const errors: FieldProblem[] = [];
  const zones = checkZones(raw.zones, errors);
  const schedule = checkSchedule(raw.schedule, errors);
  const minConfidence = checkMinConfidence(raw.minConfidence, floor, errors);
  const kinds = checkKinds(raw.kinds, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { zones, schedule, minConfidence, kinds } };
}

export interface FileFieldProblem extends FieldProblem {
  /** "" for a file-level problem (bad version, cameras not an object). */
  cameraId: string;
}

export type CameraAiSettingsFileCheck =
  | { ok: true; file: CameraAiSettingsFile }
  | { ok: false; errors: FileFieldProblem[] };

/**
 * Validate the whole stored file against the spec — every camera, every
 * problem. A camera entry that fails checkCameraAiSettings never reaches
 * updatedUtc/updatedBy (their errors would only add noise once the settings
 * themselves are already refused).
 */
export function checkCameraAiSettingsFile(raw: unknown, floor: number): CameraAiSettingsFileCheck {
  checkFloor(floor, "checkCameraAiSettingsFile");
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ cameraId: "", field: "file", reason: "not_an_object" }] };
  }
  const errors: FileFieldProblem[] = [];
  if (raw.version !== CAMERA_AI_SETTINGS_VERSION) {
    errors.push({ cameraId: "", field: "version", reason: "bad_version" });
  }
  const camerasRaw = raw.cameras;
  if (!isRecord(camerasRaw)) {
    errors.push({ cameraId: "", field: "cameras", reason: "not_an_object" });
    return { ok: false, errors };
  }
  const cameras: Record<string, StoredCameraAiSettings> = {};
  for (const [cameraId, entry] of Object.entries(camerasRaw)) {
    if (!isRecord(entry)) {
      errors.push({ cameraId, field: "camera", reason: "not_an_object" });
      continue;
    }
    const check = checkCameraAiSettings(entry, floor);
    if (!check.ok) {
      for (const problem of check.errors) errors.push({ cameraId, ...problem });
      continue;
    }
    let updatedUtc: string | null = null;
    if (typeof entry.updatedUtc === "string") {
      try {
        parseUtc(entry.updatedUtc);
        updatedUtc = entry.updatedUtc;
      } catch {
        updatedUtc = null;
      }
    }
    if (updatedUtc === null) {
      errors.push({ cameraId, field: "updatedUtc", reason: "bad_time" });
      continue;
    }
    if (typeof entry.updatedBy !== "string" || entry.updatedBy.trim() === "") {
      errors.push({ cameraId, field: "updatedBy", reason: "bad_actor" });
      continue;
    }
    cameras[cameraId] = { ...check.settings, updatedUtc, updatedBy: entry.updatedBy };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, file: { version: CAMERA_AI_SETTINGS_VERSION, cameras } };
}

/** One camera's settings from a validated file, or the defaults when it has none yet. */
export function settingsForCamera(file: CameraAiSettingsFile, cameraId: string): CameraAiSettings {
  const stored = file.cameras[cameraId];
  if (stored === undefined) return defaultSettings();
  return {
    zones: stored.zones.map((z) => ({ id: z.id, mode: z.mode, points: z.points.map(([x, y]) => [x, y] as [number, number]) })),
    schedule: stored.schedule === null ? null : { timeZone: stored.schedule.timeZone, weekly: stored.schedule.weekly.map((d) => d.map((iv) => ({ ...iv }))), closedDates: [...stored.schedule.closedDates] },
    minConfidence: stored.minConfidence,
    kinds: { ...stored.kinds },
  };
}

const SETTINGS_FIELDS = ["zones", "schedule", "minConfidence", "kinds"] as const;

/** Names of the fields that differ, for the audit line — never the values (build rule: never a URL, never a credential; here, simply never the picture). */
export function diffCameraAiSettings(before: CameraAiSettings, after: CameraAiSettings): string[] {
  return SETTINGS_FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// ---------------------------------------------------------------- geometry

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The point a detection is judged by: the bottom-centre of its best box, in
 * frame fractions. Box units are established at the top of this file — the
 * box already IS a frame fraction, so this is arithmetic, not a conversion.
 */
function groundPointOfBox(box: Box): { x: number; y: number } {
  return { x: clamp01(box.x + box.w / 2), y: clamp01(box.y + box.h) };
}

export interface FrameSize {
  width: number;
  height: number;
}

export type GroundPointCheck = { ok: true; x: number; y: number } | { ok: false; reason: "bad_box" | "bad_frame" };

function readableFrameSize(f: unknown): f is FrameSize {
  if (!isRecord(f)) return false;
  const { width, height } = f as Record<string, unknown>;
  return typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1;
}

function readableBoxFraction(b: unknown): b is Box {
  if (!isRecord(b)) return false;
  const box = b as Record<string, unknown>;
  for (const v of [box.x, box.y, box.w, box.h]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  const x = box.x as number;
  const y = box.y as number;
  const w = box.w as number;
  const h = box.h as number;
  return w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= 1.0001 && y + h <= 1.0001;
}

/**
 * The bottom-centre of `box` as a frame fraction. `frameSize` is a real,
 * positive frame in pixels (eventThumb.ts's own `FrameSize` shape) — checked,
 * because a point measured against a frame nobody can point to is not a
 * measurement, but never used to rescale the result: see the file header for
 * why the box needs no such conversion in this codebase.
 */
export function boxGroundPointFraction(box: unknown, frameSize: unknown): GroundPointCheck {
  if (!readableFrameSize(frameSize)) return { ok: false, reason: "bad_frame" };
  if (!readableBoxFraction(box)) return { ok: false, reason: "bad_box" };
  const p = groundPointOfBox(box);
  return { ok: true, x: p.x, y: p.y };
}

const EDGE_EPS = 1e-9;

/** Whether (px, py) sits on the closed segment [a, b], within floating tolerance. */
function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (Math.abs(cross) > EDGE_EPS) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < -EDGE_EPS) return false;
  const lenSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  if (dot - lenSq > EDGE_EPS) return false;
  return true;
}

/**
 * Point-in-polygon, even-odd, concave shapes allowed, a point exactly on an
 * edge counts as inside — unlike alertRules.ts's zone test (whose own comment
 * says an edge point "may go either way"), this spec calls for edge-inclusive
 * explicitly, so edges are checked first and directly, before the ray cast
 * that decides the interior.
 */
export function pointInZone(x: number, y: number, points: readonly (readonly [number, number])[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = points[i] as readonly [number, number];
    const b = points[(i + 1) % n] as readonly [number, number];
    if (onSegment(x, y, a[0], a[1], b[0], b[1])) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = points[i] as readonly [number, number];
    const pj = points[j] as readonly [number, number];
    const xi = pi[0];
    const yi = pi[1];
    const xj = pj[0];
    const yj = pj[1];
    if (yi > y !== yj > y) {
      const xIntersect = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

export type ZoneVerdict = "visible" | "hidden";

/**
 * "The zone judgement" (CAMERA-AI-SETTINGS-SPEC.md):
 * 1. inside an ignore zone: hidden;
 * 2. otherwise, watch zones exist and the point is inside none of them: hidden;
 * 3. otherwise: visible. No watch zones at all means the whole frame counts.
 */
export function zoneVerdict(zones: readonly Zone[], point: { x: number; y: number }): ZoneVerdict {
  const ignore = zones.filter((z) => z.mode === "ignore");
  const watch = zones.filter((z) => z.mode === "watch");
  for (const z of ignore) {
    if (pointInZone(point.x, point.y, z.points)) return "hidden";
  }
  if (watch.length > 0 && !watch.some((z) => pointInZone(point.x, point.y, z.points))) return "hidden";
  return "visible";
}

// ---------------------------------------------------------------- judging

export interface JudgeEvent {
  kind: EventKind;
  bestConfidence: number;
  bestBox: Box;
}

export type JudgeResult = { store: false } | { store: true; hiddenBy: null | "settings:zone" | "settings:kind" };

/**
 * Whether the detector may store this detection, and whether it is hidden.
 * Applied in this order, matching "Where it runs" (before the known-objects
 * check, in the event store step): minimum confidence, kinds, zones.
 *
 * `atUtcMs` is accepted for symmetry with `scheduleOpen` below (both are the
 * per-camera AI settings' "given this instant" entry points) but is not read
 * here: the schedule gate happens one level up, at the tick that decides
 * whether a camera's frames are folded into an event AT ALL ("outside the
 * schedule... frames are ignored: not folded, not stored") — by the time an
 * `event` exists to hand this function, it was already built from frames the
 * schedule allowed. Folding a second, redundant clock check into this
 * function's verdict would either silently duplicate that gate or invent a
 * new meaning for `{ store: false }` the spec never gives it (it names only
 * one reason: below the camera threshold) — refusing to guess (build rule 10)
 * rather than widening this return type on a hunch.
 */
export function judgeDetection(settings: CameraAiSettings, event: JudgeEvent, floor: number, atUtcMs: number): JudgeResult {
  checkFloor(floor, "judgeDetection");
  void atUtcMs;
  const threshold = settings.minConfidence === null ? floor : settings.minConfidence;
  if (event.bestConfidence < threshold) return { store: false };
  if (event.kind === "person" && !settings.kinds.person) return { store: true, hiddenBy: "settings:kind" };
  if (event.kind === "vehicle" && !settings.kinds.vehicle) return { store: true, hiddenBy: "settings:kind" };
  const point = groundPointOfBox(event.bestBox);
  if (zoneVerdict(settings.zones, point) === "hidden") return { store: true, hiddenBy: "settings:zone" };
  return { store: true, hiddenBy: null };
}

/**
 * Whether the AI is watching this camera at this instant. `null` schedule
 * means always (build rule 5 — no schedule is not "never open"); otherwise
 * alertRules.ts's own DST-safe `isOpen`, so a bar that runs its hours past
 * midnight or a spring-forward day behaves exactly as an alert rule's
 * schedule does — one clock, one set of rules, never re-derived here.
 */
export function scheduleOpen(settings: Pick<CameraAiSettings, "schedule">, atUtcMs: number): boolean {
  if (settings.schedule === null) return true;
  return isOpen(settings.schedule, atUtcMs);
}
