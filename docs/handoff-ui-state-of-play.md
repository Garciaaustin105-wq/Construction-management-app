# HANDOFF — state of play, 2026-09-06

**Read this before the lane docs.** Four of them were written days ago and three
are now partly stale. This says what is actually true today, what changed under
them, and which rules are new and non-negotiable.

---

## 1. The headline: the backend is five catalogues ahead of the UI

Everything below is built, tested, seeded and **unreachable from the app**.

| Contract | Rows seeded | Screens importing it |
|---|---|---|
| `plantProducts.ts` | 223 species / 690 sizes | 5 |
| `crewFeedback.ts` | — | 2 |
| `irrigationProducts.ts` | 20 models / 145 nozzles | **0** |
| `irrigationSystem.ts` | 73 components | **0** |
| `laborItems.ts` | 38 labor lines | **0** |
| `sodProducts.ts` | 11 products | **0** |
| `equipmentProducts.ts` | 15 machines | **0** |

Screens that exist: `/lawn/plants`, `/lawn/products`, `/lawn/labor-feedback`.
Screens that do NOT exist: `/lawn/sod`, `/lawn/equipment`, `/lawn/irrigation`,
`/lawn/labor-items`, `/lawn/irrigation-components`.

**And nothing anywhere writes `estimate_labor_items` or `estimate_components`.**
That is the single most important line in this document. It means a labor item
or an irrigation component cannot reach an estimate at all, which in turn means
the feedback screen can never learn a rate for one. The chain is built end to
end and has a gap in the middle.

**Priority order, and it is not the lane letters.** Highest value first:

1. A way to ADD a labor item or component to an estimate (Lane C). Without it,
   two whole catalogues and the feedback loop are inert.
2. The catalogue screens for the five with none (Lane A + Lane D).
3. Heads on the map (Lane B) — big, self-contained, unblocked.

---

## 2. New rules, since the lane docs were written

### 2.1 Values belong to the org. Research is a suggestion.

Seed names, categories and units. **Never seed a price or a labor rate.** The
published research is exposed as suggestions shown BESIDE a field —
`LABOR_BENCHMARKS`, `SOD_INSTALL_BENCHMARK`, `BILL_RATE_BENCHMARK` in
`laborItems.ts` — and is never a default, never pre-filled, never in a
calculation.

A unit IS seeded, because a unit is not an opinion: mulch is bought by the cubic
yard whoever you are. It is also the thing nobody catches later — a wrong rate
looks wrong, a wrong unit looks fine and is off by 9x or 1000x.

Render `describeBenchmark(b)` verbatim next to the rate field. It already frames
market prices as *what others charge* rather than as a recommendation, and it
already ends by deferring to the org's own crew times. Do not rewrite that copy.

Two standing exceptions, both decided by the owner: plant install minutes stay
seeded (validated against independent sources), and `sqft_per_pallet` stays at
450 (zero there produces no estimate at all, not a cautious one).

### 2.2 A blank is not a zero, and there are now TWO kinds of blank

`unpriced` — no price recorded. Not the same as free.
`untimed` — no man-minutes recorded. Not the same as instant.

They are separate flags on `LaborCharge` and a row can be either. Surface them
separately; "0" in a rate column is a lie either way.

### 2.3 Units are the whole game

Nine units across two contracts: `each foot sqft msqft cubic_yard ton hour job`
plus components' `each|foot`. Rules that are not guessable:

- **Label every quantity field with its unit.** `basis` on every charge already
  states it; put it on the input too.
- **`msqft` is per THOUSAND square feet.** Never ask anyone to type thousands —
  feed measured area through `toMsqft(sqft)`. Typing 5000 into an MSF field is a
  thousand-fold error that looks perfectly correct.
- **An `hour` row's quantity IS the man-hours.** `install_minutes` is ignored on
  it, deliberately.
- `install_minutes` is NUMERIC, not integer. Per-foot and per-area rates are
  fractional — 0.5 man-min/ft of wire is real, and the integer column that used
  to hold it silently rounded. Do not put `step="1"` on that input.

### 2.4 Line items carry PER-UNIT money

