# HANDOFF — place plants on the map

The hardest of the plant handoffs. `src/components/LawnMeasurementMap.tsx` is
928 lines that understand **polygons only** — there is not one reference to
`kind` in the file. You are teaching it a second geometry.

Do the catalogue rework (`docs/handoff-plant-catalogue-rework.md`) first. There
is nothing to place until a catalogue exists.

## What already exists — do not rebuild any of it

| Thing | Where |
|---|---|
| `kind` / `length_ft` / `meta` on `estimate_areas` | applied to prod |
| `plant_products` + `plant_product_sizes` | applied to prod |
| Snapshot, legend, labor, margin math | `src/lib/plantProducts.ts` |
| Load/save/delete that already handles points | `src/lib/estimateAreas.ts` |

**A placed plant is an `estimate_areas` row** with `kind: "point"`, a
**one-coordinate** `polygon`, `area_sqft: 0`, and a `plantSnapshot()` in
`meta`. It is not a new table and `createEstimateArea` already accepts it
unchanged. That was the entire point of the phase-1 migration.

## THE CORE PROBLEM — already solved for you, do not redo it

`areas` is one array holding two geometries. Twelve sites in this file assumed
polygons and every one of them was wrong the moment a point appeared: the
static-polygon render dropped points via `polygon.length >= 3`, the colour
palette and `Area N` numbering counted plants, the area list rendered them as
rows reading "0 sq ft", and three separate "N areas measured" counters
included them.

**All twelve are already fixed and committed.** `const polygonAreas =
areas.filter((a) => a.kind === "area")` sits with the other derived state, and
every site that meant "a measured polygon" now reads from it. `tsc` and
`eslint` are clean.

Two rules that follow, and they matter:

- **Anything about measured areas reads `polygonAreas`.** If you add a
  thirteenth such site using bare `areas`, you reintroduce the bug.
- **The plant work reads `areas`.** Points live there, and `onAreasChange`
  deliberately publishes the WHOLE array upward — the legend needs the points.

## EDIT 1 — render the plants

New ref beside `staticPolygonsRef`:

```tsx
const plantMarkersRef = useRef<google.maps.Marker[]>([]);
```

A new effect, mirroring the static-polygon effect's teardown-then-rebuild
shape, keyed on `[areas, selectedPlantId]`. For each `plantPoints` entry with a
non-empty `polygon`, drop a `google.maps.Marker` at `polygon[0]`:

- filled circle symbol, `fillColor` from the row's `color`, white stroke so it
  reads on satellite imagery
- **`clickable: true`** — unlike the polygons, which are `clickable: false`.
  Clicking a plant selects it; that is how it gets inspected and deleted.
- scale up slightly when selected

**Always tear down the previous markers first.** The static-polygon effect
shows the pattern. Leaking markers on a 200-plant estimate will visibly melt
the map.

Fix the polygon filter in the same pass so it is explicit rather than
incidental:

```tsx
.filter((a) => a.kind === "area" && a.id !== editingId && Array.isArray(a.polygon) && a.polygon.length >= 3)
```

## EDIT 1b — the plant picker (the spec originally omitted this)

Placement needs a way to choose WHAT to place. Load the catalogue once, on
mount, next to how `pricedServices` is already loaded:

```tsx
const { data } = await listPlantCatalogue(supabase, orgId);
```

It returns `PlantWithSizes[]` — species with their sizes nested and already
ordered. Do not sort sizes yourself; `"15 gal"` sorts before `"3 gal"`
alphabetically, which is the bug `sort_order` exists to prevent.

In the floating panel, a compact picker: choose a species, then a size. Show
each size as `3 gal — $38`. Selecting a size enters placement mode with that
`{ product, size }` pair.

**The empty state matters more than the picker.** A brand-new org has no
plants, and the catalogue starts empty for everyone. When
`listPlantCatalogue` returns nothing, show an amber note linking to
`/lawn/plants` — the same shape as the existing "No service has a $/sq ft rate
yet" state a few lines away in this file. Copy that pattern rather than
inventing one.

A species with NO sizes cannot be placed (there is no price and no install
time). Either hide it or show it disabled with "no sizes yet".

## EDIT 2 — placement mode, and its conflict with drawing

The map's click listener is registered **once** and reads `draftRef.current` so
it never goes stale. Read the comment at ~line 233 before touching it; that
design is deliberate and fixed a real bug.

Placement needs the same treatment — a ref the listener can read:

```tsx
const [placing, setPlacing] = useState<{ product: PlantProduct; size: PlantSize } | null>(null);
const placingRef = useRef<typeof placing>(null);
useEffect(() => { placingRef.current = placing; }, [placing]);
```

In the listener, **placement branches first and returns**:

```tsx
const place = placingRef.current;
if (place && e.latLng) { void placePlant(place, { lat: e.latLng.lat(), lng: e.latLng.lng() }); return; }
// ...existing draft vertex logic unchanged below
```

