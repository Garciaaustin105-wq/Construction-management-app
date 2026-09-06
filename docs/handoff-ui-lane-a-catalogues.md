# HANDOFF — Lane A: irrigation + equipment catalogue screens, and plant search

> **READ `docs/handoff-ui-state-of-play.md` FIRST (2026-09-06).** It records
> what changed under this lane since it was written, and the rules added
> afterwards. Where the two disagree, the state-of-play note wins.
>
> This lane gained two catalogues it does not mention: labor items and irrigation components.


Three screens' worth of work, none of it touching the map or the workspace.
**Lane A owns: `src/app/lawn/irrigation/`, `src/app/lawn/equipment/`, new
`src/components/Irrigation*`/`Equipment*`, and `PlantCatalogueManager.tsx`.**
Do not edit anything else — lanes B and C are open on the map and the
workspace.

The worked example for all of this is `src/components/PlantCatalogueManager.tsx`
plus `src/app/lawn/plants/page.tsx`. Read them first. Match their structure,
their gates, their busy states. Two catalogue screens that behave differently
are worse than two that behave the same.

---

## 1. `/lawn/irrigation` — head models and nozzles

Contract: `src/lib/irrigationProducts.ts`. Use `listIrrigationCatalogue`,
`createIrrigationProduct`, `updateIrrigationProduct`, `createIrrigationNozzle`,
`updateIrrigationNozzle`, `deleteIrrigationNozzle`, `sortNozzles`,
`describeThrow`, `HEAD_CATEGORIES`.

Same two-level shape as plants: a MODEL expands to its NOZZLES.

| Level | Fields |
|---|---|
| model | name, category (`HEAD_CATEGORIES`), colour, notes, active |
| nozzle | nozzle label, **radius_ft**, cost, unit_price, install_minutes, sort_order |

**The radius field is the one to get right.** Label it **"Throw from the head
(ft)"**, never just "radius", and render `describeThrow(value)` live beneath
it as the user types:

```
30  →  "30 ft from the head · 60 ft across"
0   →  "throw not recorded"
```

That second line is the entire defence against someone entering the diameter.
No validation can catch it — 30 and 60 are both plausible throws — so the only
protection is showing both numbers at the moment of entry.

`radius_ft: 0` means NOT RECORDED. Render it as "—" or "not set", never "0 ft".
The seeded catalogue ships 54 nozzles in exactly that state, deliberately, so
this path is the common one, not an edge case.

---

## 2. `/lawn/equipment` — machinery

Contract: `src/lib/equipmentProducts.ts`. Use `listEquipment`,
`createEquipment`, `updateEquipment`, `rateAgeDays`, `cheapestPlan`,
`EQUIPMENT_CATEGORIES`, `OWNERSHIP`.

**This screen is NOT the plant screen with different words.** Equipment carries
two cost models and the form must change shape with the `ownership` toggle:

- **owned** → show `cost_hourly` (what it really costs you: depreciation, fuel,
  maintenance) and `price_hourly`. Hide the period rates and the fees.
- **rented** → show daily / weekly / monthly cost and price, plus
  `delivery_fee` and `pickup_fee`. Hide the hourly pair.

Every rate is nullable and **null means not recorded, never free**. An empty
box renders empty; it must not render `0`.

**Owned machinery with no `cost_hourly` deserves a visible warning on the row.**
That is the one that quotes at zero, makes a job look profitable, and wears the
machine out unfunded — the contract header says so and the UI has to carry it.

**Show `rateAgeDays`** on each row: "rates 41 days old", or "never priced" when
it returns null. Rental pricing moves and a stale rate quoted as current is a
silent margin leak.

**A live rate preview earns its place here.** Under the period rates, show what
`cheapestPlan` would charge for a few durations — 1 day, 5 days, 2 weeks — so
the estimator can see that 5 days takes the week. That is the single most
useful thing this screen can teach.

---

## 3. Plant catalogue: search and filter

`PlantCatalogueManager.tsx` has **no search, no filter, no pagination**. That
was fine at five species. The seeded catalogue is **223 species / 690 sizes**,
and it is now one unbroken scroll — the E2E harness's own locators became
unreliable in it, which is the same problem a person will have.

Add, above the list:

- a text search over common name AND botanical name (both — an installer knows
  one or the other, and botanical is the reliable key)
- a category filter using `PLANT_CATEGORIES`
- an active/inactive toggle, since deactivated species stay listed by design

Client-side filtering over the already-loaded array is fine; do not add a
server round trip. Keep the existing sort (active first, then category order,
then name) inside the filtered set.

**Do not add pagination.** Search plus category filter cuts 223 to a handful,
and pagination would fight the "everything on one page" shape the screen has.

---

## Rules for all three

- Match `PlantCatalogueManager`: drawer form, `editing`/`showForm`/`saving`/
  `busyId` state, optimistic toggle with rollback, mobile cards vs desktop
  table, deactivate-not-delete.
- Gate every page with `requireRole(OFFICE_OR_PM, "/dashboard")` plus the
  lawn-variant redirect, exactly like `/lawn/plants/page.tsx`. The RLS policies
  on both new tables are `tier_office_or_pm`, so the gate must match.
- Tailwind + lucide-react only. No new dependency.
- Every write busy-gated and disabled in flight.
- **Never render a null rate or an unrecorded radius as `0`.** That single rule
  is behind more of this contract's design than anything else.
- `npx tsc --noEmit` exit 0, `npx eslint` clean.

## Verify

Commit `e2e-irrigation-catalogue.mjs` and `e2e-equipment-catalogue.mjs` at the
repo root (convention: `e2e-*.mjs`; there is no `Tools/` dir).

**Read `e2e-plant-catalogue.mjs` first and copy its isolation discipline** —
it deactivates the org's real catalogue, scopes every delete and every REST
read to its own `E2E%` rows, and restores on the failure path too. An earlier
version wiped the whole org and destroyed a seeded catalogue silently. Do not
reintroduce that.

Cover at least: create model → add nozzle → REST-verified; `describeThrow`
renders both numbers; radius 0 renders as unset not "0 ft"; the ownership
toggle swaps which rate fields show; an owned machine with no hourly cost is
warned; plant search narrows 223 species and the category filter works.
