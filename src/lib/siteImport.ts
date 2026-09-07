import { distanceFt } from "@/lib/irrigationProducts";
import type { LatLng } from "@/lib/estimateAreas";

/**
 * Bring field measurements into an estimate: Moasure, a GNSS rover, a drone or
 * surveyor deliverable.
 *
 * DELIBERATELY NOT A DEVICE INTEGRATION. Every device in this category exports
 * the same two things — a CSV of points and a DXF — so this reads "a file of
 * surveyed points" and adding a device later is a documentation change rather
 * than a code change.
 *
 * Three failure modes drive the whole design. They are the reason this file is
 * shaped the way it is, and each is stated where it bites:
 *
 *   1. UNITS. A metres file read as feet is 3.28x on length and 10.76x on area,
 *      and it looks entirely plausible. Most exports declare no unit at all, so
 *      the unit is an explicit choice with NO default.
 *   2. COORDINATE FRAME. Moasure is inertial with no GPS by design, so its
 *      coordinates are local and arbitrarily rotated. A local file cannot be
 *      placed without an anchor, and guessing puts the shape in the Gulf of
 *      Guinea. v1 refuses the polygon and still reports the frame-independent
 *      numbers.
 *   3. NEVER OVERWRITE. Import INSERTS. When the map says 4,200 sqft and the
 *      rover says 3,850, that gap is the only signal anyone has about which
 *      properties the aerial gets wrong.
 *
 * Spec: docs/handoff/handoff-site-import.md
 */

export const IMPORT_SOURCES = ["map", "moasure", "gnss", "drone", "manual"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export function isImportSource(v: unknown): v is ImportSource {
  return typeof v === "string" && (IMPORT_SOURCES as readonly string[]).includes(v);
}

export const LENGTH_UNITS = ["ft", "m"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];
export function isLengthUnit(v: unknown): v is LengthUnit {
  return typeof v === "string" && (LENGTH_UNITS as readonly string[]).includes(v);
}

const FT_PER_M = 3.280839895013123;

/** A point as it came out of the file, before any interpretation. */
export type RawPoint = {
  /** lat, or local x */
  a: number;
  /** lng, or local y */
  b: number;
  /** elevation, or null when the file has no third value */
  z: number | null;
  pathName: string | null;
  label: string | null;
};

export type CoordFrame = "geographic" | "local";

export type FrameDetection = {
  frame: CoordFrame;
  /** True ONLY when the headers actually said lat/lon. Everything else is a guess. */
  certain: boolean;
  reason: string;
};

export type ColumnMap = {
  a: number;
  b: number;
  z: number | null;
  pathName: number | null;
  label: number | null;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]/g, "");

const LAT_KEYS = ["lat", "latitude", "ycoord", "northing"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "xcoord", "easting"];
const X_KEYS = ["x", "xm", "xft", "east"];
const Y_KEYS = ["y", "ym", "yft", "north"];
const Z_KEYS = ["z", "elev", "elevation", "height", "alt", "altitude", "zm", "zft"];
const PATH_KEYS = ["path", "pathname", "pathnumber", "layer", "layername", "group", "feature"];
const LABEL_KEYS = ["label", "name", "point", "pointlabel", "description", "code"];

function findCol(headers: string[], keys: string[]): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (keys.includes(norm(headers[i]))) return i;
  }
  return null;
}

/**
 * Best guess at which columns are which. Returns null when two coordinate
 * columns cannot be identified at all — the caller then asks, rather than
 * picking the first two numeric columns and hoping.
 */
export function guessColumns(headers: string[]): ColumnMap | null {
  if (!Array.isArray(headers) || headers.length < 2) return null;

  const lat = findCol(headers, LAT_KEYS);
  const lng = findCol(headers, LNG_KEYS);
  const x = findCol(headers, X_KEYS);
  const y = findCol(headers, Y_KEYS);

  let a: number | null = null;
  let b: number | null = null;
  if (lat !== null && lng !== null) {
    a = lat;
    b = lng;
  } else if (x !== null && y !== null) {
    // x is easting and y is northing, so x maps to `b` (the lng-ish axis) to
    // keep `a` the north-south axis in both frames. Getting this backwards
    // mirrors every shape.
    a = y;
    b = x;
  } else {
    return null;
  }

  return {
    a,
    b,
    z: findCol(headers, Z_KEYS),
    pathName: findCol(headers, PATH_KEYS),
    label: findCol(headers, LABEL_KEYS),
  };
}

