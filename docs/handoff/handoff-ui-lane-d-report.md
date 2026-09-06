# Lane D report — irrigation components catalogue + mainline (UI)

Shipped on `feat/irrigation-components-lane-d`, cut from origin
`feat/irrigation-heads-on-map` tip (`526b2eb`). Per
`docs/handoff/handoff-ui-lane-d-controls-and-mainline.md`, governed by
`docs/handoff/handoff-ui-state-of-play.md`.

## What shipped

| File | What it is |
| --- | --- |
| `src/components/IrrigationComponentsManager.tsx` | Catalogue manager for irrigation COMPONENTS — the flat, two-unit catalogue (`each` \| `foot`). |
| `src/app/lawn/irrigation-components/page.tsx` | Server shell: `requireRole(OFFICE_OR_PM)` + lawn-variant gate, seeded with `listComponents(..., activeOnly=false)` so retired rows are visible and dim. |
| `src/lib/navItems.ts` | One nav entry: `/lawn/irrigation-components` ("Components", CircuitBoard icon), gated `OFFICE_OR_PM` to match the RLS tier and the rest of the catalogue block. |
| `e2e-irrigation-components-ui.mjs` | Browser harness, Terra Verde Test Co only, committed per the lane doc. |

## Design decisions

- **DataTable, not a hand-rolled table.** Manager follows
  `ChemicalProductsManager.tsx` (the state-of-play's worked example) and Lane
  A's conventions: search + category filter + show-inactive toggle, unpriced
  chip (price ≤ 0), untimed chip (man-min ≤ 0), `(inactive)` dim marker,
  `pb-24` on the drawer form (fixed mobile BottomNav otherwise overlays the
  submit), optimistic toggle-active with rollback.
- **Deactivate, never delete.** The contract ships no delete — and snapshots
  inside `estimate_components` must survive, so rows are retired, not removed.
- **The unit trap is surfaced, not hidden.** The drawer's unit option reads
  `foot (quantity IS feet — wire, mainline, sleeving)`; helper text spells out
  the per-foot math (`200 ft at 0.5 man-min/ft is 100 man-minutes`); the price
  helper says `0 stays unpriced, never free`. NumberInput (decimal-safe) is
  used throughout — no `step="1"` anywhere.
- **Backflow/rain-sensor honesty.** The notes helper says it outright:
  backflow type, height, permits and annual testing are set by LOCAL CODE —
  the org writes what its installer knows about the jurisdiction; the app
  never asserts a code requirement.
- **The contract is imported, never re-derived.** All CRUD and reading goes
  through `src/lib/irrigationSystem.ts` (`createComponent`, `updateComponent`,
  `listComponents`). `updateComponent` returns `string | null` and is consumed
  as such. Nothing in this lane edits the contract.

## Verification

- **Maths harness, run unchanged:** `e2e-irrigation-components.mjs` →
  **66 passed, 0 failed**. Note: the lane doc says 59 assertions; the harness
  has grown to 66 since the doc was written. Ran as-is per the doc.
- **UI harness (committed):** `e2e-irrigation-components-ui.mjs` →
  **19 passed, 0 failed**. Covers: seeded rows render with unit/unpriced/notes;
  a per-foot component created through the drawer lands in REST with every
  field typed as entered AND its id (the `.select()` round-trip the UI must
  not lose); search matches name AND notes; category filter narrows; price
  edit round-trips (45 → 52); deactivation dims with `(inactive)`; per-foot
  marker survives a reload; the estimate-side invariants (below); no page
  errors. Isolation: the org's real components are DEACTIVATED and restored;
  deletes scoped to `E2E UI%`; cleanup in `finally` before `process.exit`.
- **Whole tree:** `npx tsc --noEmit` → 0 errors. `npx eslint src` → 0 errors,
  13 warnings — all pre-existing in files outside this lane
  (change-orders routes, EstimateTemplatesManager, KanbanBoard, emailPreview);
  zero in Lane D files. (User-mandated whole-tree run because Lanes A and B
  changed shared code.)

## FLAGS

1. **Origin tip does NOT contain Lane C's estimator panels.**
   `src/components/estimator/ComponentsPanel.tsx` and the Parts tab are absent
   from `feat/irrigation-heads-on-map` (Lane C lives on
   `feat/estimator-panels-lane-c` and merges separately). The user's handoff
   note said Lane C "already shipped ComponentsPanel" — true on its branch,
   but it is not on this base, so there was nothing to wire to here. Adapted:
   the harness's estimator phase is **conditional** — it detects the Parts tab
   at runtime (`hasParts`). Today it takes the data-level fallback: it proves
   the invariants by REST-inserting exactly the row the panel writes (full
   snapshot + per-unit billable line), then re-prices the catalogue and proves
   the snapshot kept the old price. When Lane C merges, the same harness
   automatically runs the full UI round-trip (picker withholding the
   deactivated valve, preview math, unpriced add button refused, rendered row
   unmoved after re-pricing) with no harness changes. The UI write path itself
   is already covered by `e2e-estimator-panels.mjs` (44/44) on Lane C's branch.
2. **Branch base.** Cut onto origin tip via `git checkout -B` (the security
   lane's 4 dirty files are byte-identical across both heads and carried
   over). A plain rebase from Lane C's branch would have replayed Lane C's
   three commits as duplicates; `checkout -B` avoids that. Lane D's diff on
   origin tip is purely additive: one new page dir, one new manager, one new
   harness, one nav entry.
3. **Contract observations: none.** `irrigationSystem.ts` was read in full and
   honored as-is; nothing looked wrong, so nothing was reported for change.

## Not in this lane

The estimate-side "add components to an estimate" panel — Lane C's
`ComponentsPanel`, already shipped on its branch. This lane owns the catalogue
the panel is fed by.