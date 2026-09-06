# HANDOFF — the unified site importer

Bring measurements taken in the field — Moasure, a GNSS rover, a surveyor's
file — into an estimate alongside what was drawn on the map.

**This is deliberately NOT a Moasure integration.** Every device in this
category exports the same two things: a CSV of points and a DXF. Moasure, Emlid
Reach and drone contour deliverables all do. Building one importer that reads
*a file of surveyed points* means adding a device later is a documentation
change, not a code change, and the app never carries a per-vendor code path.

Research behind this: `docs/labor-production-rates.md` is unrelated; the device
survey lives in this repo's chat history and the key facts are restated below
where they change a decision.

---

## 1. What this lane owns

- **New contract:** `src/lib/siteImport.ts` (pure) + `src/lib/siteImportData.ts`
  (I/O), split the way `crewFeedback.ts` / `crewFeedbackData.ts` are, so the
  harness runs standalone.
- **New migration:** one column on `estimate_areas`.
- **New screen:** an upload + review step that writes `estimate_areas`.
- **Harness:** `e2e-site-import.mjs`.

**It does NOT own `src/components/LawnMeasurementMap.tsx`.** That file is Lane
B's and is being edited right now on `feat/irrigation-heads-on-map`. The
importer writes rows; the map picks them up through the `loadAreas` /
`onAreasChange` path that already exists. If the map needs to render imported
areas differently, that is a Lane B change made after this lands.

---

## 2. The three failure modes this file exists to prevent

Read these before the contract. Everything else is plumbing.

### 2.1 UNITS. Never guess, and never default.

A file in metres read as feet overstates length by **3.28x** and area by
**10.76x**. It produces a number that looks entirely plausible on screen and is
wrong by an order of magnitude.

Moasure and Emlid both export in whichever units the operator had set. Most CSV
exports **do not state the unit anywhere in the file**.

So: the unit is an **explicit input the user picks**, shown next to a preview of
what the file will produce. If the file declares a unit, use it and say so. If
it does not, the importer **must not proceed on a default** — no "assume feet".
This is the one place in the whole feature where a wrong silent answer is worse
than a refusal.

### 2.2 COORDINATE FRAME. Geographic or local — and local cannot be placed.

- **Geographic** (lat/lng): a GNSS rover, a drone deliverable, a surveyor's
  geo-referenced file. These drop straight onto the map at the right place and
  rotation. Nothing to solve.
- **Local** (x/y in metres or feet from an arbitrary origin): **Moasure**. It is
  inertial — no GPS, by design, which is exactly why it works under tree canopy
  and against buildings. Its coordinates are relative to wherever the
  measurement started, with arbitrary rotation.

A local-frame file **cannot be placed on the map without an anchor**, and
guessing is not an option: treating local metres as degrees puts the shape in
the Gulf of Guinea, and placing it at the property centroid with north-up
rotation produces a shape that looks right and sits wrong.

**v1 REFUSES local-frame files with a clear message** rather than placing them
badly. The anchoring UI (drag/rotate over the aerial, or match two known points
and solve the transform) is real work and is scoped separately — see §7.

A local file still carries usable numbers: **area, perimeter and elevation are
all frame-independent**. v1 may offer to import those as an area with no
polygon. Say plainly that the shape could not be placed.

### 2.3 NEVER OVERWRITE A MEASUREMENT WITH ANOTHER ONE.

An import **creates new rows**. It never updates or replaces a map-drawn area.

When the map says 4,200 sqft and the rover says 3,850, that disagreement is the
single most valuable thing the feature produces — it is the only signal anyone
has about which properties the aerial is getting wrong. Averaging them, or
silently preferring the "better" instrument, throws it away.

Show both, badge each with where it came from, and let the estimator choose.
The app does not adjudicate between two measurements.

---

## 3. Schema

One column, additive, no CHECK (app-validated, matching every other enum here):

```sql
alter table public.estimate_areas
  add column if not exists source text not null default 'map';

comment on column public.estimate_areas.source is
  'map | moasure | gnss | drone | manual — where the measurement came from. A row is never rewritten by a different source; two sources disagreeing is information.';
```

