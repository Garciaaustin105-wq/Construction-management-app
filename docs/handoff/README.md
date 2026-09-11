# Handoffs

Specs written for another agent to implement. Most are finished work kept for
the reasoning in them; a handful are live.

**If you were pointed at one of these, read
[`handoff-ui-state-of-play.md`](handoff-ui-state-of-play.md) first.** It records
what has changed underneath the lane specs and which rules were added after they
were written. Where a lane doc and the state-of-play note disagree, the note
wins.

## Live — camera-platform (the NVR replacing OpenEye)

| Doc | What it is |
|---|---|
| [camera-platform → A2](handoff-camera-platform-a2-opus.md) | **Start here for anything camera-related.** Where the subsystem lives, the five decisions that surprise people, what the 209 checks cover, and the A2 local-API task |

This work is **not in `src/`** and **not on `main`** — it is `camera-platform/` at
the repo root, on branch `claude/camera-service-plan-uwr6st`. It has its own
tsconfig and its own harnesses, and nothing in `src/` imports it. That is why
searching the app for it comes back empty.

## The quick estimator UI — all four lanes SHIPPED

| Doc | Lane | State |
|---|---|---|
| [state-of-play](handoff-ui-state-of-play.md) | — | **Read first.** What is actually true as of 2026-09-06 |
| [lane A](handoff-ui-lane-a-catalogues.md) | Catalogue screens | Shipped — every catalogue has a screen |
| [lane B](handoff-ui-lane-b-heads-on-map.md) | Heads on the map | Shipped |
| [lane C](handoff-ui-lane-c-estimator-panels.md) | Estimator panels | Shipped — six panels, both estimate tables written |
| [lane D](handoff-ui-lane-d-controls-and-mainline.md) | Components UI | Shipped |

**These are records now, not tasks.** Each lane also has a `-report.md`
alongside it. Read the code before acting on any of these specs: three of the
four will send you to build something that already exists.

The lanes owned disjoint files — A the catalogue screens, B
`LawnMeasurementMap.tsx`, C `LawnEstimateWorkspace.tsx`, D the component UI. If
you edit a file another lane owns, that is a rebase, not a merge.

## Live — the desktop UI pass

| Doc | What it is |
|---|---|
| [desktop pass brief](handoff-ui-desktop-pass.md) | The contract: 5 phases, design decisions locked, one hard rule (lg:-and-up only, mobile byte-identical) |
| [desktop pass → Opus](handoff-ui-desktop-pass-opus.md) | The handoff letter: phase order, division of labor, gotchas |

This pass owns `navItems.ts` and the shared layout (`PageContainer`, `TopBar`,
`DataTable`, `Sidebar`). Estimator lanes: add a nav entry if your screen needs
one, expect to rebase, and do not restructure that file. It also migrates the
hand-rolled `hidden lg:block` tables — including `PlantCatalogueManager.tsx`,
which is Lane A's file — so coordinate before Phase 2 lands there.

## Also shipped

| Doc | What it is |
|---|---|
| [site import](handoff-site-import.md) | Field measurements (Moasure, GNSS rover, drone/surveyor files) alongside the map. One CSV importer, not a per-device integration. Live at `/lawn/estimate/[id]/import`, with two-point anchoring. |

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
