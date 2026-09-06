# HANDOFF — labor settings: org defaults + per-estimate panel

Landscape install labor is fully plumbed in the database and the contract, and
has **no UI at all**. This handoff builds both surfaces.

Read `src/lib/plantProducts.ts` from the `// Install labor` divider down before
starting. Everything here is already written and tested — you are wiring it up,
not designing it.

## The model in four sentences

A landscape install is priced in **man-hours**, not by property size the way
mowing is. Each plant size carries `install_minutes` (man-minutes to plant one)
in the catalogue, so that part is entered once and reused forever.
**Mobilization** is the fixed man-hours a job costs before anyone plants
anything — drive both ways, unload, setup, cleanup, haul-off. Total billed
labor is `mobilization + Σ(count × install_minutes)`, priced at the estimate's
`labor_rate`.

Why mobilization exists: without it a one-shrub job quoted 8 minutes ($8.45).
With it, $105.95. At 200 shrubs it is 5% of labor; at one shrub it is 92%.

## PERMISSIONS — read this before choosing where anything goes

`organizations` UPDATE is **admin-only**, enforced twice: the RLS policy
`Org admin update org` requires `profiles.role = 'admin'`, and
`src/app/api/org/route.ts` returns 403 for everyone else including super_admin.

But the plant catalogue and estimates are **office/PM** (`tier_office_or_pm`).

**This is deliberate, not a bug to route around.** A company labor rate is an
owner-level pricing decision; an office manager building a quote can still
override it per job, they just cannot change the company default. Consequences
you must honour:

- Org defaults live on an **admin-only** screen.
- The per-estimate panel is **office/PM** and must work fully without any
  default set.
- "Save as my default" is shown **only when `role === "admin"`**. Do not show a
  disabled button to office/PM — show nothing.
- **Do not** loosen the `organizations` RLS policy. It protects tenant identity.

## PART 1 — org defaults on `/admin/org`

### 1a. Extend `src/app/api/org/route.ts`

Accept three new optional numeric fields. The existing admin gate already
covers them — do not add a second one.

**Concrete gotcha:** `update` is currently typed
`Record<string, string | null>`. It must widen to
`Record<string, string | number | null>` or the numerics will not compile.

Validation, per field:
- absent from the body → do not touch the column
- empty string or `null` → write `null` (means "not set")
- a finite number `>= 0` → write it
- anything else (negative, `NaN`, non-numeric string) → **400 with a message**,
  do not silently coerce

A negative labor rate must not reach the database. `0` is legal and meaningful
for mobilization (a crew already on site).

### 1b. Extend `src/app/admin/org/page.tsx`

Add the three columns to the select:
`default_labor_rate, default_labor_cost_rate, default_mobilization_hours`.

### 1c. Extend `src/app/admin/org/OrgSettingsForm.tsx`

A new section below the existing business-info fields, headed
**"Landscape labor defaults"** with one line of explanation: these prefill new
estimates and can be changed per job.

| Field | Label | Help |
|---|---|---|
| `default_labor_rate` | Billed rate | per **man-hour**, what the customer pays |
| `default_labor_cost_rate` | Your cost | per man-hour, burdened — internal only, never shown to a customer |
| `default_mobilization_hours` | Mobilization | **man-hours** per job: drive both ways, unload, setup, cleanup, haul-off |

Three rules, all of which are about not lying to the user:

1. **Empty renders empty, not `0`.** These are nullable and null means "not
   set". A form that shows `0` for an unset rate teaches people their rate is
   zero.
2. **Say man-hours everywhere.** Two people driving 30 minutes each way is
   **2** man-hours, not 1. This is the single easiest number to enter wrong.
3. Gate the whole section on `canEdit` exactly like the existing fields.

**Lawn-variant only.** Wrap the section in a lawn check — a construction org
has no use for it. `OrgSettingsForm` does not currently receive the variant, so
pass it down from the page (`tenant.appVariant`), do not look it up in the
client.

## PART 2 — the per-estimate panel

