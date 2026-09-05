# HANDOFF — plant & tree catalogue UI

Phase 2 of `docs/quick-estimator-roadmap.md` §3. **This handoff is the
catalogue screen only.** Placing plants on the map is a separate, later
handoff — do not build map code here.

## What already exists (do not rebuild)

| Thing | Where | Status |
|---|---|---|
| `plant_products` table + RLS | `plant_products.sql` | written; **apply before testing** |
| Types, CRUD, legend math | `src/lib/plantProducts.ts` | done, typechecked, tested |
| The pattern to copy | `src/app/lawn/products/page.tsx` + `src/components/ChemicalProductsManager.tsx` | shipped and working |

`src/lib/plantProducts.ts` is the contract. **Import from it. Do not write
Supabase queries inline and do not re-derive any of its math** — that is the
whole reason it exists. You need `PLANT_CATEGORIES`, `PlantProduct`,
`NewPlantProduct`, `listPlantProducts`, `createPlantProduct`,
`updatePlantProduct`, `deactivatePlantProduct`.

Everything below `// Placement` in that file is for the *next* handoff. Ignore
it here.

## Read this first

`src/components/ChemicalProductsManager.tsx` (549 lines) is the worked example
and it is the same screen with different fields. Read it before writing
anything. You are building the plant equivalent, matching its structure,
its state shape (`Draft` / `EMPTY` / `editing` / `showForm` / `saving` /
`busyId`), its toast usage, and its styling. **Match it; do not improve on
it.** Two catalogue screens that behave differently is worse than two that
behave identically.

## Build exactly two files

### 1. `src/app/lawn/plants/page.tsx`

A near-copy of `src/app/lawn/products/page.tsx`. Same server shell, same gate,
same shape:

- `requireRole(OFFICE_OR_PM, "/dashboard")` — matches the
  `plant_product_office_all` RLS policy (`tier_office_or_pm`) exactly. This is
  the role-gate-mismatch pattern; keep them aligned.
- Same lawn-variant gate: `if (me.appVariant !== "lawn") redirect("/dashboard")`.
  The estimator is lawn-only.
- Seed the client component with the org's plants via RLS, ordered by name.
- `TopBar title="Plants & Trees" subtitle="Catalog"`.
- Keep `export const dynamic = "force-dynamic"` to match the neighbouring page.
  (It is redundant — `cookies()` already forces dynamic rendering — but every
  page in this directory carries it and consistency is worth more than
  removing one no-op line.)

### 2. `src/components/PlantCatalogueManager.tsx`

Client component, `"use client"`, CRUD straight through RLS via
`src/lib/plantProducts.ts`. Props: `{ initial: PlantProduct[]; orgId: string }`.

**Fields in the form**, in this order:

| Field | Control | Notes |
|---|---|---|
| `name` | text | required — refuse to save empty, `toast.warning` like the chemical form does |
| `category` | select over `PLANT_CATEGORIES` | default `"shrub"` |
| `size` | text | free text. Placeholder: `30 gal, #5, 2in cal, B&B` |
| `unit_price` | `NumberInput` | installed price per plant, in dollars |
| `color` | swatch picker | reuse `AREA_COLORS` from `@/lib/estimateAreas` — the map already cycles that palette, and a plant's legend swatch must be able to sit next to an area's |
| `notes` | textarea | optional |
| `active` | checkbox | same deactivate-not-delete semantics |

**Deactivate rather than delete**, for the same reason the chemical manager
does, and say so in the UI copy: a placed plant snapshots its own name, size
and price into the estimate, so deleting is safe for history — but the
catalogue is the record of what the org sells, and a deleted row cannot be
placed again. Keep a Delete for genuine typos, warn on it, and keep inactive
rows visible but dimmed.

**List display:** group or sort so trees read above shrubs. `PLANT_CATEGORIES`
is already in planting-plan order (canopy → groundcover); use its index, the
way `buildPlantLegend` does. Show the colour swatch, name, size, and price per
row.

**Empty state:** this catalogue starts empty for every org, so the empty state
is the first thing every user sees. It must explain what the screen is for in
one sentence and offer the add button — not a bare "No plants".

## Rules

- Tailwind only, matching the surrounding style. No new dependency.
- `lucide-react` icons only — the chemical manager uses `Loader2, Pencil, Plus,
  Trash2, X`; `Trees` or `Sprout` is the right lead icon here.
- Every write needs a busy state and must be disabled while in flight. This
  repo has already shipped a double-submit bug from a missing one
  (`crew/photo`); do not add another.
- `orgId` comes from the prop, never from a client-side lookup.
- `npx tsc --noEmit` must exit 0 and `npx eslint` must be clean on both files.

## Do not

- Touch `LawnMeasurementMap.tsx`, `LawnEstimateWorkspace.tsx`, or anything
  under `src/lib/estimateAreas.ts`.
- Add a nav link yet — where this lives in the estimator's tab bar is decided
  in the next handoff, and a link to a screen with an empty catalogue is worse
  than no link.
- Seed default plants. Species and prices are regional; a Florida palm list on
  a Colorado org is wrong data presented as help.

## Verify before reporting done

1. `npx tsc --noEmit` → exit 0.
2. `npx eslint src/app/lawn/plants/page.tsx src/components/PlantCatalogueManager.tsx` → clean.
3. State plainly whether you were able to run the page against the database. If
   the migration has not been applied yet, say so rather than claiming the CRUD
   works.