/**
 * Geographic or local, with a confidence.
 *
 * `certain` is true only when the headers said lat/lon outright. Anything else
 * is a guess shown to the user for confirmation, because the two frames are
 * genuinely ambiguous from values alone: a small local survey in feet can sit
 * inside the latitude range and look geographic.
 */
export function detectFrame(headers: string[], rows: RawPoint[]): FrameDetection {
  const hasLat = findCol(headers, LAT_KEYS) !== null;
  const hasLng = findCol(headers, LNG_KEYS) !== null;
  if (hasLat && hasLng) {
    return {
      frame: "geographic",
      certain: true,
      reason: "The headers name latitude and longitude.",
    };
  }
  if (findCol(headers, X_KEYS) !== null && findCol(headers, Y_KEYS) !== null) {
    return {
      frame: "local",
      certain: false,
      reason:
        "The headers name x and y, which usually means a local frame — a Moasure trace, for example. Confirm before importing.",
    };
  }

  const usable = rows.filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b));
  if (usable.length === 0) {
    return { frame: "local", certain: false, reason: "No readable coordinates to judge from." };
  }
  const inLatLngRange = usable.every(
    (p) => Math.abs(p.a) <= 90 && Math.abs(p.b) <= 180
  );
  // A local trace starts at its origin, so its values hug zero. Real degrees for
  // a site almost never do.
  const nearOrigin =
    Math.max(...usable.map((p) => Math.abs(p.a))) < 1 &&
    Math.max(...usable.map((p) => Math.abs(p.b))) < 1;

  if (inLatLngRange && !nearOrigin) {
    return {
      frame: "geographic",
      certain: false,
      reason:
        "The values sit inside the latitude and longitude ranges, so they look geographic — but nothing in the file says so. Confirm before importing.",
    };
  }
  return {
    frame: "local",
    certain: false,
    reason:
      "The values do not look like degrees, so this is probably a local frame. Confirm before importing.",
  };
}

export type ParsedPath = {
  name: string;
  points: RawPoint[];
  /** First point within CLOSE_TOLERANCE of the last, in the file's own units. */
  closed: boolean;
};

/**
 * How near the last point must be to the first for a path to count as a closed
 * ring. Deliberately generous: a surveyor walking back to their start does not
 * land on the same blade of grass, and treating a 2 ft gap as an open line
 * turns a lawn into a fence.
 */
export const CLOSE_TOLERANCE = 3;

/** Group points into paths, preserving file order within each. */
export function groupPaths(points: RawPoint[]): ParsedPath[] {
  const order: string[] = [];
  const byName = new Map<string, RawPoint[]>();

  for (const p of points) {
    const key = (p.pathName ?? "").trim() || "Imported area";
    const bucket = byName.get(key);
    if (bucket) bucket.push(p);
    else {
      byName.set(key, [p]);
      order.push(key);
    }
  }

  return order.map((name) => {
    const pts = byName.get(name) as RawPoint[];
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed =
      pts.length >= 3 &&
      Math.hypot(last.a - first.a, last.b - first.b) <= CLOSE_TOLERANCE;
    return { name, points: pts, closed };
  });
}

/**
 * Area of a geographic ring in square feet.
 *
 * NOT google.maps.geometry — `polygonAreaSqft` in lawnMeasurement.ts calls a
 * BROWSER global, so it silently returns 0 on a server or in a harness. This
 * projects to feet with the same cos(lat) convention irrigationProducts.ts
 * already uses, then applies the shoelace formula. At the scale of one property
 * the difference from the spherical figure is negligible, and one convention
 * beats two.
 */
export function ringAreaSqft(ring: LatLng[]): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const lat0 = ring[0].lat;
  const cos = Math.cos((lat0 * Math.PI) / 180);
  // 364,000 ft per degree of latitude — the convention already in this codebase.
  const FT_PER_DEG_LAT = 364000;
  const pts = ring.map((p) => ({
    x: (p.lng - ring[0].lng) * FT_PER_DEG_LAT * cos,
    y: (p.lat - ring[0].lat) * FT_PER_DEG_LAT,
  }));
  let twice = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    twice += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.round(Math.abs(twice) / 2);
}

/** Shoelace on a local plane already expressed in feet. */
function localAreaSqft(xy: { x: number; y: number }[]): number {
  if (xy.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    twice += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
  }
  return Math.round(Math.abs(twice) / 2);
}

