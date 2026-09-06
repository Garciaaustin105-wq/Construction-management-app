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

## 3b. The coverage report

`coverageReport(polygon, headsForCoverage(areas))` and `describeCoverage(r)`
now exist. Render the lines it returns verbatim; do not compose your own.

It returns TWO percentages on purpose and both must show:

  reachedPct   inside at least one head's throw
  overlapPct   inside TWO or more — the head-to-head proxy

A single score cannot tell a good layout from a bad one. Verified: four heads
whose circles merely touch measure **100% reached / 36.8% overlap**, and the
same four spaced head-to-head measure **100% reached / 78.8% overlap**. Both
read "100% covered"; only overlap separates them, and the first is the
under-watered one.

`gapPoints` are sampled gap centres — mark them on the map so a dry spot is
somewhere the estimator can look, not just a percentage.

`describeCoverage` ends with `PRESSURE_CAVEAT` and it must not be trimmed:
every radius here assumes the manufacturer's design pressure (45 psi for the
seeded lines). A house running lower throws shorter and every circle is then
optimistic. That has to reach the estimator BEFORE they buy heads, because a
nozzle chosen for 45 psi on a 30 psi house is the wrong part.

## 3c. Pressure — record it BEFORE layout

`estimates` now carries a pressure test: static psi, working psi, gpm, when it
was taken, and notes. Contract: `readPressureTest`, `pressureUntested`,
`pressureVerdict`, `pressureAgeDays`, `adjustedRadius`, `describeAdjustment`.

**Prompt for it before the layout, not at quote time.** Every radius here is a
manufacturer figure at a design pressure; laying out first and testing later
means the head count, the nozzle choice and the zone split were all decided
against a number nobody checked. `pressureUntested(t)` is what that prompt
hangs on.

Once a working pressure is recorded, `adjustedRadius(nozzle, workingPsi)`
gives the real throw:

- a **chart** on the nozzle is INTERPOLATED — reading the manufacturer's
  published values, not modelling
- otherwise it SCALES, clearly labelled an estimate. The exponent is 0.125,
  not a square root: real Hunter PGP data is 35 ft at 25 psi and 38 ft at
  45 psi, so 45 → 30 psi costs about 2 ft of throw, not 7
- **below the nozzle's minimum operating pressure it returns NULL and refuses
  to give a number**, naming the minimum. That is the most important behaviour
  in the file: below minimum a rotor stops rotating and a spray breaks into
  mist, so it is not "shorter throw", it is the wrong part. Show that as a
  blocking note, not a smaller circle.

## 4. What must NOT be built

The owner's scope line, as amended 2026-09-05. The coverage MEASUREMENT is now
in scope and built — `reachedPct`, `overlapPct`, gaps — because it reports
geometry and refuses to grade a design. What stays out:

- no single "coverage score" that collapses reach and overlap into one number.
  Verified why: touching circles measure 100% reached / 36.8% overlap and
  head-to-head measures 100% / 78.8%. One number cannot tell them apart, and
  the first is the under-watered layout.
- no spacing suggestions, no zone sizing, no GPM or pressure-loss maths
- nothing that reads as "this system will work". Report the measurement; the
  licensed professional decides.

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
