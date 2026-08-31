# HANDOFF — Payroll grid (worker × week), phase 4

**For: GLM 5.3 Flash. Written 2026-08-30 by Claude Opus 5.**
**Base branch: `main` @ `b4f9cea` or later. Work on `feat/payroll-grid`.**

---

## Lane boundaries — read this first

Three agents are working this feature in parallel. **Stay inside your lane or we
get merge conflicts.**

| Lane | Owner | Files — DO NOT touch outside your row |
|---|---|---|
| Shift clock + Start button | Claude (in progress) | `src/app/crew/time/page.tsx`, `src/app/lawn/my-route/page.tsx`, DB migrations |
| Pure week helpers | local model | `src/lib/payrollWeeks.ts` |
| **Payroll grid — YOURS** | **you** | `src/app/admin/reports/weekly/page.tsx`, `src/app/time/page.tsx`, `src/app/admin/reports/page.tsx` |

**Do not create or edit any migration.** The schema work is done (see below) and
applying another migration concurrently will collide.

**Do not edit `src/lib/payrollWeeks.ts`.** It is being generated in parallel. If
it is missing when you start, write your own local helpers inside your page and
leave a `TODO` — do not create that file.

---

## What already changed underneath you (done, live on prod DB)

Three migrations shipped. You do not need to apply anything; just know the new
shape:

1. **`time_entries.job_id` is now NULLABLE.** A row with `job_id IS NULL` is a
   **SHIFT entry** — one clock-in covering a whole lawn route for the day. A row
   with a job is a **JOB entry** (construction, per cost code). This is the whole
   point of the redesign: at 20 stops a day, per-job punching meant 40 taps, so
   nobody used it — there are 4 time entries in the entire platform.

2. **New index `idx_time_entries_org_clock`** on `(organization_id, clock_in_at desc)`.
   Your grid's access pattern is "this org's entries over a date range" — that
   index exists specifically for you. The old `idx_time_entries_user_clock` is
   `(user_id, clock_in_at)` and cannot serve an org-wide range scan.

3. **`time_entries` now uses its own org-stamp trigger**
   (`set_org_from_job_or_user`). Irrelevant to reads; noted so you do not think
   the shared `set_org_from_job` is missing.

---

## The problem you are fixing

`/admin/reports/weekly` builds a **day × worker** grid, then caps it:

> "This range is 30 days — too wide for the on-screen grid. Switch to a 2-week or
> shorter range… or download the Excel."

So the one view payroll actually wants — a whole month, everyone, at a glance —
is the one view the app refuses and sends you to a spreadsheet for. Days are the
wrong column for a pay period. **Weeks are.** A month is 5 columns instead of 30,
which fits a phone as well as a desk.

---

## What to build

### 1. Month view: worker × week

In `src/app/admin/reports/weekly/page.tsx`, when the range is longer than 14
days, render a **week-column grid instead of the current "too wide" message.**
Keep the existing day × worker grid exactly as it is for ranges ≤ 14 days — do
not regress it.

- Rows = workers (same row source the page already builds)
- Columns = the weeks overlapping the range, Monday–Sunday
- Cell = hours that worker logged in that week
- Right-hand column = worker total; bottom row = per-week totals; corner = grand total
- `font-variant-numeric: tabular-nums` on every number cell so columns line up
- Wrap in `overflow-x: auto` — the page body must never scroll sideways

The page already computes `r.byDay` (a `Record<YYYY-MM-DD, hours>`) per worker.
Bucketing that into weeks is all you need; do not re-query.

### 2. Layered drill-down

Three layers, collapsed by default:

| Layer | Shows | Answers |
|---|---|---|
| month | worker × week | Does this pay period look normal? |
| week | click a cell → that worker's 7 days | Which day is the outlier? |
| day | expand a day → the entries in it | What happened, and is it approved? |

Keep it a **server component with URL state** (`?expand=<workerId>:<weekStart>`)
if you can — this codebase prefers that over client state, and the existing
filters already work through `searchParams`. A small client component for the
expand toggle is acceptable if the server approach gets ugly.

### 3. Two things the cell must show that today's grid omits

Both matter specifically for payroll and both are currently invisible:

- **Approval state.** `time_entries.status` is `pending | approved | rejected`.
  Unapproved hours are not payable, and right now you cannot see that without
  opening each entry. Show it in the cell — a dot, a tint, whatever reads at a
  glance. **Rejected hours must not be counted in any total.**
- **Still clocked in.** `clock_out_at IS NULL` is not zero hours, it is an open
  question. One of the four entries in the system right now is exactly that
  (someone forgot to clock out). Mark it distinctly; do not silently treat it as
  0 or as "now minus clock-in" in a payroll total.

### 4. Shift vs job entries

With `job_id` nullable you will now see both. In the day layer:

- `job_id IS NULL` → label it **"Shift"**, not "No job"
- `job_id` set → the job name, as today

`src/app/time/page.tsx` already renders `s.job?.name ?? "No job"` — update that
string to "Shift" too, since that file is in your lane.

### 5. Reports index card

`src/app/admin/reports/page.tsx` describes the report as *"Hours, receipts, and
payments per worker for a date range."* Update the copy to mention the month
view. Rename the card from "Per-Worker Report" to **"Timesheets & payroll"** if
it reads better — your call.

---

## Constraints (non-negotiable)

- **`npx tsc --noEmit` must exit 0 before you commit.**
- **`npx eslint <your changed files>` must be clean.** In particular this repo's
  `react-hooks/set-state-in-effect` rule is enforced — never call `setState`
  synchronously in an effect body. Derive the value instead.
- **RLS does the scoping. Do not add org filters by hand** — `time_entries` is
  already scoped by policy; a manual `.eq("organization_id", …)` is redundant and
  drifts.
- **Do not add a polling loop or a `useEffect` fetch.** This app had 10-second
  page loads last week caused by exactly that; the fix is fresh and I do not want
  it undone.
- **Stage explicitly. Never `git add -A`.** There are untracked files in this repo
  that are deliberately uncommitted.
- **Do not push to `main`.** Commit to `feat/payroll-grid` and stop.

## Verification before you hand back

There are only **4 time entries platform-wide**, so the grid will look empty.
That is expected — the shift clock that produces rows is being built in parallel.
Verify with seeded data instead:

1. Insert a handful of `time_entries` for two workers across three different
   weeks, with a mix of `status` values and one row with `clock_out_at` null.
   **Delete them again afterwards** — this is the production database.
2. Confirm: totals are right, rejected rows are excluded, the open row is flagged
   rather than counted, weeks bucket Monday–Sunday, and a 30-day range renders
   the grid instead of the "too wide" message.
3. Confirm a ≤14-day range still renders the original day grid unchanged.

Report what you verified, not just that you finished.