export type ElevationSummary = {
  minFt: number;
  maxFt: number;
  fallFt: number;
  maxSlopePct: number;
};

/**
 * Elevation across a path.
 *
 * Returns null when the file carried no third value — which is NOT the same as
 * flat. A flat site has a fall of 0; a site with no elevation data has no
 * answer, and the two must not render the same.
 */
export function summariseElevation(
  zFt: number[],
  runFt: number[]
): ElevationSummary | null {
  const zs = zFt.filter((v) => Number.isFinite(v));
  if (zs.length === 0) return null;
  const minFt = Math.min(...zs);
  const maxFt = Math.max(...zs);
  let maxSlopePct = 0;
  for (let i = 1; i < zs.length; i++) {
    const run = runFt[i - 1];
    if (!Number.isFinite(run) || run <= 0) continue;
    const pct = (Math.abs(zs[i] - zs[i - 1]) / run) * 100;
    if (pct > maxSlopePct) maxSlopePct = pct;
  }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    minFt: r1(minFt),
    maxFt: r1(maxFt),
    fallFt: r1(maxFt - minFt),
    maxSlopePct: r1(maxSlopePct),
  };
}

export type ImportIssue =
  | "no_unit"
  | "local_frame"
  | "too_few_points"
  | "no_columns";

export type ImportedArea = {
  name: string;
  kind: "area" | "line" | "point";
  /** Empty when the frame is local — the shape could not be placed. */
  polygon: LatLng[];
  areaSqft: number;
  lengthFt: number;
  zFt: number[];
  elevation: ElevationSummary | null;
  source: ImportSource;
  issues: ImportIssue[];
  /** False when an issue blocks the write. */
  importable: boolean;
};

export type ImportOptions = {
  /** null means NOT CHOSEN. Never defaulted — see the header. */
  unit: LengthUnit | null;
  source: ImportSource;
  frame: CoordFrame;
  /**
   * Optional placement for a LOCAL trace, solved from two correspondences.
   * Absent means the shape stays unplaced, which is the safe default: a local
   * file imports its measurements and no polygon until someone anchors it.
   */
  anchor?: AnchorTransform | null;
};

export function buildImport(
  paths: ParsedPath[],
  opts: ImportOptions
): ImportedArea[] {
  const toFt = opts.unit === "m" ? FT_PER_M : 1;

  return paths.map((path) => {
    const issues: ImportIssue[] = [];
    // THE UNIT GATE. Without it a metres file silently reads as feet: 3.28x on
    // length, 10.76x on area, and entirely plausible on screen.
    if (opts.unit === null) issues.push("no_unit");
    if (path.points.length < 1) issues.push("too_few_points");

    const zFt = path.points
      .map((p) => (p.z === null ? null : p.z * toFt))
      .filter((v): v is number => v !== null)
      .map((v) => Math.round(v * 10) / 10);

    let polygon: LatLng[] = [];
    let areaSqft = 0;
    let lengthFt = 0;
    const runs: number[] = [];

    if (opts.frame === "geographic") {
      polygon = path.points.map((p) => ({ lat: p.a, lng: p.b }));
      for (let i = 1; i < polygon.length; i++) {
        const d = distanceFt(polygon[i - 1], polygon[i]);
        runs.push(d);
        lengthFt += d;
      }
      if (path.closed && polygon.length >= 3) areaSqft = ringAreaSqft(polygon);
    } else {
      // LOCAL FRAME. The shape cannot be placed on the map without an anchor,
      // and a wrong placement looks right — so no polygon is produced at all.
      // Area, perimeter and elevation are frame-INDEPENDENT, so they are still
      // reported: a refusal here should not throw away the numbers that are
      // genuinely knowable.
      const xy = path.points.map((p) => ({ x: p.b * toFt, y: p.a * toFt }));
      for (let i = 1; i < xy.length; i++) {
        const d = Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);
        runs.push(d);
        lengthFt += d;
      }
      if (path.closed && xy.length >= 3) areaSqft = localAreaSqft(xy);

      if (opts.anchor && opts.unit !== null) {
        // Anchored: the trace now has a real position, so it gets a polygon and
        // the area is taken FROM THAT POLYGON rather than from the local plane.
        // The two agree when the scale is 1; when it is not, the shape that gets
        // drawn and the number that gets quoted must still be the same thing.
        polygon = applyAnchor(
          path.points.map((p) => ({ east: p.b * toFt, north: p.a * toFt })),
          opts.anchor
        );
        if (path.closed && polygon.length >= 3) areaSqft = ringAreaSqft(polygon);
        lengthFt = 0;
        for (let i = 1; i < polygon.length; i++) {
          lengthFt += distanceFt(polygon[i - 1], polygon[i]);
        }
      } else {
        // Unanchored. The shape cannot be placed and a wrong placement looks
        // right, so no polygon is produced at all. Area, perimeter and
        // elevation are frame-INDEPENDENT and still reported — a refusal here
        // must not throw away the numbers that are genuinely knowable.
        issues.push("local_frame");
      }
    }

    const kind: ImportedArea["kind"] =
      path.points.length === 1 ? "point" : path.closed ? "area" : "line";
    if (kind === "area") lengthFt = 0; // an area has no run length
    if (kind === "point") lengthFt = 0;

    // `local_frame` does not block the numbers, only the polygon, so it is not
    // counted as blocking here — the UI offers those rows as an area with no
    // shape and says so.
    const blocking = issues.filter((i) => i !== "local_frame");

    return {
      name: path.name,
      kind,
      polygon,
      areaSqft,
      lengthFt: Math.round(lengthFt * 10) / 10,
      zFt,
      elevation: summariseElevation(zFt, runs),
      source: opts.source,
      issues,
      importable: blocking.length === 0,
    };
  });
}