Lives in the estimator alongside the plant legend. Office/PM. Writes
`estimates.labor_rate`, `labor_cost_rate`, `mobilization_hours` directly
through RLS (estimates are already office/PM-writable — no API route).

### Prefill: creation only

When an estimate is **created**, seed it with
`laborSettingsFromDefaults(org)` and write the result onto the estimate's own
columns.

**Never call it when loading an existing estimate.** That would overwrite a
deliberate per-job override with the org default. The estimate keeps its own
copy so that raising your rate next spring cannot reprice a quote that already
went out — the same snapshot rule the plant catalogue follows.

### What the panel shows

Use `estimateMargin(rows, labor_rate, labor_cost_rate, mobilization_hours)`.
It returns the whole breakdown; do not recompute any of it.

```
Material        $2,560      (cost $790)
Labor           8.67 hrs planting + 1.50 mobilization
                = 10.17 man-hours @ $65      $661.05
                                            ---------
Total                                       $3,221.05
Margin (material + labor)                       63.5%
```

Those figures are real — 4 Live Oak 30 gal + 20 Dwarf Holly 3 gal at $65/$38
and 1.5 mobilization hours, run against the contract. If your panel shows
something else for that input, the wiring is wrong, not the numbers.

Three editable inputs — billed rate, your cost, mobilization — and the numbers
move as they type.

### Four warnings you must implement

These are the whole point of the panel. Each one is a way to quote at a loss:

1. **`mobilizationUnset(mobilization_hours)`** → "Mobilization not
   estimated — small jobs will quote low." Null means nobody estimated it; `0`
   means genuinely none. **Never coalesce null to 0.**
2. **`installTimeUnset(rows)`** → "No plant has an install time set — labor is
   quoting at zero." Points at the catalogue.
3. **No `labor_rate`** → show labor as unpriced and label the margin
   **material margin only**. `estimateMargin` returns `laborPriced: false` for
   exactly this.
4. **`mobilizationShare(rows, mobilization_hours) > 0.5`** → "Mostly drive time
   and setup — consider a minimum charge." The drove-across-town-for-one-shrub
   job.

### The labor line item

`laborLineItem(manHours, billRate, costRate)` returns the line, or **`null`**
when there is nothing billable. Respect the null — do not put a `$0` labor line
on a customer's quote.

Labor is its **own line item**, separate from the plants (plants quote at their
installed price). Pass it to the existing `onAddLineItem`, which now accepts
`internal_cost`.

### "Save as my default" — admin only

Show it only when `laborDiffersFromDefaults(settings, org)` **and** the user is
an admin. It PATCHes `/api/org`.

Defaults are **never** auto-updated from the last estimate. One three-day
out-of-town install with 9 mobilization hours would silently become the
starting point for the next mow-and-go quote. Saving a default is a deliberate
act, always.

## Rules

- Import from `src/lib/plantProducts.ts`. Do not re-derive any math — every
  number above already has a function. **If the contract looks wrong, say so in
  your report; do not edit it.**
- Tailwind + lucide-react only, no new dependency, matching surrounding style.
- Every write busy-gated and disabled in flight.
- Money via the existing `formatMoney`; hours as plain numbers with the unit
  spelled out.
- `npx tsc --noEmit` exit 0, `npx eslint` clean.

## Verify

Commit an `e2e-labor-settings.mjs` at the **repo root** (convention:
`e2e-chemicals-test.mjs`, `e2e-settlement.mjs`, …; there is no `Tools/` dir).
Read one first and follow its shape.

1. admin saves defaults → persist, REST-verified
2. office/PM sees **no** save-as-default button, and the panel still works
3. a new estimate prefills from the defaults
4. changing the org default afterwards does **not** change that estimate
5. all four warnings fire on their own condition and not otherwise
6. no rate → `laborLineItem` returns null and no `$0` line is added
7. **the regression that started this:** one 3 gal shrub with 1.5 mobilization
   bills 1.63 man-hours, not 0.13

Report whether it ran against the live database, and paste the real counts.
