# HANDOFF — state of play, 2026-09-06 (evening)

**Read this before the lane docs.** All four lane specs, and the earlier version
of this file, describe a world that no longer exists: they were written when the
backend was five catalogues ahead of the UI. **That gap is closed.** Every claim
below was checked against `origin/main` at `d443dc7`, not remembered.

Where a lane doc and this file disagree, this file wins.

---

## 1. The lanes are done

The previous version of this document led with *"nothing anywhere writes
`estimate_labor_items` or `estimate_components`"* and called that the single
most important line in it. It is no longer true. Everything below ships:

| Contract | Seeded in the test org | Reachable from |
|---|---|---|
| `plantProducts.ts` | 223 species / 690 sizes | `/lawn/plants`, estimator |
| `irrigationProducts.ts` | 20 models / 145 nozzles | `/lawn/irrigation`, the map |
| `irrigationSystem.ts` | 73 components | `/lawn/irrigation-components`, `ComponentsPanel` |
| `laborItems.ts` | 40 labor lines | `/lawn/labor-items`, `LaborItemsPanel` |
| `sodProducts.ts` | 11 products | `/lawn/sod`, `SodPanel` |
| `equipmentProducts.ts` | 18 machines | `/lawn/equipment`, `EquipmentPanel` |
| `crewFeedback.ts` | — | `/lawn/labor-feedback` |
| `siteImport.ts` | — | `/lawn/estimate/[id]/import` |

Six estimator panels exist under `src/components/estimator/`: `SodPanel`,
`PipePanel`, `DripPanel`, `EquipmentPanel`, `LaborItemsPanel`, `ComponentsPanel`.
`LawnEstimateWorkspace.tsx` writes `estimate_labor_items` and
`estimate_components` with full snapshots.

**Do not start a lane from its spec.** Read the files first — three of the four
lane docs will send you to build something that is already there.

`src/components/ui/DataTable.tsx` is the house desktop-table pattern. Any NEW
screen with a desktop table uses it rather than hand-rolling `hidden lg:block`
markup. Copy `ChemicalProductsManager.tsx` or `IrrigationProductsManager.tsx`.

---

## 2. Rules. None of these have been relaxed

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

### 2.2 A seeded MEASUREMENT is a starting point, and must say so

Nozzle throw distances are seeded, because a radius is a physical fact rather
than an opinion — but it is a fact about a chart, not about the box in the van.
Product lines get revised, adjustable nozzles are recorded at the top of their
range, and every figure is quoted at a pressure the site may not run.

`THROW_VERIFY_NOTE` says exactly that, on the catalogue screen where the numbers
are edited. Any screen shipping a measured default carries the same warning
where it is edited, not in a doc nobody opens.

Orgs can send a figure back: `nozzle_suggestions`, opt-in, separate from saving
to their own catalogue, `source_note` required. **A number with no provenance
cannot be folded into a catalogue other companies quote from.**

### 2.3 A blank is not a zero, and there are TWO kinds of blank

`unpriced` — no price recorded. Not the same as free.
`untimed` — no man-minutes recorded. Not the same as instant.

They are separate flags on `LaborCharge` and a row can be either. Surface them
separately; "0" in a rate column is a lie either way.

The same rule reaches further than the catalogues. `headRateLines()` keeps an
untimed head as a line rather than dropping it, because a head with no rate is
exactly the row the feedback screen exists to learn.

### 2.4 Units are the whole game

Nine units across two contracts: `each foot sqft msqft cubic_yard ton hour job`
plus components' `each|foot`. Rules that are not guessable:

- **Label every quantity field with its unit.** `basis` on every charge already
  states it; put it on the input too.
- **`msqft` is per THOUSAND square feet.** Never ask anyone to type thousands —
  feed measured area through `toMsqft(sqft)`. Typing 5000 into an MSF field is a
  thousand-fold error that looks perfectly correct.
- **An `hour` row's quantity IS the man-hours.** `install_minutes` is ignored on
  it, deliberately.
- `install_minutes` is NUMERIC on `labor_items` and `irrigation_components` —
  0.5 man-min/ft of wire is real, and the integer column that used to hold it
  silently rounded. Do not put `step="1"` on those inputs. It is still INTEGER on
  `irrigation_product_nozzles` and `plant_product_sizes`; anything applying a
  rate there rounds to the minute and should say so rather than implying
  resolution the column cannot hold.

### 2.5 Line items carry PER-UNIT money

`componentLineItem` and `laborLineItem` return `unit_price` and `internal_cost`
**per unit**, not extended. The quote consumer multiplies by quantity. Handing
it `charge.cost` would bill 200 ft of wire two hundred times over. Show the
extended figures in the panel; let the line item do its own thing.

---

## 3. The feedback loop, and the trap inside it

`/lawn/labor-feedback` reads crew time back against what jobs were quoted at and
proposes catalogue rates. `crewFeedback.ts` (pure math) + `crewFeedbackData.ts`
(I/O). **98 assertions green**, verified 2026-09-06.

It now covers every catalogue that carries an install rate: **labor items,
components, plants, sod and heads.**

Three things any UI touching it must not undo:

- **Man-hours are duration TIMES heads.** An entry with no crew size is excluded
  and counted, never defaulted to a crew of one. 1 of 3 closed entries in the
  test org carries a crew size, so this is the live case, not a hypothetical.