export type AreaComparison = {
  existingSqft: number;
  importedSqft: number;
  deltaPct: number;
  message: string;
};

/**
 * State the difference between two measurements. Reports; never resolves.
 *
 * The app does not adjudicate between a map polygon and a field survey. That
 * disagreement is the most valuable thing this feature produces — it is the only
 * signal anyone has about which properties the aerial gets wrong — and averaging
 * them, or silently preferring the "better" instrument, throws it away.
 */
export function compareAreas(
  existingSqft: number,
  importedSqft: number
): AreaComparison {
  const a = Number.isFinite(existingSqft) && existingSqft > 0 ? existingSqft : 0;
  const b = Number.isFinite(importedSqft) && importedSqft > 0 ? importedSqft : 0;
  if (a <= 0 || b <= 0) {
    return {
      existingSqft: a,
      importedSqft: b,
      deltaPct: 0,
      message: "Nothing measured on the estimate yet to compare against.",
    };
  }
  const deltaPct = Math.round(((b - a) / a) * 100);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const message =
    deltaPct === 0
      ? `Both measure ${fmt(a)} sqft.`
      : `The map says ${fmt(a)} sqft, this file says ${fmt(b)} — a ${Math.abs(deltaPct)}% difference. Neither is corrected automatically; pick the one you trust.`;
  return { existingSqft: a, importedSqft: b, deltaPct, message };
}

/** One line for the review step, stating what will and will not be written. */
export function describeImport(area: ImportedArea): string {
  if (area.issues.includes("no_unit")) {
    return "Choose the file's units before this can be imported.";
  }
  const bits: string[] = [];
  if (area.kind === "area" && area.areaSqft > 0) {
    bits.push(`${area.areaSqft.toLocaleString("en-US")} sqft`);
  }
  if (area.kind === "line" && area.lengthFt > 0) {
    bits.push(`${area.lengthFt} ft run`);
  }
  if (area.kind === "point") bits.push("single point");
  if (area.elevation) {
    bits.push(
      `${area.elevation.fallFt} ft fall (${area.elevation.minFt} to ${area.elevation.maxFt})`
    );
  }
  if (area.issues.includes("local_frame")) {
    bits.push(
      "no map position — this file uses a local frame, so the shape cannot be placed. The measurements above are still good"
    );
  }
  return bits.join(" · ") || "Nothing measurable in this path.";
}

/* ── Anchoring a local frame onto the map ─────────────────────────────────── */

/**
 * Placing a local trace.
 *
 * A Moasure file has no position on earth: its coordinates are feet from
 * wherever the operator started, at whatever rotation they happened to be
 * facing. To draw it on the map you need a transform, and a transform needs
 * REAL correspondences — two points the surveyor can identify in both the trace
 * and the world (driveway corners, a gate post, a hydrant).
 *
 * Two points give rotation, translation and scale. That is everything a rigid
 * placement needs, and it is the fewest points a person can reasonably be asked
 * for. What two points CANNOT give you is a mirror: a trace walked clockwise and
 * one walked anticlockwise anchor identically, so a flipped shape still looks
 * plausible. `anchorWarnings` says so rather than pretending otherwise.
 */

