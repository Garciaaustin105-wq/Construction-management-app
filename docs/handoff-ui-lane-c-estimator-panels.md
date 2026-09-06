# HANDOFF — Lane C: sod, pipe, drip and equipment panels

**Lane C owns `src/components/LawnEstimateWorkspace.tsx` and new panel
components.** Lane A is in the catalogue screens, Lane B is in the map. Do not
touch either.

The worked example is `src/components/LandscapeLaborPanel.tsx` — a presentational
panel plus controlled inputs, fed by props, saving through the parent. Four more
of the same shape.

All four panels mount in the workspace's `panelSlot`, which already injects into
the map's floating panel. That seam is why none of this needs to touch the map.

---

## The rule that governs every panel here

**A null or zero rate is NOT a free one.** Every contract in this lane returns
`null` for "not recorded" and provides a matching flag. Rendering any of them as
`0`, `$0.00` or a blank where a number belongs is the failure mode all of this
was built to prevent:

| Contract | Flag | Means |
|---|---|---|
| `sodProducts` | `palletSizeUnset` | pallet count cannot be computed |
| `irrigationProducts` | `radiusUnset` | no throw distances recorded |
| `equipmentProducts` | `charge.unpriced` | owned machine quoting at zero |
| `plantProducts` | `installTimeUnset` | labor quoting at zero |

---

## 1. Sod panel

Contract: `src/lib/sodProducts.ts`. `listSodProducts`, `sodSnapshot`,
`sodEstimateForArea`, `describePallet`, `sodLineItem`, `palletSizeUnset`.

Sod attaches to a **measured area**, not a placed point — the polygon is already
on the map. Assigning sod writes `sodSnapshot(...)` into that area's `meta`
through `updateEstimateArea`. **Read-modify-write the whole meta object**; do
not construct a fresh one.

Show, per sodded area:

```
Front lawn         4,200 sq ft measured
+ 10% cutting waste  →  4,620 to cover
11 pallets           assuming 450 sq ft per pallet
                     330 sq ft left over
```

Three things must be on screen together, because each answers a different
question: **gross sqft** is what the customer buys, **pallets** is what you
order, and **leftover** is what you paid for and will not lay.

`describePallet(n)` gives the assumption line. The pallet size is **editable per
job** — a farm ships 500 one week and 400 the next, and on this job that is the
difference between 11 pallets and 12. Editing it must not touch the catalogue.

## 2. Pipe panel

Contract: `src/lib/irrigationProducts.ts`. `headPoints`, `pipeEstimate`.

`pipeEstimate(headPoints(areas), { routingPct, wastePct })` returns three
numbers and **all three belong on screen**:

```
straight line   90.0 ft    shortest run connecting the heads
+ 30% routing  117.0 ft    the trench you will actually dig
+ 10% waste    128.7 ft    the pipe to buy
```

**Two allowance fields, not one.** They are different quantities and folding
them together under-buys: routing is 20-40% (beds, drives, zone splits) and
waste is the familiar 5-10% for cut-offs. They compound rather than add.

Label them so the difference is unmistakable, and carry the caveat: the
straight-line figure is a **floor**, and it excludes the mainline, backflow and
controller run, because none of those are placed on the map.

`segments` is returned so the map could draw what was measured — but drawing is
Lane B's file. Ignore it here.

## 3. Drip panel

Contract: `src/lib/irrigationProducts.ts`. `readDripConfig`, `dripTally`,
`dripLineItem`, `plantsInHeadCoverage`.

Emitters are **counted from the plants already on the map**, not placed. Set an
emitter product and a per-category rule ("every tree 4, every shrub 1"), stored
in `estimates.drip_config`. Placing a tree then prices its drip with no extra
clicks.

**The head-overlap flag is the interesting part.** `plantsInHeadCoverage(areas)`
returns plants sitting inside a placed head's throw, each with the head's name.
Surface it as a prompt:

> 6 plants are inside a Rain Bird 5000's throw. Leave their emitters, or remove
> them?

**Leave / Remove, and nothing happens without a choice.** `dripTally` drops
nothing unless you pass the ids in. The app measures geometry; whether a plant
is adequately watered is the designer's call — a tree under a canopy the spray
never reaches reads as covered and is not. Silently removing emitters would lose
that plant's water with nobody seeing it happen.

## 4. Equipment panel

Contract: `src/lib/equipmentProducts.ts`. `listEquipment`, `equipmentSnapshot`,
`equipmentCharge`, `equipmentTotals`, `equipmentLineItem`, `cheapestPlan`.

Machines are added to `estimate_equipment` with a quantity and a duration —
**days for rented, hours for owned**. The form must ask for the right one based
on `ownership`.

Show the chosen plan, not just a total: `charge.basis` gives "1 week + 2 days",
which is what makes the number checkable and teaches that 5 days takes the week.
Show `mobilization` separately — delivery and pickup are once per machine, not
per day.

Two warnings:

- `charge.unpriced` on an owned machine → "no hourly cost set — this machine is
  quoting at zero"
- `totals.needsOperator` with no labor on the estimate → the machine has nobody
  to run it

## Line items

All four use the same `addMeasuredLines` path already in the workspace. Note it
takes an ARRAY: calling the single-line version in a loop cannot work, because
the append is a read-delete-reinsert guarded by `persisting` and every line
after the first vanishes silently. That bug is fixed; do not reintroduce it by
looping.

Every `*LineItem` returns **null when there is nothing billable**. Respect it —
no `$0` line reaches a customer quote.

## Rules

- Import from the contracts. Re-derive nothing. If a contract looks wrong, say
  so in your report — do not edit it.
- Panels are presentational plus controlled inputs; the workspace owns saving,
  optimistically with rollback, draft-only, exactly like `saveLaborSettings`.
- Tailwind + lucide-react only, no new dependency.
- Every write busy-gated and disabled in flight.
- `npx tsc --noEmit` exit 0, `npx eslint` clean.

## Verify

Commit `e2e-estimator-panels.mjs` at the repo root, following the isolation
discipline in `e2e-plant-placement.mjs` (deactivate, scope every delete and REST
read to `E2E%`, restore on the failure path).

Cover: sod on an area gives the right pallet count and leftover, and the
per-job pallet override changes the count without touching the catalogue; the
pipe panel shows all three figures and the two allowances compound; the drip
overlap prompt appears and **changes nothing until a choice is made**; an owned
machine with no rate is warned rather than billed at zero; and every panel's
"add to estimate" produces one line with a non-null `internal_cost`.