- **Nothing applies itself.** Every proposal shows its sample size and spread;
  Apply writes one row. There is deliberately no bulk endpoint.
- **A missing task line is not an absence, it is a wrong number.** This is the
  trap, and it cost a real defect. `observationsFor` splits a job's hours across
  the lines it HAS, so a task the loader forgot to build donates its hours to
  whatever else was on the estimate — and the result is labelled `direct`, the
  kind the screen trusts most, because a single-task job needs no assumption.
  Heads were missing for exactly this reason: an irrigation job with one
  trenching line credited that line with the whole day, at twice its real rate,
  and offered it for one-click apply. **Anything new that can appear on an
  estimate and take time must appear in `loadFeedbackData`, or it will corrupt
  its neighbours rather than simply be absent.**

Related: `mergeTaskLines()` collapses lines sharing a rate key before any
attribution. `sampleSize` counts observations and the message reads "N of 3
jobs", so an unmerged duplicate let ONE job clear a gate built to refuse a
single week of evidence.

---

## 4. What each lane actually left behind

### Lane A — catalogue screens
Shipped, including the two the spec never mentioned (`/lawn/labor-items`,
`/lawn/sod`). `PlantCatalogueManager` gained search and a category filter, so the
"223 species in one scroll" item is closed. It is still the one catalogue **not**
migrated to `DataTable`.

`LABOR_SCOPE_NOTE` renders on the labor-items screen. It stops someone adding a
"sod install" row that double-bills hours the sod catalogue already prices.

### Lane B — heads on the map
Shipped. `LawnMeasurementMap.tsx` places heads and draws coverage arcs. The
geometry is checked against known ground distances rather than against itself —
25 ft north and 25 ft east must both be 25 ft on the ground while spanning
different numbers of degrees. **193 assertions green**, verified 2026-09-06.

### Lane C — estimator panels
Shipped. Six panels; both estimate tables written with snapshots.

### Lane D — components UI
Shipped. Categories `lateral`, `drip` and `trenching` were added after the spec
was written (so `pipeEstimate` footage and dripline have somewhere to be priced;
trenching is per linear foot, labor-only, and is the one component group
carrying install minutes).

### Not a lane, shipped anyway
The **site importer** (`/lawn/estimate/[id]/import`, linked from the estimator)
takes Moasure / GNSS / surveyor CSV alongside the map, with two-point anchoring
for local coordinate frames. `handoff-site-import.md` is now a record, not a
task.

---

## 5. What is actually open

- **27 nozzles on throwing models still have no radius.** 35 rows are blank, but
  8 of those are strip and corner patterns, where a single radius is the wrong
  model — those are correct as they stand. Orgs can now contribute the rest
  through `nozzle_suggestions`.
- **`PlantCatalogueManager.tsx` is not on `DataTable`.** The last hand-rolled
  `hidden lg:block` table in the lawn app.
- **DeepSource: JavaScript is failing on `main`** and has been for a while. Most
  of what it reports on these files is a browser-script rule applied to ES
  modules. Do not read a red JS check on your PR as proof you broke something —
  compare against `main` first, and read the inline comments for what is
  genuinely yours. Seven `deepsource-autofix` PRs (#2–#8) are open and untriaged.
- **PR #14** migrates the construction and shared desktop tables onto
  `DataTable`. Construction is deferred by the owner; it will conflict with lawn
  work in the shared layout when it lands.
- **The two E2E account passwords need rotating.** Sessions were revoked, but the
  old password still authenticates. Owner action — not an agent's.

---

## 6. Rules that have not changed

- **Own your files.** If you edit a file another lane owns, that is a rebase, not
  a merge. This bit us once already.
- **Take your own worktree, or claim the shared checkout first.** The shared
  checkout is frequently mid-merge on someone else's branch — check `git status`
  before assuming a `pull` will work. `agent-bus` is on `main` (`.mcp.json`,
  `tools/agent-bus/`) and gives you a lock, a noticeboard and messaging.
- Import from the contracts. Re-derive nothing. If a contract looks wrong, say so
  in your report — do not edit it.
- `kind` is GEOMETRY, `meta` is WHAT THE THING IS. Anything reading
  `estimate_areas` points discriminates on meta. Plants, sod and heads all live
  there.
- **Snapshot anything already sent.** Re-pricing must never move a quote that is
  already in a customer's hands.
- Empty renders empty. Every write busy-gated. Tailwind + lucide-react only.
- `npx tsc --noEmit` exit 0, `npx eslint` clean, and a real `next build` before
  you report. Compile pure contracts standalone too — a harness that was never
  run is not a passing harness, and one here sat unrunnable for days while being
  cited as green.
- Commit a harness, and **test the failure you fear, not the happy path.** Copy
  the isolation discipline from `e2e-plant-placement.mjs`: deactivate the org's
  real catalogue, scope every delete and REST read to `E2E%`, restore on the
  failure path. An earlier version of these harnesses wiped a whole org silently.

The full list, with the incident behind each rule, is in
[`../build-rules.md`](../build-rules.md).

## 7. Test org

Terra Verde Test Co, `600d02fa-fae2-440b-99ab-42e96997da91`. Everything above is
seeded there and it is safe to write to.

**Never read or write `d236eba1-8e84-4dae-a40d-ef2651cbbb9c`.** That is a live
customer.
