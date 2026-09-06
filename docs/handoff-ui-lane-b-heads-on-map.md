# HANDOFF — Lane B: sprinkler heads and coverage on the map

**Lane B owns `src/components/LawnMeasurementMap.tsx` and nothing else.**
Lane A is in the catalogue screens, Lane C is in the workspace. Do not touch
either.

Contract: `src/lib/irrigationProducts.ts` — already written, 76 assertions
green. You are wiring it up, not designing it. Read the file header before
starting; the scope guard there is a business constraint, not a style note.

---

## What already works in this file

Plant placement landed and is E2E-proven. **Heads reuse that machinery almost
exactly** — picker → sticky placement mode → click to drop → marker → select
card → delete. Read how plants do it and follow it.

Two things in that code exist because of heads specifically:

1. The marker effect filters with `isPlantArea(a)`, **not** `a.kind === "point"`.
   A head is a point too. Filtering on geometry alone draws heads as plants and
   opens the plant card on them. Your head marker effect must filter with
   `isIrrigationArea(a)` for the same reason.
2. `kind` is GEOMETRY, `meta` is WHAT THE THING IS. Every read discriminates on
   meta.

---

## 1. The head picker

`listIrrigationCatalogue(supabase, orgId)` → models with nozzles nested and
ordered. Pick a model, then a nozzle, then an **arc**.

Arc is chosen at PLACEMENT, not from the catalogue — the same nozzle is a 90 in
a corner and a 360 mid-lawn. Offer `HEAD_ARCS` (90 / 120 / 180 / 270 / 360).

**Do not ask the user to type a compass bearing.** `heading_deg` is where the
arc STARTS, sweeping clockwise, which is correct in the data and meaningless to
a human. Let them rotate the wedge on the map — drag, or a rotate control on
the selected head. A number input for "start bearing" would be a bad screen.

Empty state: when the org has no heads, an amber note linking to
`/lawn/irrigation`, matching the plant picker's link to `/lawn/plants`.

## 2. Placing a head

Exactly like `placePlant`: `kind: "point"`, one-coordinate polygon,
`area_sqft: 0`, `headSnapshot(product, nozzle, arc, heading)` in `meta`.

**Reuse the same in-flight `useRef` guard.** A head saves on a single tap with
no confirm step; a slow save plus an impatient second tap creates two heads.
This repo has shipped that bug once already.

## 3. Coverage — the new work

For each placed head with `radius_ft > 0`:

- **arc 360** → `google.maps.Circle`, centre on the head, radius in metres
  (`radius_ft * 0.3048`).
- **arc < 360** → `google.maps.Polygon` from `coverageRing(center, radius_ft,
  arc_deg, heading_deg)`. Google Maps has no arc primitive; that helper returns
  the pie slice, starting AT the head so the two straight edges draw — which is
  what makes a 90 read as a corner head.

Semi-transparent fill so overlap darkens naturally and gaps show as untinted
ground. Same teardown-then-rebuild discipline as the marker effects; leaking
circles on a 60-head plan will melt the map.

**`radius_ft: 0` draws NOTHING.** `coverageRing` returns `[]` for it and the
circle branch must skip it too. 54 of the seeded nozzles are in that state on
purpose. `radiusUnset(rows)` exists so the panel can say "your catalogue has no
throw distances" rather than showing bare markers with no explanation.

**A coverage on/off toggle is required.** On a dense plan the circles bury the
plants underneath them.

## 4. What must NOT be built

From the contract header, and this is the scope line the owner drew:

- no coverage percentage or score
- no gap warnings
- no spacing suggestions
- nothing that reads as "this system will work"

Head spacing, GPM, pressure loss and zone balancing are licensed engineering.
This draws and prices what a professional places. Circles on a map already look
like a design tool; the moment one reads "94% covered", liability for someone's
irrigation moves to this app.

The caption to carry, in this order — what it does first, the caveat second:

> Draw what you are installing and price it in minutes. Coverage shows what you
> placed, so gaps and overlaps are easy to spot — spacing, pressure and zoning
> stay your call.

## 5. Publish upward, do not build a legend here

The map already calls `onAreasChange(areas)` after every `loadAreas`, and the
workspace derives everything from it. **Do not build a head legend in this
file** — Lane C renders it. If the panel does not update after placing a head,
the bug is a missing `loadAreas`, not a missing legend.

## Rules

- Import from `src/lib/irrigationProducts.ts`. Re-derive nothing. If the
  contract looks wrong, say so in your report — do not edit it.
- Do not change the map init, the geocode-caching effect, or the draft
  vertex/edge-insert logic. All three fixed real bugs and the comments say so.
- Anything about MEASURED AREAS reads `polygonAreas`, never bare `areas` — a
  thirteenth site using `areas` reintroduces a fixed bug.
- Tailwind + lucide-react only, no new dependency, no marker-clustering
  library. If 200 markers is a problem, report it.
- `npx tsc --noEmit` exit 0, `npx eslint` clean.

## Verify

Commit `e2e-head-placement.mjs` at the repo root. Copy the isolation discipline
from `e2e-plant-placement.mjs`: deactivate the org's real catalogue, scope every
delete and REST read to `E2E%` rows, restore on the failure path.

Cover: place three heads → three `kind='point'` rows with a full head snapshot;
they survive a reload; **a head does not render as a plant and a plant does not
render as a head**; a 360 draws a circle and a 90 draws a four-sided-plus arc
polygon; `radius_ft: 0` draws no coverage at all; two rapid clicks make one
head.