**Why a column and not `meta`:** `meta` is per-kind detail ("coverage radius for
a head, species for a plant"). Provenance applies to every row regardless of
kind, has to be filterable, and the UI badges it. It earns a column.

**Elevation goes in `meta`**, because it is optional detail and putting it there
needs no migration when the next device carries something extra:

```ts
meta.z          // number[] — parallel to `polygon`, one per vertex, in FEET
meta.elevation  // { minFt, maxFt, fallFt, maxSlopePct }  — derived, for display
meta.import     // { device, fileName, importedAt, unitAsRead, pathName }
```

`meta.z` is stored in **feet**, converted at import, so nothing downstream ever
has to ask again. Same reasoning as storing `length_ft`.

---

## 4. Contract — `src/lib/siteImport.ts` (pure)

```ts
export const IMPORT_SOURCES = ["map","moasure","gnss","drone","manual"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export function isImportSource(v: unknown): v is ImportSource;

export const LENGTH_UNITS = ["ft","m"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

/** A point as it came out of the file, before any interpretation. */
export type RawPoint = {
  a: number;            // lat, or local x
  b: number;            // lng, or local y
  z: number | null;     // elevation, or null when the file has no third value
  pathName: string | null;
  label: string | null;
};

export type CoordFrame = "geographic" | "local";

/**
 * What the columns appear to be. Reports a GUESS with a confidence, and never
 * decides on the user's behalf — the review step shows this and the user
 * confirms.
 */
export type FrameDetection = {
  frame: CoordFrame;
  /** true only when column headers actually said lat/lon. */
  certain: boolean;
  reason: string;
};
export function detectFrame(headers: string[], rows: RawPoint[]): FrameDetection;

export type ColumnMap = { a: number; b: number; z: number | null;
                          pathName: number | null; label: number | null };
export function guessColumns(headers: string[]): ColumnMap | null;

export type ParsedPath = {
  name: string;
  points: RawPoint[];
  closed: boolean;      // first point ~= last point, within CLOSE_TOLERANCE
};
export function groupPaths(points: RawPoint[]): ParsedPath[];

/** Feet between two geographic points. Planar with cos(lat) scaling. */
export function distanceFt(a: LatLng, b: LatLng): number;

/** Shoelace area in sqft for a geographic ring. NOT google.maps — see §5. */
export function ringAreaSqft(ring: LatLng[]): number;

export type ImportIssue =
  | "no_unit"           // nothing declared it and the user has not chosen
  | "local_frame"       // cannot be placed on the map
  | "too_few_points"
  | "no_columns"        // could not find two coordinate columns
  | "mixed_units";      // file appears to mix — refuse

export type ImportedArea = {
  name: string;
  kind: "area" | "line" | "point";
  polygon: LatLng[];          // empty when frame is local
  areaSqft: number;
  lengthFt: number;
  zFt: number[];
  elevation: ElevationSummary | null;
  source: ImportSource;
  issues: ImportIssue[];
  /** false when `issues` contains anything that blocks a write. */
  importable: boolean;
};

export type ElevationSummary = {
  minFt: number; maxFt: number; fallFt: number; maxSlopePct: number;
};
export function summariseElevation(zFt: number[], runFt: number[]): ElevationSummary | null;

export type ImportOptions = {
  unit: LengthUnit | null;    // null = not chosen yet; NOT a default
  source: ImportSource;
  frame: CoordFrame;
};
export function buildImport(paths: ParsedPath[], opts: ImportOptions): ImportedArea[];

/** Compare an import against what is already on the estimate. Reports, never resolves. */
export type AreaComparison = {
  existingSqft: number;
  importedSqft: number;
  deltaPct: number;
  message: string;
};
export function compareAreas(existingSqft: number, importedSqft: number): AreaComparison;
```

Reuse `parseDelimited` from `src/lib/plantImport.ts` for the CSV tokenising —
it already handles quoting and is proven at 15/15. Do not write a second CSV
parser.

---

## 5. Area maths — do NOT use `polygonAreaSqft`

`src/lib/lawnMeasurement.ts` exports `polygonAreaSqft`, and it is the wrong tool
here: it calls `google.maps.geometry.spherical`, a **browser global**. An
importer that runs server-side or in a harness gets 0 back with no error.

Compute it directly instead, matching the convention already used in
`src/lib/irrigationProducts.ts`: project to feet with **364,000 ft per degree of
latitude** and scale longitude by `cos(lat)`, then shoelace. At the scale of one
property the error against the spherical figure is negligible, and it is what
the pipe and coverage maths already do — one convention, not two.

Round area to whole sqft and lengths to one decimal, as elsewhere.

---

## 6. UI

A screen at `/lawn/estimate/[id]/import` (or a panel — your call, but do not
make it a step inside the map component).

Flow, and the order matters:

1. **Upload.** CSV only in v1.
2. **Confirm what it is.** Show the detected columns, the detected frame with
   its reason, and a **required unit picker**. Nothing proceeds until the unit
   is chosen. Default the picker to nothing selected, not to feet.
3. **Preview before writing.** Per path: name, kind, area, perimeter, elevation
   fall. Where the estimate already has areas, show `compareAreas` — "the map
   said 4,200 sqft, this file says 3,850, a 8% difference" — as a statement, with
   no recommendation attached.
4. **Import.** Writes new rows with `source`. Existing rows are untouched, and
   the screen says so in as many words.

Match the house pattern: `DataTable` for the preview table (see
`ChemicalProductsManager.tsx`), every write busy-gated, empty renders empty,
Tailwind + lucide-react only.

**A local-frame file** shows the refusal clearly and offers the frame-independent
numbers — area, perimeter, elevation — as an area with no shape. It must not
look like a failure; it is a partial success with the shape withheld.

---

## 7. Out of scope for v1, and why

- **DXF/DWG.** A real parser, and every device that exports DXF also exports
  CSV. Ship CSV, learn what people actually upload, then decide. When it comes,
  it goes behind the same `buildImport` and only the tokeniser differs.
- **The anchoring UI for local-frame files.** Drag/rotate over the aerial, or
  match two known points and solve rotation + translation + optional scale. This
  is the single biggest piece of work in the whole idea and it deserves its own
  spec against a working v1, not a guess bundled into one.
- **Reconciling map vs imported areas.** The app reports the difference and
  stops. Deciding which is right is the professional's call — the same line
  every other measurement feature here draws.
- **Elevation → irrigation pressure.** Elevation costs **0.433 psi per foot of
  rise**, and `adjustedRadius` / `pressureVerdict` in `irrigationProducts.ts`
  already refuse to extrapolate below a nozzle's minimum. Once `meta.elevation`
  exists, a follow-on can report the psi delta between the point of connection
  and each head. **Report the measurement; do not size the zones.** Out of scope
  here, but the reason `meta.z` is stored per-vertex rather than only summarised.

---

## Verify

Commit `e2e-site-import.mjs`. Pure math, no database — the same standalone-build
pattern as `e2e-crew-feedback.mjs` (note the `sed` for the relative import).

Cover, and the first three are the point of the exercise:

- **A metres file read as feet is caught, not silently 10.76x wrong.** No unit
  chosen returns `no_unit` and `importable: false`; the same file at `m` and at
  `ft` produces areas differing by 10.76x, proving the choice bites.
- **A local-frame file is refused a polygon** and still reports area, perimeter
  and elevation. It is never placed at 0,0 and local metres are never read as
  degrees.
- **An import never mutates an existing row** — the write path only inserts.
- Column detection: lat/lon headers → `certain: true`; x/y headers → local;
  unlabelled numeric columns → a guess with `certain: false`.
- A closed ring becomes `kind: "area"` with a real sqft; an open path becomes
  `kind: "line"` with `length_ft` and `area_sqft: 0`; a single point becomes
  `kind: "point"` with both zero.
- Multiple paths in one file become multiple areas, keyed by path name.
- Elevation: fall is max minus min, a flat file gives `fallFt: 0` and not null,
  and a file with no third column gives `elevation: null` — which is not the
  same as flat.
- `compareAreas` states the difference and contains no recommendation.
- Bad input never throws: empty file, headers only, one column, ragged rows,
  non-numeric coordinates.

`npx tsc --noEmit` exit 0 and `npx eslint` clean before reporting.

## Test org

Terra Verde Test Co, `600d02fa-fae2-440b-99ab-42e96997da91`.
**Never read or write `d236eba1-8e84-4dae-a40d-ef2651cbbb9c`** — live customer.
