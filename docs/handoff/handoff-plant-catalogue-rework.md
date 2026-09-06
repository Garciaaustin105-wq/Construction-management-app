# SPEC — rework the plant catalogue screen for species + sizes

You built `/lawn/plants` on `feat/plant-catalogue-ui` (`2c8aece`, 558 lines).
It was correct when you wrote it. The schema was then restructured underneath
you and it no longer compiles. **That is not your mistake** — a shared contract
changed after your lane had branched, and you were not told.

**Rebase and rework. Do not restart.** Most of what you built survives.

## Step 0 — rebase

Your branch is based on `caec1d2`. Rebase onto `feat/plant-catalogue`, which
is now pushed — fetch it rather than relying on a local copy. The only
conflicts should be in the two files you own.

```
git fetch origin
git rebase origin/feat/plant-catalogue
```

## What broke, exactly

| Your code | Reality |
|---|---|
| `listPlantProducts(...)` | deleted — now `listPlantCatalogue(...)` |
| `PlantProduct.size` (15 refs) | **column dropped from the database** |
| `PlantProduct.unit_price` (11 refs) | **column dropped from the database** |

## The new shape

A species and a size are now different rows.

- **`plant_products`** = the SPECIES. Identity only: `name`,
  `botanical_name`, `category`, `color`, `notes`, `active`. **No price.**
- **`plant_product_sizes`** = what you actually buy and sell: `size`, `cost`,
  `unit_price`, `install_minutes`, `sort_order`, `active`.

One Dwarf Yaupon Holly → four sizes → four costs and four prices. That is the
whole reason for the change: flattening it meant four rows to type and four to
fix for one misspelled name.

`listPlantCatalogue` returns `PlantWithSizes[]` — species with `sizes` already
nested **and already ordered**. Do not sort sizes yourself, and never sort them
alphabetically: `"15 gal"` sorts before `"3 gal"`. That is what `sort_order`
and `sortSizes` exist to prevent.

## KEEP all of this — it is not affected

Do not rewrite, restyle or "improve" any of it while you are in there:

- the drawer form and its open/close flow
- `editing` / `showForm` / `saving` / `busyId` state and every busy gate
- optimistic `toggleActive` with rollback
- mobile cards vs desktop table split
- deactivate-not-delete, including the `confirm()` copy explaining that placed
  plants snapshot their own values
- active-first → `PLANT_CATEGORIES` index → name sorting
- `Trees` lead icon, lucide-react only, Tailwind only
- **both findings from your E2E run** — the desktop context needing its own
  `page.on('dialog')`, and mobile cards having no delete button so that phase
  must run at 1440px. Those cost you two iterations to discover; do not
  rediscover them.

**Your harness itself is gone.** It was never committed (`2c8aece` contains
only the two source files) and the worktree it lived in has been removed. That
is the one thing you do have to rewrite — see EDIT 5, and commit it this time.

## EDIT 1 — `src/app/lawn/plants/page.tsx`

Swap the contract call. Everything else about this file stays.

```tsx
import { listPlantCatalogue } from "@/lib/plantProducts";
import type { PlantWithSizes } from "@/lib/plantProducts";

const { data } = await listPlantCatalogue(supabase, me.orgId ?? "", false);
```

Keep passing `false` for `activeOnly` — you were right that the manager needs
retired rows to dim them. Note it also keeps retired SIZES visible now.

## EDIT 2 — `Draft`, `EMPTY`, `toDraft` become species-only

Delete `size` and `unit_price`. Add `botanical_name`.

```tsx
type Draft = {
  name: string;
  botanical_name: string;
  category: PlantCategory;
  color: string;
  notes: string;
  active: boolean;
};
```

`EMPTY` keeps `category: "shrub"` and your comment about why. `toDraft` maps
`botanical_name: p.botanical_name ?? ""`.

In `save`, the payload drops `size`/`unit_price` and gains
`botanical_name: draft.botanical_name.trim() || null`. Your blank-to-null
reasoning was right and still applies.

## EDIT 3 — state type

`useState<PlantProduct[]>` → `useState<PlantWithSizes[]>`. When you create a
species, push it with `sizes: []`.

## EDIT 4 — the size editor (the actual new work)

Each species row expands to its sizes. One species open at a time.

**A size row shows:** size · cost · price · **margin** · install time, plus
edit and delete.

**Adding/editing a size** — fields, all `NumberInput` except `size`:

| Field | Notes |
|---|---|
| `size` | text, required. Placeholder `3 gal, #5, 2in cal, B&B` |
| `cost` | what the nursery charges you, per plant |
| `unit_price` | what the customer pays, installed |
| `install_minutes` | **MAN-minutes** to plant one — two people × 10 min = 20. Label it man-minutes |
| `sort_order` | **do not show it.** Assign by position in the list |

Use `createPlantSize`, `updatePlantSize`, `deletePlantSize` from the contract.
Sizes get a real `deletePlantSize` (unlike the species, where you correctly
went inline) — use it rather than another inline `.delete()`.

**Three display rules that matter more than they look:**

1. **Margin** comes from `marginPct(cost, unit_price)` and must be labelled
   **material margin** — install labor is deliberately not in `cost`. An
   unqualified "72%" on a 30 gal tree is a misleading number to put in front of
   a business owner.
2. `marginPct` returns `null` when there is no price. Render that as `—`,
   **never as "0%"**. Missing is not zero.
3. `install_minutes: 0` means **not estimated**, not free. Render it as `—` or
   "not set". A zero here silently quotes labor at nothing, which is the exact
   failure the field was added to prevent.

**Collapsed species row** shows the colour swatch, name, category, and a size
summary — `4 sizes · $16–$140`. A species with no sizes yet shows
**"No sizes yet"** and an add button: it cannot be placed on a map or priced
until it has one, so that state needs to look unfinished rather than fine.

## EDIT 5 — rewrite the E2E harness, and COMMIT it

It goes at the **repo root** as `e2e-plant-catalogue.mjs`, matching the
existing convention (`e2e-chemicals-test.mjs`, `e2e-settlement.mjs`,
`e2e-manhours.mjs`, …) — not under `Tools/`, which does not exist.

Read one of those first and follow its shape. Re-cover what you had (empty
state, add, edit, deactivate, delete, sort order) and add:

1. add a species → add two sizes → both persist, REST-verified
2. sizes render in `sort_order`, **not** alphabetically — assert a species with
   `3 gal`, `7 gal`, `15 gal` renders in that order (alphabetical would give
   `15, 3, 7`, so this is a real assertion, not a tautology)
3. margin renders for a priced size and `—` for an unpriced one
4. delete a species with sizes → sizes go too (the FK cascades; verified in SQL,
   assert the UI agrees)

## Rules

- `npx tsc --noEmit` exit 0; `npx eslint` clean on both files.
- Tailwind only, lucide-react only, no new dependency.
- Every write busy-gated and disabled in flight.
- Do not touch `LawnMeasurementMap.tsx`, `LawnEstimateWorkspace.tsx`,
  `src/lib/estimateAreas.ts`, or `src/lib/plantProducts.ts`. **If you think the
  contract is wrong, say so in your report — do not edit it.** That is what
  caused this rework.
- Still no nav link, still no seeded default plants.

## Report back

State plainly whether the page ran against the live database, and paste the
real E2E counts. If something in this spec turned out to be wrong, say which
part — the last spec's premise was wrong once already and it cost a rebuild.
