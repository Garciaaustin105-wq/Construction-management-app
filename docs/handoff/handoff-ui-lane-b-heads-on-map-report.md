# Lane B report — irrigation heads on the map, 2026-09-06

Executed per `handoff-ui-lane-b-heads-on-map.md`. All committed on
**`feat/irrigation-heads-on-map` (`8c473fd`)**, cut from
`feat/catalogue-screens-lane-a` so Lane A's catalogue screens (and the
`/lawn/irrigation` data source) are present. Not pushed.

## What shipped

One file changed: `src/components/LawnMeasurementMap.tsx` (+801 lines),
exactly the lane's file ownership. `e2e-head-placement.mjs` added at the
repo root (+623). Nothing else touched — map init, the geocode-caching
effect and the draft vertex/edge-insert logic are untouched.

- **Head picker** beside Plants: model → nozzle → arc. Nozzles arrive in
  `sort_order` from `listIrrigationCatalogue` (never re-sorted); a model
  with no nozzles is disabled and labelled "(no nozzles yet)", mirroring
  the unsized-species pattern. The nozzle option label carries
  `describeThrow` — "15 ft from the head · 30 ft across" — so the
  radius/diameter mistake is visible while choosing.
- **Placement** mirrors `placePlant` exactly: sticky mode, mutually
  exclusive with plant placing AND the draft, `useRef` double-place guard
  released before reload+sync, row saved as `kind="point"` with a
  one-coordinate polygon and a FULL `headSnapshot` in meta. Escape ends
  either placement mode. The arc is changeable while armed.
- **Pressure gate before layout**: the amber prompt renders as soon as the
  estimate row is read (pressure columns ride the existing org fetch — no
  second query). `pressureVerdict`'s message renders verbatim, plus the
  age line ("Pressure not tested" / "test N days old" — never "0 days").
  The form saves static/working/gpm/notes + a fresh
  `pressure_tested_at`. `placeHead` **blocks placement** when
  `adjustedRadius` returns `below_minimum`, showing the note — never a
  smaller circle.
- **Coverage drawing** behind an on/off toggle (default on): 360 →
  `google.maps.Circle` (radius in metres, `radius_ft × 0.3048`); any part
  arc → the `coverageRing` pie slice, which starts AT the head so the two
  straight edges render. `radius_ft: 0` draws nothing — marker only, no
  shape, never a zero-radius dot. Gap points render as small amber
  non-clickable dots from `coverageReport`.
- **Head markers** are visually distinct from plants (white fill /
  coloured stroke; plants are the inverse) and all point-row
  discrimination goes through `isIrrigationArea` / `isPlantArea` on meta —
  `kind` is never used alone.
- **Coverage report** per measured polygon: `describeCoverage` lines
  rendered VERBATIM, both percentages shown (reached + overlap), the
  pressure caveat included, no invented single score. Selected-head card:
  nozzle/arc/throw, adjustment note, ±45° rotation (part circles only,
  whole-meta read-modify-write so the snapshot survives), per-placement
  note, delete.

Deliberately NOT built (per the lane): head legend (Lane C renders it —
heads publish upward through `onAreasChange`, so `buildHeadLegend` can run
on the same array unchanged), spacing suggestions, zone sizing, GPM math.

## Verification

- `npx tsc --noEmit` exit 0; `npx eslint` clean on the file.
- **`e2e-head-placement.mjs`: 35/35** against the live DB (Terra Verde Test
  Co only). The plant harness's MAP_STUB is extended with
  `google.maps.Circle` (the plant stub never needed it); head and plant
  markers are counted by their icon signatures, which is also the
  mechanical proof of "a head does not render as a plant and vice versa".
  Covered: three heads → three kind='point' rows with full snapshots;
  reload survival (markers AND shapes); 360→circle / 90→pie-slice
  (ring[0] === head position, straight edges); radius 0 → no shape at
  all; synchronous double-click → ONE head; pressure verdict verbatim at
  30 psi working ("15 psi BELOW the 45 psi"), form save round-trips
  through REST, verdict flips at 48 psi; rotate persists heading 45; note
  persists with snapshot intact; delete removes row + marker.
- **`e2e-plant-placement.mjs` regression: 28/28** — the shared file's
  existing behaviour is untouched.

## Contract notes (nothing edited, two flagged)

1. **The `estimates` pressure columns exist live but no repo migration adds
   them.** A probe read them (status 200) on the live DB before any code
   was written. Whoever owns schema files should commit the migration so a
   fresh environment isn't missing the columns this feature reads.
2. **`below_minimum` can never fire from picker data.** `NOZZLE_COLUMNS`
   selects no `rated_psi` / `min_psi` / `performance` (they're optional on
   `adjustedRadius`'s nozzle arg only). The blocking gate is implemented
   and correct, but with catalogue data alone `adjustedRadius` can only
   return `unknown`/`scaled`. If those columns exist in the table, adding
   them to `NOZZLE_COLUMNS` turns the gate on; if they don't, the gate is
   inert until the schema grows them. Flagged, not edited — contract is
   Lane-B-read-only.
3. Minor harness lesson, not a bug: `coverageReport` measures the polygon's
   REAL extent, so a test polygon inserted with a nominal `area_sqft` of
   1000 reports ~9,600 sq ft. The report is right; the fixture number was
   fake.

## For the other lanes

- **Lane C**: heads are on `areas` via `onAreasChange` —
  `buildHeadLegend(headsForCoverage(...))` (or the equivalent) needs no
  map change. The caption "Draw what you are installing…" is rendered in
  the map panel; the legend belongs in the labor panel per the handoff.
- **Lane D**: untouched by this lane; `irrigationSystem.ts` untouched.
- **Desktop pass**: the head section reuses the shared `panelBody`, so the
  panel layout work covers it automatically. New drawers introduced none.