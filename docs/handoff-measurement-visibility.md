# HANDOFF — Make the measurement visible (crew model, phases 1-2 payoff)

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` @ `92c12b2` or later. Work on `feat/measurement-visibility`.**

---

## Lane boundaries

Three agents in parallel. **Stay inside your lane.**

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Cluster geofence (phase 3) | Claude | `src/lib/geofence.ts`, `src/lib/useCrewLocationBroadcast.ts`, `src/lib/crewTracking.ts`, migrations |
| Pure clustering maths | local model | `src/lib/stopClusters.ts` |
| **Measurement visibility — YOURS** | **you** | `src/app/lawn/visits/[id]/page.tsx`, `src/app/lawn/insights/page.tsx` |

**Work in the main checkout** (`C:\Users\garci_9e2kg3l\Projects\lowvoltage-app`).
Claude is in a separate worktree, so branch as you like — but do not switch that
checkout to someone else's branch. **Do not create migrations. Do not push.**

---

## Why this exists

Two phases just shipped and **neither is visible anywhere in the product.**

- The geofence now writes `on_site_first_at` / `on_site_last_at` on every visit,
  independent of status.
- `time_entries.crew_size` records how many people were on the truck.
- `src/lib/manHours.ts` converts those into priced man-hours — and currently has
  **zero importers**. It is dead code until you use it.

Labour is priced in man-hours, not clock time: a 4-person crew on site for 20
minutes produced 1.33 man-hours, not 0.33. Showing duration without crew size
under-states the cost of every job by the size of the crew.

## 1. Visit detail — `src/app/lawn/visits/[id]/page.tsx`

That page currently derives on-site time as `completed_at - started_at`
(see the comment at line ~59). That is the STATUS-coupled figure and it is now
the wrong one.

- **Prefer the measured window**: `on_site_last_at - on_site_first_at`. It is
  written automatically by any crew phone and does not depend on anyone
  remembering to tap Done.
- Keep `completed_at - started_at` as a labelled fallback when the measured
  window is null, so old visits still show something.
- Label them differently. "Measured on site" and "Start to done" are different
  claims and must not silently swap.
- Show `on_site_user_ids.length` as "N phones on site" when > 1. It is the
  evidence the measurement is real.
- Show `measurement_flag` when set (`too_long` / `too_short` / `no_departure`)
  as a neutral "not used for pricing" note. **Never phrase it as the crew doing
  something wrong** — a flag most often means we lack a lot size, not that
  anyone slacked.

### The crew_size join — read this carefully

`crew_size` lives on `time_entries`, **not** on the visit. To get man-hours you
must find the shift that covers the visit: same `organization_id`, and the
visit's `on_site_first_at` between `clock_in_at` and `coalesce(clock_out_at, now())`.

**If no shift matches, or the matched shift has `crew_size` null: show the
duration and DO NOT show man-hours.** Do not assume 1. A missing multiplier must
look missing — a wrong one silently under-prices the job and nobody ever
notices. This is the single most important rule in this handoff.

## 2. Measured labour on `src/app/lawn/insights/page.tsx`

Add a section using `buildBaseline` from `@/lib/manHours`:

```ts
import { buildBaseline, lotSizeBand, fmtHoursIfYouNeedIt } from "@/lib/manHours";
```

(check the actual exports — `buildBaseline`, `classifyMeasurement`, `manHours`,
`manMinutesPer1000Sqft`, `median`, `lotSizeBand`, `BASELINE_DEFAULTS`).

- Median **man-minutes per 1,000 sqft**, segmented by `lotSizeBand`.
- Always show `n=` next to every figure. An average over 3 visits is noise.
- **Below 30 clean measurements, show the number as provisional** and say so.
  The design is explicit that 30+ is where an average starts to mean anything.
- Show the excluded count and why (the `excluded` array carries a flag, which is
  `null` for "we never measured this lot" — that is not an outlier, present it
  as missing data).

## THE EMPTY STATE IS THE MAIN CASE

There are currently **zero** measurements in the entire database —
`on_site_first_at` is null on every row, because the geofence that writes it
shipped hours ago and no crew has driven a route yet.

So you will build this against nothing, and **the empty state is what the user
will actually see first.** Do not treat it as an afterthought. It should explain
what will populate it and what is blocking — "no measured visits yet; crews
record this automatically once they clock in and work a route with map pins."

Seed rows in **Terra Verde Test Co** (`600d02fa-fae2-440b-99ab-42e96997da91`)
to exercise the populated state, and **delete them afterwards**.

## NEVER WRITE TO PEANUTZ

`Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) is a **real paying
customer**. Read-only. All seeding goes in Terra Verde Test Co.

## Constraints

- `npx tsc --noEmit` exits 0; `npx eslint <changed files>` clean.
- `react-hooks/set-state-in-effect` is enforced — derive, never setState in an
  effect body.
- No polling loops, no `useEffect` fetch loops.
- Lawn only — gate on `isLawn()`. **The construction variant must be
  byte-identical.** I verify this by executing `buildNavItems`/`buildMobileNav`
  for all 8 roles in both variants and diffing, so claiming it is not enough.
- RLS scopes the queries. No manual `.eq("organization_id", ...)`.
- Stage explicitly, never `git add -A`. `src/lib/turnstile.ts` is another lane's
  uncommitted work — leave it.

## Report

Say what you verified, not that you finished. In particular: what the page shows
when `crew_size` is null, and what it shows with zero measurements.
