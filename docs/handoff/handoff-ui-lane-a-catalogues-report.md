# Lane A report — catalogue screens, 2026-09-06

Executed per `handoff-ui-lane-a-catalogues.md` and `handoff-ui-state-of-play.md`.
Everything below is committed on **`feat/catalogue-screens-lane-a` (`3a2a85a`)**,
cut from `feat/desktop-ui-pass` so `DataTable` is present. Not pushed.

## What shipped

| Screen | File | Contents |
|---|---|---|
| `/lawn/irrigation` | `IrrigationProductsManager.tsx` (~560 ln) | Head models + nozzles, two-level expand |
| `/lawn/equipment` | `EquipmentProductsManager.tsx` (~700 lines) | Machinery, ownership-shaped form |
| `/lawn/labor-items` | `LaborItemsCatalogue.tsx` (~520 lines) | 38-row flat catalogue |
| `/lawn/plants` (existing) | `PlantCatalogueManager.tsx` | + search / category / active filter |

Page gates: all three new pages copy `/lawn/plants/page.tsx` —
`requireRole(OFFICE_OR_PM, "/dashboard")` + lawn-variant redirect, `force-dynamic`,
`listX(..., false)` so inactive rows stay visible and dimmed. Gates verified by
harness (office reaches, crew bounced) on all three.

Nav: four entries added to `navItems.ts` (Plants/Heads/Machines/Labor items).
⚠️ **`navItems.ts` is the desktop pass's file** — whoever lands second rebases;
I added entries without restructuring.

## Display rules verified by harness (not by reading the code)

All four harnesses run against the LIVE dev DB with the deactivate/restore
isolation discipline (scoped to E2E%, restore in success AND failure paths):

| Harness | Result |
|---|---|
| `e2e-irrigation-catalogue.mjs` (new) | 24/24 |
| `e2e-equipment-catalogue.mjs` (new) | 25/25 |
| `e2e-labor-items-catalogue.mjs` (new — beyond the two the lane doc mandates, because the labor screen was code-generated and needed its own proof) | 20/20 |
| `e2e-plant-catalogue.mjs` (extended with a 7-check search/filter phase) | 33/33 |

Key proofs: describeThrow renders BOTH numbers live while typing; radius 0
renders "throw not recorded", never "0 ft"; nozzle order is sort_order
(3.0 → 15-VAN → MP3000 — alphabetical would be 15-VAN, 3.0, MP3000); empty
rate boxes save NULL not 0; cheapestPlan picks the week for 5 days
("1 week · $450.00", never "5 days · $750"); the ownership toggle swaps the
rate fields and nulls the irrelevant half; the "quotes at zero" warning shows
in-form AND in-list; benchmarks appear as text and never pre-fill a box;
plant search matches botanical names and narrows 223 species to "1 of N".

## A real bug the harnesses found

**Drawer submit was unreachable on mobile.** The fixed mobile BottomNav
(`fixed bottom-0 z-50`, rendered after page content) intercepts pointer events
over the drawer's submit button at full scroll. Fixed with `pb-24` on all three
new drawer forms; **the older Plant/Chemical drawers predate this lane and were
left untouched — the desktop pass should apply the same clearance when it
touches them.**

## Contract notes (nothing edited, one flagged)

- Contracts used as-is everywhere; nothing re-derived. `updateX` error
  contracts (`string | null`) shape every error path.
- **Flagged for the contract owner**: `NewIrrigationProduct` carries no `active`
  while the update patch does — fine in practice (DB defaults true), noted so
  nobody "fixes" it by passing active on create.
- gpt-oss (local) generated a first draft of `LaborItemsCatalogue.tsx`; review
  caught 4 contract violations (destructuring a string-returning error, unused
  import, 0-cost wrongly chip-flagged "unpriced", raw unit slugs in the select).
  All fixed before commit. Lesson for future delegation holds: always verify
  generated code against the contract.

## For the other lanes

- **Lane B**: `/lawn/irrigation` is the model/nozzle data source you'd read;
  the nozzle `radius_ft` semantics ("throw FROM the head", 0 = not recorded)
  are documented in the manager file header.
- **Lane D**: `/lawn/irrigation-components` remains yours; nothing in Lane A
  touches `irrigationSystem.ts`.
- **Desktop pass**: `PlantCatalogueManager.tsx` now carries the filter bar; if
  you migrate it to `DataTable` the filter state must survive the migration
  (the harness's search phase is the regression net). Also apply the `pb-24`
  drawer fix noted above.

## Verification

- `npx tsc --noEmit` exit 0
- `npx eslint` clean on all changed files
- Dev server 3007 + live Supabase (Terra Verde Test Co only); Peanutz org
  untouched; security-audit lane's uncommitted files left out of the commit.