/**
 * Areas: named polygons an installer draws on one camera — "Manager's desk",
 * "Manager parking spot", "Back door" — that manager-rules judges presence
 * against. MANAGER-RULES-SPEC.md section 1. Pure: no I/O, no clock.
 *
 * THE FEARED FAILURES:
 * - a twelfth area on a busy camera silently accepted because validation only
 *   looked at the one area being saved, never at how many that camera
 *   already has (build rule 10: refuse rather than guess how many "already
 *   there" is);
 * - a seated person at a desk read as "outside" because only the detection's
 *   ground point (its feet) was tested — the desk hides the lower body, so
 *   the spec widens "inside" to a coverage test for exactly this case
 *   (`boxInsideArea` below);
 * - inventing a NEW edge rule for "on the line" here, when cameraAiSettings.ts
 *   already answered that question (edges count as inside) for the same
 *   frame-fraction geometry — `pointInZone` is imported, not re-derived.
 *
 * Reuses cameraAiSettings.ts's own zone-point bounds (MIN_ZONE_POINTS /
 * MAX_ZONE_POINTS) rather than inventing a second "how many points is
 * reasonable" answer, per "validated like zones" in the spec.
 */

import { pointInZone, MIN_ZONE_POINTS, MAX_ZONE_POINTS } from "./cameraAiSettings.js";
import type { Box } from "./detection.js";

export const MIN_AREA_POINTS = MIN_ZONE_POINTS;
export const MAX_AREA_POINTS = MAX_ZONE_POINTS;
/** "Up to 12 per camera" (MANAGER-RULES-SPEC.md section 1). */
export const MAX_AREAS_PER_CAMERA = 12;
export const AREAS_VERSION = 1;

/**
 * A closed vocabulary of one, deliberately: only "managerDesk" exists today
 * (APPEARANCE-OF-DAY-SPEC.md — "the person present longest inside the area
 * named as the manager's desk"). A future role is added here, not invented by
 * a caller passing an arbitrary string through.
 */
export type AreaRole = "managerDesk";
export const AREA_ROLES: readonly AreaRole[] = Object.freeze(["managerDesk"]);

/** A named polygon on one camera, frame fractions (0..1), like a camera-ai zone. */
export interface Area {
  id: string;
  cameraId: string;
  name: string;
  points: Array<[number, number]>;
  /** "At most one per site" (APPEARANCE-OF-DAY-SPEC.md) — see checkArea's own duplicate_role refusal. Absent: an ordinary area. */
  role?: AreaRole;
}

export interface AreasFile {
  version: 1;
  areas: Area[];
}

// ---------------------------------------------------------------- validation

export interface FieldProblem {
  /** "id", "cameraId", "name", "points", "points[2]", ... */
  field: string;
  reason: string;
}

export type AreaCheck = { ok: true; area: Area } | { ok: false; errors: FieldProblem[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkPoints(raw: unknown, errors: FieldProblem[]): Array<[number, number]> | null {
  if (!Array.isArray(raw) || raw.length < MIN_AREA_POINTS || raw.length > MAX_AREA_POINTS) {
    errors.push({ field: "points", reason: "bad_point_count" });
    return null;
  }
  let ok = true;
  const points: Array<[number, number]> = [];
  raw.forEach((p: unknown, i: number) => {
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
      errors.push({ field: `points[${i}]`, reason: "bad_point" });
      ok = false;
    } else {
      points.push([p[0], p[1]]);
    }
  });
  return ok ? points : null;
}

/**
 * Validate one area against the spec, listing every problem (build rule 10's
 * sibling: an installer fixing one field at a time is the failure this
 * avoids). `otherAreas` is every OTHER area already on file (the full set
 * minus this one, e.g. minus itself when editing an existing area) — used to
 * refuse a duplicate id and a thirteenth area on one camera. It is never
 * consulted to invent a meaning for a field this function does not itself
 * validate (camera and area existence elsewhere is the caller's job, not
 * this file's).
 */
export function checkArea(raw: unknown, otherAreas: readonly Area[]): AreaCheck {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "area", reason: "not_an_object" }] };
  }
  const errors: FieldProblem[] = [];

  let id: string | null = null;
  if (typeof raw.id !== "string" || raw.id === "") {
    errors.push({ field: "id", reason: "bad_id" });
  } else if (otherAreas.some((a) => a.id === raw.id)) {
    errors.push({ field: "id", reason: "duplicate_id" });
  } else {
    id = raw.id;
  }

  let cameraId: string | null = null;
  if (typeof raw.cameraId !== "string" || raw.cameraId === "") {
    errors.push({ field: "cameraId", reason: "bad_camera" });
  } else {
    cameraId = raw.cameraId;
    const onThisCamera = otherAreas.filter((a) => a.cameraId === cameraId).length;
    if (onThisCamera >= MAX_AREAS_PER_CAMERA) {
      errors.push({ field: "cameraId", reason: "too_many_areas" });
    }
  }

  let name: string | null = null;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    errors.push({ field: "name", reason: "bad_name" });
  } else {
    name = raw.name.trim();
  }

  const points = checkPoints(raw.points, errors);

  // role: absent is an ordinary area (the overwhelmingly common case) — never
  // required, never defaulted to a role nobody asked for. Present must be one
  // of AREA_ROLES, and "managerDesk" specifically must be unique across the
  // WHOLE site (otherAreas is the full set, not filtered to this camera —
  // "one manager per store" (APPEARANCE-OF-DAY-SPEC.md) means one desk, not
  // one per camera).
  let role: AreaRole | undefined;
  if (raw.role !== undefined) {
    if (typeof raw.role !== "string" || !(AREA_ROLES as readonly string[]).includes(raw.role)) {
      errors.push({ field: "role", reason: "bad_role" });
    } else if (raw.role === "managerDesk" && otherAreas.some((a) => a.role === "managerDesk")) {
      errors.push({ field: "role", reason: "duplicate_role" });
    } else {
      role = raw.role as AreaRole;
    }
  }

  if (errors.length > 0 || id === null || cameraId === null || name === null || points === null) {
    return { ok: false, errors };
  }
  const area: Area = { id, cameraId, name, points };
  if (role !== undefined) area.role = role;
  return { ok: true, area };
}

