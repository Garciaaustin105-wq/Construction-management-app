# Quick estimator — making it the staple

**Written 2026-09-04 by Claude Opus 5. A plan, nothing built.**
**Tool: `/estimates/quick` → `LawnMeasurementMap.tsx`, `estimateAreas.ts`,
`lawnMeasurement.ts`, table `estimate_areas`.**

---

## Where it is today

Draw a polygon on Google Maps, get square feet, price it against a service
rate, save it to an estimate. Vertices drag, midpoints insert, undo/redo works,
saved areas reopen for editing, and as of today clicking the outline inserts a
point on that edge. There is already a fullscreen toggle.

It is good at exactly one thing: **an area with a square footage.**

## The one architectural decision everything else depends on

`estimate_areas` stores `polygon: LatLng[]` and `area_sqft`. That shape cannot
express what the landscape work needs:

| Feature | Geometry | Fits today's model? |
|---|---|---|
| Mulch bed, sod, mow zone | polygon + sqft | ✅ already works |
| Sprinkler head | **point** + coverage radius | ❌ |
| Pipe / lateral run | **line** + length | ❌ |
| Tree, shrub, plant | **point** + species detail | ❌ |

**Recommendation: extend the one table, do not add three more.** Add a
discriminator and let the coordinate list mean different things:

```
kind         'area' | 'point' | 'line'      -- how to read `polygon`
meta         jsonb                          -- radius, species, size, spacing…
length_ft    numeric                        -- for lines; area_sqft stays for areas
```

A point is a one-coordinate list; a line is an open list. Rendering, hit
testing, undo, save/restore and the estimate join all carry over unchanged —
which is the whole reason to extend rather than fork. The takeoff tool on the
concrete side settled on the same shape (one item, a `geom` of
linear/area/count), and it held up.

**Do this first.** Every feature below is cheap once it exists and expensive
before it.

## Phases

### 1. Geometry foundation
Migration for `kind` / `meta` / `length_ft`. Teach the map to draw and edit
points and polylines, not just rings. Length in feet alongside area in sqft.
Nothing user-visible changes for existing areas — they are all `kind: 'area'`.

### 2. Fullscreen workspace
The toggle exists; the layout does not. Build the real thing:
- **tab bar** — Measure · Landscape · Items · Legend
- **estimator strip** — running line items with quantity, unit, rate, total,
  so the number moves while you draw instead of after
- the map keeps the rest of the screen

This is the "main staple" half of the request. It is worth doing before the
plant catalogue, because the catalogue needs somewhere to live.

### 3. Plants, trees, mulch
Point items with a species/size, dropped on the plan. A **legend** built from
what is actually placed — not a separate list to maintain. Per-item detail
(species, size, install price, notes) that flows straight into line items.
Mulch beds are just areas with a depth, so they mostly work today: sqft × depth
→ cubic yards → bags or bulk.

### 4. Irrigation
Heads as points carrying a coverage radius and arc; coverage circles drawn on
the map so gaps and overlaps are visible. Pipe runs as lines between heads,
totalled by size for material.

**Scope guard: this is an ESTIMATING aid, not an irrigation design tool.** Head
spacing, GPM, pressure loss, zone balancing and backflow are a licensed
discipline. Draw what the designer specifies and price it; do not compute
whether the system will actually work. Crossing that line means owning
liability for someone's system, and the user has one real customer, not a
hydraulics department.

**DECIDED 2026-09-05: keep the coverage drawing, and carry a note.** The
circles stay — they are how a professional sees gaps and overlaps at a glance,
and that is exactly the speed-up the tool exists to give. What changes is that
the screen says what it is, so nobody mistakes a drawing for a design.

The note has two halves, and the second is the one people forget:

1. **Whose job this is.** The tool helps a licensed professional produce an
   estimate faster. It does not size a system.
2. **Why the numbers move.** Every measurement here comes off satellite
   imagery, and that carries real error:
   - georeferencing offset — imagery can sit several feet off true ground
     position, so a click is not exactly where you think
   - imagery age — the picture may be months or years old, and the yard has
     changed since
   - resolution — roughly 15-30 cm per pixel at best, so a tap is +/- a foot
     or two before anyone's hand shakes
   - **slope is not counted** — the math here is planar (see
     `areaSqftFromPoints`, `lengthFtFromPoints`), so a sloped yard has more
     real surface than its map footprint. This under-measures, always in the
     same direction.

**THIS APPLIES TO EVERYTHING ALREADY SHIPPED, not just irrigation.** Lawn
sqft, mulch beds, sod and pipe runs all come off the same imagery with the
same planar math. The note belongs on the measurement surface generally, not
buried in an irrigation tab that most estimates never open.

Draft copy, to be placed once and reused:

> Measured from satellite imagery to speed up estimating — expect a few feet
> of variance, and note that slope is not included, so sloped ground measures
> low. Coverage shown is what you placed, not an irrigation design; spacing,
> pressure and zoning stay with your licensed professional.

**Do not add this to `LawnMeasurementMap.tsx` while the placement lane is
open** — that file is being edited by another lane right now, and a one-line
copy change is not worth a merge conflict in a 949-line component. Queue it
with the irrigation work, or take it in a lane of its own once placement
lands.

## Open questions — these need your answers, not my guesses

1. **Where do plant prices come from?** A catalogue in the app that an org
   maintains, or typed per estimate? A catalogue is more work and much more
   valuable — it is what makes the second estimate faster than the first.
2. **Sprinkler heads: catalogue or freehand?** Same trade-off. A head type with
   a default radius is what makes coverage circles meaningful.
3. **Does the customer ever see the plan?** If the drawing goes out with the
   quote, the legend and colours are customer-facing and need to look it. If it
   is internal-only, they can stay utilitarian.
4. **Pipe: do you want material takeoff, or just a length?** Length is trivial;
   sizing by run and fitting counts is real work.

## What I would NOT build

- **Automatic property outline detection.** Tempting, unreliable on satellite
  imagery, and wrong outlines are worse than none.
- **Irrigation hydraulics.** See the scope guard above.
- **A separate landscape tool.** The measuring, editing, saving and estimate
  join are already solved here; a second tool means maintaining two of
  everything and choosing which to open.
