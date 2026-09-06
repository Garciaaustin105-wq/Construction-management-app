# Lane C report — estimator panels

Branch `feat/estimator-panels-lane-c`, commit `1f1550b`.
Lane doc: `handoff-ui-lane-c-estimator-panels.md`; governed by
`handoff-ui-state-of-play.md`.

## What shipped

Seven panels in `src/components/estimator/` wired into
`LawnEstimateWorkspace.tsx`'s `panelSlot` as the tabs
Plants / Sod / Pipe / Drip / Parts / Labor / Machines:

- `SodPanel.tsx` — assign a sod product to a measured area; gross = net +
  waste %; pallets ceiled up; bought/leftover shown; billed on gross.
  Per-job pallet override writes FLAT into area meta (SOD_META_KEYS),
  never the catalogue.
- `PipePanel.tsx` — straight / routed / total-to-buy with contract rounding
  order; allowances COMPOUND (1.30 × 1.10 = 1.43).
- `DripPanel.tsx` — head-overlap prompt waits for a choice; Remove persists
  `drip_config.excluded_plant_ids`; Leave is session-local.
- `ComponentsPanel.tsx` — irrigation components; "Use measured pipe"
  fills quantity from the Pipe panel's live total.
- `LaborItemsPanel.tsx` — labor item + quantity in ONE call that writes both
  the `estimate_labor_items` snapshot row and the billable line.
- `EquipmentPanel.tsx` — rented takes days → cheapest plan; owned takes
  hours; plan (basis) and mobilization shown separately; unpriced-owned and
  needsOperator warnings.

First-ever writes to `estimate_labor_items`, `estimate_components`,
`estimate_equipment` — all draft-only, optimistic with rollback,
busy-gated, exactly like `saveLaborSettings`.

## Verification

- `npx tsc --noEmit` exit 0; `npx eslint` clean on all Lane C files.
- `e2e-estimator-panels.mjs` at repo root: **44 pass, 0 fail** against
  live dev (`next dev -p 3007`) + live Supabase, with REST proofs for
  every write (flat sod meta, `estimate_components` row, drip_config
  persistence, two `estimate_equipment` rows days/hours split, labor row,
  six billable lines all with non-null `internal_cost`).
- Harness follows `e2e-plant-placement.mjs` isolation: real catalogue rows
  DEACTIVATED and restored (never deleted), every delete and REST read
  scoped to `E2E%`, cleanup in `finally` before `process.exit`.
- **Maps disclosure:** the harness mounts a `google.maps` STUB (no tiles,
  synthetic geometry) and dev runs with a throwaway
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=e2e-stub-local-only` in `.env.local`
  (machine-local, NOT committed) so `loadGoogleMaps()` takes its
  already-loaded branch. Real key stays Vercel-only.

## A bug found and fixed before it could block anything

The three new child tables have `organization_id uuid NOT NULL` with **no
default and no `set_org_from_estimate()` trigger** (that trigger exists
only on `estimates` and `estimate_line_items`). Every panel insert would
have failed with a NOT NULL violation. Fixed on the workspace side: all
three inserts now pass `organization_id: estimate.organization_id`
explicitly.

## Flags for the owner

1. **Org-fill triggers — RESOLVED.** DB convention says children get
   `set_org_from_estimate()` BEFORE-INSERT triggers. After owner sign-off,
   migration `org_triggers_estimator_child_tables` was applied to
   production (3 CREATE TRIGGERs on `estimate_labor_items` /
   `estimate_components` / `estimate_equipment` using the existing
   function) and verified in `pg_trigger` — all six
   `trg_estimate_*_org` triggers now present. The workspace-side
   `organization_id` supply stays as the primary mechanism; the triggers
   are the belt for any other write path.
2. **Pipe allowances are session-local.** Routing/waste percentages live
   in panel state only — no DB column, no persistence. Reload resets
   them. The lane doc does not require persistence; flagged in case the
   owner wants allowances saved per estimate.
3. **Drip "Leave" is session-local by design** (the lane example says the
   prompt must wait for a choice and Remove must persist; Leave returns
   on reload). E2E-proven both ways.
4. **Branch base.** `feat/estimator-panels-lane-c` was cut from
   `feat/desktop-ui-pass` head (`7c372c1`), which has itself diverged
   from `origin/main`. Merging Lane C to main will need that base
   reconciled first.
5. **PlantCatalogueManager is Lane A's** (per state-of-play) — the
   catalogue-menu link points at it but no changes were made here.
6. **`package.json` / `package-lock.json` untouched here** — they carry
   uncommitted security-audit-lane changes and were deliberately excluded
   from the Lane C commit, as were `src/lib/supabase/admin.ts`,
   `docs/deploy-safety.md` and `function_execute_hardening_v4.sql`.

## Contract notes

No contract was edited. Everything priced through
`sodProducts` / `irrigationProducts` / `laborItems` / `equipmentProducts`
as written; the E2E harness replicates the contract math (including the
waste-applies-to-UNROUNDED-routed rounding order and allowance
compounding) and the rendered strings match to the cent.