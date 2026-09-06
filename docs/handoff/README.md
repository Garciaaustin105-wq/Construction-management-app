# Handoffs

Specs written for another agent to implement. Most are finished work kept for
the reasoning in them; a handful are live.

**If you were pointed at one of these, read
[`handoff-ui-state-of-play.md`](handoff-ui-state-of-play.md) first.** It records
what has changed underneath the lane specs and which rules were added after they
were written. Where a lane doc and the state-of-play note disagree, the note
wins.

## Live — the quick estimator UI

| Doc | Lane | State |
|---|---|---|
| [state-of-play](handoff-ui-state-of-play.md) | — | **Read first.** What is actually true as of 2026-09-06 |
| [lane C](handoff-ui-lane-c-estimator-panels.md) | Estimator panels | **Highest value.** Nothing yet writes `estimate_labor_items` or `estimate_components` |
| [lane A](handoff-ui-lane-a-catalogues.md) | Catalogue screens | Gained labor items and irrigation components |
| [lane B](handoff-ui-lane-b-heads-on-map.md) | Heads on the map | Unchanged, can start cold |
| [lane D](handoff-ui-lane-d-controls-and-mainline.md) | Components UI | Contract merged; UI only |

The lanes own disjoint files — A the catalogue screens, B
`LawnMeasurementMap.tsx`, C `LawnEstimateWorkspace.tsx`, D the component UI. If
a lane edits a file another lane owns, that is a rebase, not a merge.

A separate desktop-UI pass owns `navItems.ts` and the shared layout. Its brief
is not in this folder yet — it was still uncommitted when these were filed.

## Background for the estimator work

- [plant catalogue](handoff-plant-catalogue.md) · [rework](handoff-plant-catalogue-rework.md) · [seeding](handoff-plant-catalogue-seeding.md)
- [plant map placement](handoff-plant-map-placement.md) — the pattern heads reuse
- [plant import parser](handoff-plant-import-parser.md)
- [labor settings panel](handoff-labor-settings-panel.md)
- [lawn estimate workspace](handoff-lawn-estimate-workspace.md)
- [estimator v2](handoff-estimator-v2-2026-08-28.md)

Research that these depend on lives outside this folder, in
[`../labor-production-rates.md`](../labor-production-rates.md).

## Conventions every spec here assumes

- Import from the contract in `src/lib/`. Re-derive nothing. If a contract looks
  wrong, say so in the report rather than editing it.
- Snapshot the catalogue row onto the estimate, so re-pricing never moves a
  quote already sent.
- A null or zero price is not a free one, and a blank rate is not zero work.
  Empty renders empty.
- `kind` is GEOMETRY, `meta` is WHAT THE THING IS. Anything reading
  `estimate_areas` points discriminates on meta.
- `npx tsc --noEmit` exit 0 and `npx eslint` clean before reporting.
- Commit a harness, and copy the isolation discipline from
  `e2e-plant-placement.mjs` — deactivate the org's real catalogue, scope every
  delete and REST read to `E2E%`, restore on the failure path. An earlier
  version of these harnesses wiped a whole org silently.
- Test org is Terra Verde Test Co, `600d02fa-fae2-440b-99ab-42e96997da91`.
  **Never read or write `d236eba1-8e84-4dae-a40d-ef2651cbbb9c`** — live customer.
