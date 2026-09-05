# HANDOFF — a lawn estimating workspace, instead of a map bolted into the construction page

**For: GLM 5.3 Flash. Written 2026-09-04 by Claude Opus 5.**
**Base: `main`. Branch `feat/lawn-estimate-workspace`. Own worktree. Commit, do not push.**

---

## Why

The user: *"the estimator feels weird for a lawn maintence estimator, too many
things make it seem like its a construction one."*

They are describing the architecture, not a style problem. `LawnMeasurementMap`
is not its own tool — it is a section inside `src/app/estimates/[id]/page.tsx`,
a **1,394-line page shared with construction**, wrapped in `{isLawn() && …}`.
So a lawn measuring tool is reached through a construction quote page.

That page's own comment already concedes the squeeze:

> "squeezed into the ~600px main column alongside the pricing sidebar (its own
> internal sidebar + map need real width)"

## What to build

**A new route: `src/app/lawn/estimate/[id]/page.tsx`** — a full-width lawn
estimating workspace for one estimate.

Layout:
- **the map takes the screen** — it has its own internal sidebar and needs the
  width the shared page cannot give it
- **a tab bar**: `Measure` · `Items`
- **a line-item strip**: the estimate's line items with quantity, unit, rate and
  total, and a running total that moves as areas are priced — so the number
  updates while you work rather than after you leave

**Reuse `LawnMeasurementMap` as-is. Do not fork it.** Its props are:

```ts
estimateId: string
address: string | null
onAddLineItem: (line: { description: string; quantity: number;
                        unit: string; unit_price: number }) => void
```

The map already writes areas to `estimate_areas` itself and emits priced lines
through `onAddLineItem`. The workspace's job is to receive those, show them in
the strip, and persist them to the estimate's line items — the same write the
shared page performs today. Follow that page's existing save path rather than
inventing one.

## Only two tabs

`Landscape` and `Legend` are in the roadmap but **not in this lane.** They need
point and line geometry (sprinkler heads, pipe runs, plants), and
`estimate_areas` currently stores polygons only — there is no data model for
them yet. **Do not ship empty tabs**; build the two that have content and leave
the bar able to take more.

## The shared page

Replace the embedded `{isLawn() && <LawnMeasurementMap …>}` block in
`src/app/estimates/[id]/page.tsx` with a **link into the workspace** —
"Measure this property" or similar. Keep it behind `isLawn()` so construction
still renders nothing.

**Do not rebuild estimate editing.** Customer, terms, sending, the PDF and the
email preview all stay on the existing page and are out of scope. This lane
builds the measuring-and-pricing surface only, and hands the document side back.

## Rules

- **Match the existing gate.** `/estimates/[id]`'s role gate is not inline in
  the page — find how it is applied (layout, proxy, or wrapper) and use the
  same. Do not invent a stricter or looser one: sales reps reach quick quotes
  today and must not be locked out.
- Lawn only. Construction must be byte-identical — you are not changing
  `navItems.ts`, so verify nothing else leaks.
- RLS scopes every query. No manual `organization_id` filters.
- `react-hooks/set-state-in-effect` is enforced. No polling. Defer with
  `queueMicrotask` if you must set state from an effect.
- **Never `toISOString()` for "today"** — use `@/lib/orgDate`.
- Mobile matters: an operator measures a property on a phone in a driveway. The
  map must stay usable at 375px — the tab bar and strip should collapse, not
  squeeze the map.

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (13 pre-existing warnings are fine).

## Report back, with evidence

1. The workspace renders full width and the map is usable at 375px.
2. Pricing an area adds a line item to the strip AND persists to the estimate —
   say how you confirmed the persistence.
3. The running total updates as areas are priced.
4. `/estimates/[id]` links to the workspace instead of embedding the map, still
   behind `isLawn()`.
5. Construction renders nothing new — say how you checked.
6. Which gate you matched, and where you found it.

## Test data

`Terra Verde Test Co` — `600d02fa-fae2-440b-99ab-42e96997da91`. Fabricated; seed
and delete freely. `Peanutz L&L` — `d236eba1-8e84-4dae-a40d-ef2651cbbb9c` — is a
**real paying customer. Never write to it.**

## Process

Work in your own worktree, not the shared checkout — two lanes there once let a
path-scoped `git stash` sweep up another lane's uncommitted edits.
