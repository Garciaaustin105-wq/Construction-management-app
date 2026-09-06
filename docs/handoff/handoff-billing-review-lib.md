# HANDOFF — `billingReview.ts`, a pure module. No I/O, no React, no SQL.

**For: the local model (ollama). Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main`. Work on `feat/billing-review-lib`. Do not push.**

---

## Why this exists

The app measures how long a lawn visit actually took (geofence, on-site
timestamps, crew size) and it separately bills a **flat** `price_per_visit`
typed into the recurring schedule. Nothing compares the two. So a yard that
takes 95 minutes with a 4-person crew bills the same as one that takes 20
minutes solo, and nobody ever sees it.

Your job is the **arithmetic only**: given visits that are settled but not yet
invoiced, produce the rows an office manager would review before billing runs.

**You write one file and one test file. Nothing else.**

| Write | Do NOT touch |
|---|---|
| `src/lib/billingReview.ts` | anything under `src/app/**` |
| `src/lib/billingReview.check.ts` | anything under `src/lib/accounting/**` |
| | `src/lib/lawnBilling.ts` — that's Claude's |
| | any `.sql`, any migration |

No Supabase import. No `fetch`. No `next/*` import. No React. If you find
yourself importing any of those, you have misread the task.

---

## The exact API

```ts
export type ReviewInput = {
  visitId: string;
  jobName: string;
  customerName: string | null;
  dueDate: string;                  // "YYYY-MM-DD"
  onSiteFirstAt: string | null;     // ISO, from the geofence
  onSiteLastAt: string | null;      // ISO
  startedAt: string | null;         // ISO, crew tapped start
  completedAt: string | null;       // ISO, crew tapped done
  crewSize: number | null;          // >= 1, or null if unknown
  pricePerVisit: number | null;     // USD major units, flat, from the schedule
};

export type ReviewRow = {
  visitId: string;
  jobName: string;
  customerName: string | null;
  dueDate: string;
  minutes: number | null;           // whole minutes, rounded
  minutesSource: "measured" | "tapped" | null;
  manHours: number | null;          // rounded to 2 decimals
  price: number | null;             // pass-through of pricePerVisit
  impliedHourly: number | null;     // price / manHours, 2 decimals
  verdict: Verdict;
};

export type Verdict =
  | "ok"          // within tolerance of the median implied hourly
  | "under"       // impliedHourly is far BELOW median — we are losing money here
  | "over"        // impliedHourly is far ABOVE median — check for a bad measurement
  | "unpriced"    // no pricePerVisit
  | "unmeasured"; // no usable duration

export type ReviewSummary = {
  rows: ReviewRow[];
  medianHourly: number | null;      // median of impliedHourly over "ok"-eligible rows
  totalPrice: number;               // sum of non-null price
  totalManHours: number;            // sum of non-null manHours, 2 decimals
  counts: Record<Verdict, number>;
};

export function buildReview(
  inputs: ReviewInput[],
  opts?: { tolerance?: number }     // default 0.35
): ReviewSummary;
```

## The rules, precisely

**Duration.** Prefer measured over tapped — measured comes from the geofence
with nobody pressing anything.

- If `onSiteFirstAt` and `onSiteLastAt` are both present and last > first:
  `minutes = round((last - first) / 60000)`, `minutesSource = "measured"`.
- Else if `startedAt` and `completedAt` are both present and completed > started:
  same arithmetic, `minutesSource = "tapped"`.
- Else `minutes = null`, `minutesSource = null`.
- A non-positive interval (last <= first) is **not** usable — fall through to
  the next option, do not emit a negative or zero duration.

**Man-hours.** `manHours = (minutes / 60) * crewSize`, rounded to 2 decimals.
If `minutes` is null **or** `crewSize` is null, `manHours` is null. Treat
`crewSize < 1` as invalid → null. This mirrors `src/lib/manHours.ts`; do not
import it, just match the formula.

**Implied hourly.** `price / manHours`, 2 decimals. Null if either side is null,
or if `manHours` is 0.

**Verdict**, evaluated in this order — first match wins:
1. `price` is null or 0 → `"unpriced"`.
2. `manHours` is null → `"unmeasured"`.
3. `impliedHourly` is null → `"unmeasured"`. Reachable when `manHours` is `0` —
   a visit so short it rounds to zero minutes. **This must be checked BEFORE
   rule 4**: a row with no computable rate is unmeasurable however much data
   exists, and `"ok"` is the one verdict that asserts we checked and it is fine.
4. `medianHourly` is null (fewer than 3 rows have an `impliedHourly`) → `"ok"`.
   With too little data, do not accuse anything of being wrong.
5. `impliedHourly < medianHourly * (1 - tolerance)` → `"under"`.
6. `impliedHourly > medianHourly * (1 + tolerance)` → `"over"`.
7. otherwise → `"ok"`.

**Median, not mean.** One 4-hour outlier must not drag the baseline. Sort the
non-null `impliedHourly` values ascending; odd length → middle element; even
length → mean of the two middle elements, rounded to 2 decimals. Compute the
median from rows that have an `impliedHourly` at all — that is, excluding
`unpriced` and `unmeasured` rows.

**Ordering.** Return `rows` sorted so the problems come first: `under`, then
`over`, then `unmeasured`, then `unpriced`, then `ok`. Within a group, most
recent `dueDate` first. Stable — equal keys keep input order.

**Rounding helper.** Write one `round2(n)` and use it everywhere so results are
consistent. `Math.round(n * 100) / 100`.

**Empty input** → `{ rows: [], medianHourly: null, totalPrice: 0,
totalManHours: 0, counts: { ok:0, under:0, over:0, unpriced:0, unmeasured:0 } }`.

## Checks — `src/lib/billingReview.check.ts`

**This repo has no test runner — no vitest, no jest. Do not add one, and do not
`npm install` anything.** Node's built-in `node:assert` is all you get, and it
is enough.

Write `src/lib/billingReview.check.ts` as a plain module that imports from
`./billingReview`, runs the cases below with `assert.deepStrictEqual` /
`assert.strictEqual`, prints one line per case, and exits non-zero on the first
failure. Structure it as a small `cases` array with a name and a body so the
output reads as a list.

It is compiled and run like this — the same throwaway pattern used for the
earlier libs. **`.br-build/` is already gitignored (`.gitignore:50`), so use
exactly that directory** — do not invent another and do not edit `.gitignore`:

```
npx tsc src/lib/billingReview.ts src/lib/billingReview.check.ts \
  --outDir .br-build --module nodenext --target es2022 --strict
node .br-build/billingReview.check.js
```

**Compute every expected number by hand and write the literal.** Do not compute
an expectation by calling the function you are testing, and do not guess a
rate — work it out.

Cover at minimum:

1. Empty input returns the documented zero summary.
2. Measured wins over tapped when both are present.
3. Falls back to tapped when the measured window is missing.
4. Falls back to tapped when `onSiteLastAt <= onSiteFirstAt`.
5. `crewSize: null` → `manHours` null → verdict `"unmeasured"`.
6. `crewSize: 0` treated as invalid → `"unmeasured"`.
7. `pricePerVisit: null` → `"unpriced"`, and that row is excluded from the median.
8. Fewer than 3 priced+measured rows → everything is `"ok"`, `medianHourly` null.
9. A clear `"under"` and a clear `"over"` against a median built from >= 3 rows.
10. Median with an even count averages the two middle values.
11. A single extreme outlier does not move the median (this is the point of
    using median — assert it explicitly).
12. Sort order puts `under` before `ok`.
13. `totalPrice` / `totalManHours` ignore nulls rather than treating them as 0
    in a way that corrupts the count.

Worked example you can use for #9 — check my arithmetic, don't trust it:
90 min at crew 2 = 3.00 man-hours; price 120 → implied 40.00/hr.
60 min at crew 1 = 1.00 man-hours; price 40 → implied 40.00/hr.
120 min at crew 3 = 6.00 man-hours; price 60 → implied 10.00/hr.
Median of [10, 40, 40] = 40. tolerance 0.35 → band is 26.00 to 54.00.
So the 10.00/hr row is `"under"`; the other two are `"ok"`.

## Constraints

- `npx tsc --noEmit` must exit 0.
- `npx eslint src/lib/billingReview.ts src/lib/billingReview.check.ts` clean.
- The compile-and-run above prints every case as passing and exits 0.
- Add no dependency. Touch no config file.
- No `any`. No non-null assertions (`!`). Handle the nulls properly — they are
  the whole point of this module.
- Pure and deterministic: no `Date.now()`, no `new Date()` without an argument,
  no randomness. Every input arrives as a parameter.

## Report back

Paste: the two file contents, the vitest output, and the tsc/eslint result.
State which of the 13 cases you covered and any you could not.

---

## Attempt 1 — qwen2.5-coder:32b, 2026-08-31. Not accepted.

Raw output kept at `scratchpad/local_out.txt` (875 lines). Ran 34 min, stopped at
`done_reason: length` with `num_predict: 8192` — **the module is complete, the
check file is truncated mid-case-13.** Re-run needs a much larger `num_predict`,
or split into two calls (module first, checks second with the module pasted in).

Three defects to fix in the module before it is worth keeping:

1. **`minutes` is not whole minutes.** It calls `round2`, yielding `95.53`. The
   spec says round to whole minutes.
2. **Non-null assertions (`!`)** in `determineVerdict` and the median map. The
   spec forbids them.
3. **Fixing (1) exposes a latent hole.** When `manHours` is `0`,
   `impliedHourly` is `null`, and `determineVerdict` compares `null < x` — which
   is `false` — so the row silently returns `"ok"` instead of `"unmeasured"`.
   Unreachable today only because `round2` keeps tiny durations non-zero; whole-
   minute rounding makes a sub-30-second window round to `0`. **Fix 3 before 1,
   or the fix looks like a regression.**

Correct and worth keeping: verdict precedence, the `< 3` median guard, median-
not-mean, even-length averaging, and the sort order.