`componentLineItem` and `laborLineItem` return `unit_price` and `internal_cost`
**per unit**, not extended. The quote consumer multiplies by quantity. Handing
it `charge.cost` would bill 200 ft of wire two hundred times over. Show the
extended figures in the panel; let the line item do its own thing.

---

## 3. What changed under each lane

### Lane A — `docs/handoff-ui-lane-a-catalogues.md`
Still accurate for plants, sod and equipment. **Now also owns two catalogues it
does not mention:** `/lawn/labor-items` (38 rows, `laborItems.ts`) and, if Lane D
does not take it, `/lawn/irrigation-components` (73 rows). Both are flat
name/category/unit/cost/price/minutes tables — the same screen shape as
`PlantCatalogueManager`, minus the species/size split.

`PlantCatalogueManager` still has no search or filter and now shows **223
species in one scroll**. That is the oldest open item in this project.

Render `LABOR_SCOPE_NOTE` on the labor-items screen. It stops someone adding a
"sod install" row that double-bills hours the sod catalogue already prices.

### Lane B — `docs/handoff-ui-lane-b-heads-on-map.md`
**Unchanged and fully accurate.** Nothing has touched
`LawnMeasurementMap.tsx`. Contract is stable, 76 assertions green. This lane can
start today with no rebase.

### Lane C — `docs/handoff-ui-lane-c-estimator-panels.md`
**Now the highest-value lane**, and it gained scope: the panel must be able to
add a **labor item** and an **irrigation component** to an estimate, writing
`estimate_labor_items` and `estimate_components` with a full snapshot. Those two
tables exist, have RLS, and have never been written to.

Snapshot rule as everywhere: store a copy, so re-pricing the catalogue never
moves a quote already sent.

### Lane D — `docs/handoff-ui-lane-d-controls-and-mainline.md`
**Already updated.** Contract and migration are merged; Lane D is UI only. Two
categories were added after that doc: `lateral`, `drip` (so `pipeEstimate`
footage and dripline have somewhere to be priced) and `trenching` (per linear
foot, labor-only, the one component group carrying install minutes).

---

## 4. New since the lane docs: the feedback loop

`/lawn/labor-feedback` reads crew time back against what jobs were quoted at and
proposes catalogue rates. `crewFeedback.ts` (pure math) + `crewFeedbackData.ts`
(I/O), 84 assertions green.

Two things any UI touching it must not undo:

- **Man-hours are duration TIMES heads.** An entry with no crew size is excluded
  and counted, never defaulted to a crew of one. Only 1 of 7 closed entries
  carries a crew size today, so this is the live case.
- **Nothing applies itself.** Every proposal shows its sample size and spread;
  Apply writes one row. There is deliberately no bulk endpoint.

It is also why Lane C matters most: until something writes
`estimate_labor_items`, this screen can never learn a labor rate.

---

## 5. Rules that have not changed

- **Own your files.** Lane A is in the catalogue screens, B in
  `LawnMeasurementMap.tsx`, C in `LawnEstimateWorkspace.tsx`, D in the component
  UI. If you edit a file another lane owns, that is a rebase, not a merge. This
  bit us once already.
- **A separate desktop-UI pass is live** and owns `navItems.ts` and the shared
  layout. Add a nav entry if your screen needs one, but expect to rebase, and do
  not restructure that file.
- Import from the contracts. Re-derive nothing. If a contract looks wrong, say
  so in your report — do not edit it.
- `kind` is GEOMETRY, `meta` is WHAT THE THING IS. Anything reading
  `estimate_areas` points discriminates on meta.
- Empty renders empty. Every write busy-gated. Tailwind + lucide-react only.
- `npx tsc --noEmit` exit 0 and `npx eslint` clean before you report.
- Commit a harness. Copy the isolation discipline from
  `e2e-plant-placement.mjs`: deactivate the org's real catalogue, scope every
  delete and REST read to `E2E%`, restore on the failure path. An earlier
  version of these harnesses wiped a whole org silently.

## 6. Test org

Terra Verde Test Co, `600d02fa-fae2-440b-99ab-42e96997da91`. Everything above is
seeded there and it is safe to write to.

**Never read or write `d236eba1-8e84-4dae-a40d-ef2651cbbb9c`.** That is a live
customer.