**The two modes must be mutually exclusive.** Entering placement while an
unsaved draft polygon exists would let one click mean two things. Starting
placement must call the existing `discardDraftOk()` guard, and starting a new
area must clear `placing`. Do not allow both to be non-null.

**Placement is sticky.** After placing one plant, stay in placement mode — the
real job is "put in twenty hollies", and a mode that exits after each plant
makes that twenty round trips. Exit on an explicit Done/Escape.

## EDIT 3 — `placePlant`

Unlike `finishArea`, a plant **saves on the single click**. There is no finish
step and no minimum vertex count.

```tsx
async function placePlant(sel: { product: PlantProduct; size: PlantSize }, at: LatLng) {
  if (!orgId) { setErrorMsg("Still loading this estimate — try again in a moment."); return; }
  const { error } = await createEstimateArea(supabase, {
    estimate_id: estimateId,
    organization_id: orgId,
    name: sel.product.name,
    color: sel.product.color,
    polygon: [at],          // ONE coordinate
    area_sqft: 0,
    kind: "point",
    meta: plantSnapshot(sel.product, sel.size) as unknown as Record<string, unknown>,
  });
  // ...error handling, then reload + syncEstimateTotals as finishArea does
}
```

**Guard against the double-place.** This repo has already shipped a
double-submit bug from a missing in-flight guard (`crew/photo`). A slow save
plus an impatient second tap must not create two plants. Use a `useRef` guard,
not state — state updates are async and the second click can beat the re-render.

**Do not put plants in the undo stack.** `history`/`future` hold draft vertex
arrays; a saved plant is not a draft. Deleting the plant is the undo. Say so in
the UI rather than half-wiring it.

## EDIT 4 — selecting and deleting a plant

Clicking a marker sets `selectedPlantId`. Show a small card with the species,
size, price, install time, and a per-placement note (`meta.note`), plus Delete.

- Delete uses the existing `deleteArea` — it is keyed by id and already works.
- Editing the note writes `meta` through `updateEstimateArea`, which now
  accepts `meta`. **Read-modify-write the whole `meta` object**; do not
  construct a fresh one, or you will drop the snapshot fields.

## EDIT 5 — the Legend: DO NOT BUILD IT IN THIS FILE

This changed after the spec was first written. The legend and the labor
breakdown now live in the WORKSPACE, not the map:

- `LawnMeasurementMap` takes an `onAreasChange?: (areas: EstimateArea[]) => void`
  prop and calls it after every `loadAreas`, publishing the whole array upward.
  It is held in a ref so an inline arrow from the parent cannot change
  `loadAreas`' identity and re-fire its effects.
- `LawnEstimateWorkspace` holds those areas, runs `buildPlantLegend(areas)`,
  and renders `LandscapeLaborPanel` inside the map's `panelSlot`.

**So the moment your `placePlant` reloads areas, the legend and the whole
labor breakdown update by themselves.** You do not wire them, you do not build
a legend component, and you must not add a second `buildPlantLegend` call in
this file. If the legend does not move after placing a plant, the bug is that
`loadAreas` was not called — not a missing legend.

`LandscapeLaborPanel` already handles the empty case ("Place plants on the map
to price install labor"), so an estimate with no plants is already correct.

## Rules

- Import from `src/lib/plantProducts.ts` and `src/lib/estimateAreas.ts`.
  **Re-derive nothing.** If the contract looks wrong, say so in your report —
  do not edit it.
- Do not change the map init, the geocode-caching effect, or the draft
  vertex/edge-insert logic. All three fixed real bugs and the comments say
  which.
- Tailwind + lucide-react only. No new dependency, and **no marker-clustering
  library** — if 200 markers is a problem, report it, do not solve it by
  pulling in a package.
- `npx tsc --noEmit` exit 0, `npx eslint` clean.

## Verify — commit `e2e-plant-placement.mjs` at the repo root

Convention is `e2e-*.mjs` at the root (`e2e-chemicals-test.mjs`,
`e2e-settlement.mjs`, …). There is no `Tools/` directory. Read one first.

1. place three plants → three `kind='point'` rows, REST-verified, each with a
   one-coordinate polygon and a full snapshot in `meta`
2. they render as markers and **survive a page reload** — this is the assertion
   that catches the `polygon.length >= 3` filter
3. an estimate holding both polygons and plants: the area list shows **only**
   the polygons, and "N areas" does not count plants
4. placing a plant does not disturb existing polygon `area_sqft`
5. the legend updates WITHOUT any legend code in this file — place a plant,
   then assert `LandscapeLaborPanel` shows the new count. If it does not move,
   `loadAreas` was not called.
6. the picker's empty state appears when the org has no plants, and links to
   `/lawn/plants`
7. delete a plant → marker and legend row both go
8. **the double-place guard:** two rapid clicks in the same spot create one
   plant, not two

Report whether it ran against the live database and paste the real counts. If
anything here turned out to be wrong, say which part — a spec of mine has had a
wrong premise before and it cost a rebuild.