// Feet per degree of latitude — the same convention as ringAreaSqft above and
// irrigationProducts.ts. One convention, not two.
const FT_PER_DEG_LAT = 364000;

const ftPerDegLng = (lat: number) =>
  FT_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** A point in the trace's own frame, in FEET (already unit-converted). */
export type LocalPoint = { east: number; north: number };

export type AnchorPair = {
  /** The point as it appears in the file. */
  local: LocalPoint;
  /** Where that point actually is. */
  world: LatLng;
};

export type AnchorTransform = {
  /** Degrees the trace must rotate, clockwise, to face the way the site does. */
  rotationDeg: number;
  /**
   * World distance divided by trace distance. Should be ~1. It is the single
   * best cross-check on the unit choice available anywhere in this feature:
   * a trace read as feet when it was metres solves to ~3.28.
   */
  scale: number;
  origin: AnchorPair;
  warnings: string[];
};

const SCALE_TOLERANCE = 0.02; // 2% — survey noise, not a unit error.

/**
 * Solve the transform from two correspondences.
 *
 * Returns null when the two points are too close together to define a bearing:
 * a metre apart on a 40-metre site turns half a degree of click error into
 * twenty degrees of rotation error, and the result would look placed while
 * being wrong.
 */
export function solveAnchor(a: AnchorPair, b: AnchorPair): AnchorTransform | null {
  const localE = b.local.east - a.local.east;
  const localN = b.local.north - a.local.north;
  const localLen = Math.hypot(localE, localN);

  const midLat = (a.world.lat + b.world.lat) / 2;
  const worldE = (b.world.lng - a.world.lng) * ftPerDegLng(midLat);
  const worldN = (b.world.lat - a.world.lat) * FT_PER_DEG_LAT;
  const worldLen = Math.hypot(worldE, worldN);

  // 10 ft apart minimum. Below that the bearing is dominated by click error.
  if (!Number.isFinite(localLen) || localLen < 10) return null;
  if (!Number.isFinite(worldLen) || worldLen < 10) return null;

  const rotationRad = Math.atan2(worldE, worldN) - Math.atan2(localE, localN);
  const scale = worldLen / localLen;

  const warnings: string[] = [];
  if (Math.abs(scale - 1) > SCALE_TOLERANCE) {
    const pct = Math.round((scale - 1) * 100);
    warnings.push(
      `The two points are ${Math.abs(pct)}% ${pct > 0 ? "further apart" : "closer together"} on the map than in the file. A scale near 3.28 means the file is in metres and was read as feet; near 0.3 means the reverse. Check the unit before importing.`
    );
  }
  // Two points fix rotation but not handedness.
  warnings.push(
    "Two points cannot tell a trace walked clockwise from one walked anticlockwise, so check the shape sits the right way round before importing."
  );

  return {
    rotationDeg: Math.round(((rotationRad * 180) / Math.PI) * 10) / 10,
    scale: Math.round(scale * 1000) / 1000,
    origin: a,
    warnings,
  };
}

/** Place local points on the map using a solved transform. */
export function applyAnchor(
  points: LocalPoint[],
  t: AnchorTransform
): LatLng[] {
  const rad = (t.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { local: o, world: w } = t.origin;
  const perLng = ftPerDegLng(w.lat);

  return points.map((p) => {
    const de = (p.east - o.east) * t.scale;
    const dn = (p.north - o.north) * t.scale;
    // Clockwise rotation in an (east, north) frame.
    const e = de * cos + dn * sin;
    const n = -de * sin + dn * cos;
    return {
      lat: w.lat + n / FT_PER_DEG_LAT,
      lng: w.lng + e / perLng,
    };
  });
}

/** The trace's points as feet in its own frame, for anchoring. */
export function localPoints(path: ParsedPath, unit: LengthUnit): LocalPoint[] {
  const toFt = unit === "m" ? FT_PER_M : 1;
  // `b` is the east-west axis and `a` the north-south one, matching
  // guessColumns — getting this backwards mirrors every shape.
  return path.points.map((p) => ({ east: p.b * toFt, north: p.a * toFt }));
}