export interface IndexedFieldProblem extends FieldProblem {
  /** Position of the area in the file, for "which one" in the installer's UI. */
  index: number;
}

export type AreasFileCheck = { ok: true; file: AreasFile } | { ok: false; errors: IndexedFieldProblem[] };

/**
 * Validate the whole stored file. Each area is checked against every area
 * validated BEFORE it (so a duplicate id or a camera's 13th area is caught
 * wherever in the file it appears), never against the raw, unvalidated rest
 * of the array.
 */
export function checkAreasFile(raw: unknown): AreasFileCheck {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ index: -1, field: "file", reason: "not_an_object" }] };
  }
  const errors: IndexedFieldProblem[] = [];
  if (raw.version !== AREAS_VERSION) {
    errors.push({ index: -1, field: "version", reason: "bad_version" });
  }
  if (!Array.isArray(raw.areas)) {
    errors.push({ index: -1, field: "areas", reason: "not_an_array" });
    return { ok: false, errors };
  }
  const areas: Area[] = [];
  raw.areas.forEach((entry: unknown, index: number) => {
    const check = checkArea(entry, areas);
    if (!check.ok) {
      for (const problem of check.errors) errors.push({ index, ...problem });
      return;
    }
    areas.push(check.area);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, file: { version: AREAS_VERSION, areas } };
}

// ---------------------------------------------------------------- the inside test

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Sample points per row/column of the coverage grid ("Inside means... 40% ... on a 5x5 grid"). */
export const COVERAGE_GRID = 5;
/** The coverage share that counts as inside, even when the ground point does not. */
export const COVERAGE_THRESHOLD = 0.4;
const COVERAGE_EPS = 1e-9;

/**
 * Whether a detection's box counts as inside an area's polygon.
 * MANAGER-RULES-SPEC.md "Inside means": the bottom-centre point is in the
 * polygon, OR at least 40% of the box lies inside it, estimated on a 5x5 grid
 * of points — needed for a person seated at a desk whose lower body the desk
 * hides, so the ground point alone would read "outside" for someone plainly
 * there. Edge points count as inside (pointInZone, cameraAiSettings.ts).
 */
export function boxInsideArea(box: Box, points: readonly (readonly [number, number])[]): boolean {
  const groundX = clamp01(box.x + box.w / 2);
  const groundY = clamp01(box.y + box.h);
  if (pointInZone(groundX, groundY, points)) return true;
  let insideCount = 0;
  for (let iy = 0; iy < COVERAGE_GRID; iy++) {
    for (let ix = 0; ix < COVERAGE_GRID; ix++) {
      const fx = (ix + 0.5) / COVERAGE_GRID;
      const fy = (iy + 0.5) / COVERAGE_GRID;
      const px = clamp01(box.x + fx * box.w);
      const py = clamp01(box.y + fy * box.h);
      if (pointInZone(px, py, points)) insideCount++;
    }
  }
  const coverage = insideCount / (COVERAGE_GRID * COVERAGE_GRID);
  return coverage >= COVERAGE_THRESHOLD - COVERAGE_EPS;
}
