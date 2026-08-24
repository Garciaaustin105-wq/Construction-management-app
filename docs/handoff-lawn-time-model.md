# Opus handoff — Lawn time-model Slice 1 (run SQL + build UI + consumers)

Prepared by Claude-direct 2026-08-23. The migration is **already drafted and
signed off** by Claude-direct — you may RUN it. Then build the capture UI and
the data consumers. This is Slice 1 of the GorillaDesk competitive plan; the
full research contract is `GORILLADESK_FEATURE_ADOPTION.md` (repo root, one dir
up from `docs/`). Read it for the "why"; this doc is the "what to do now".

## Repo state (re-verify `git status` before you start — multi-session repo)

- Repo: `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app`. Branch from `origin/main`
  (== `9e4201a`, "lawn AI admin slice 2"). Tree is clean as of this writing.
- `stash@{0}` (`wip-pre-ai-admin`) holds unrelated ISP/cohesion WIP. **Do NOT pop.**
- **ISP/installs module is NOT on this branch** (no `src/app/installs/`, no
  `src/lib/ispBilling.ts`). But the `installs` TABLE exists in prod with
  `duration_minutes` + `started_at` — use it as a **naming/type precedent only**;
  you cannot read its application code here.
- `plan_limits_past_due_gate.sql` is already RUN on prod — don't re-run it.
- Never `git add -A`. No commit/push without the user saying "push". Claude-direct
  does the final build-gate + ship to main.

## STEP 0 — RUN the migration (Claude-direct has signed off)

File: `lawn_time_model.sql` (repo root). Additive + idempotent (passes
`scripts/check-migrations.mjs` — the guard's 7 findings are all in pre-existing
unrelated files `drop_connect_columns.sql` / `estimates_merge_b.sql`, NOT this
one). It adds 5 nullable columns:

| Table | Column | Type |
|---|---|---|
| `lawn_services` | `default_duration_minutes` | `int` |
| `recurring_schedules` | `estimated_duration_minutes` | `int` |
| `lawn_visits` | `started_at` | `timestamptz` |
| `lawn_visits` | `scheduled_window_start` | `time` |
| `lawn_visits` | `scheduled_window_end` | `time` |

Run it in the **Supabase SQL Editor** for project `avmqteevisqxwmmxkrbg`, then run
the verification query at the bottom of the file — expect 5 rows with the types
in the comment. All nullable, so the live app keeps working with NULLs until your
UI populates them. No RLS changes (new columns inherit each table's existing
policies — same as `route_order`/`notified_at`/`invoice_id` were added).

## STEP 1 — capture the data (UI, yours)

| Surface | File | Change |
|---|---|---|
| Service catalog | `src/app/lawn/services/page.tsx` | Add "Default duration (min)" to the service manager (optional int) |
| Schedule editor | `src/components/RecurringScheduleEditor.tsx` | Optional per-schedule duration override + preferred time window (start/end `time`) |
| Visit detail | `src/app/lawn/visits/[id]/page.tsx` | Show the window; add a "Start" action that stamps `started_at = now()` |
| Property card | `src/components/LawnPropertyDetails.tsx` | No change — already good |

### Design decision (made by Claude-direct — don't relitigate)
**"Start" does NOT change visit status.** Stamp `started_at` only; leave
`status` on `pending`. The lifecycle module `src/lib/lifecycles/lawn-visit.ts`
owns `pending → [done, skipped]` and every detail-page action composes from
`validTransitions(status)` × role permission. Adding an `in_progress` status
would mean editing the lifecycle table + every consumer (Today's Route reads
`status='pending'`, bulk ops, customer portal, notifications). On-site duration
is already `completed_at − started_at` — no lifecycle churn needed. Status
changes continue to go through `src/lib/lifecycles/lawn-visit.ts` only.

### Effective duration resolution (use this in the consumers below)
Per stop: `recurring_schedules.estimated_duration_minutes` if set, else
`lawn_services.default_duration_minutes` (joined via the schedule's
`service_type` → `lawn_services.name`), else `null` (no service time — current
behaviour). The visit detail / route planner should resolve and display this.

## STEP 2 — use the data (consumers)

1. **`src/app/api/lawn/route-optimize/route.ts`** — the payoff. Today it accepts
   only `{lat,lng}` (see `validPoints`) and returns a Google Distance Matrix
   drive-duration matrix with **zero per-stop service time**. Add an OPTIONAL
   `durations` array (seconds, same length + order as `origins`) the client sends
   per stop; add it to the diagonal (self→self) or to each stop's service time in
   the returned matrix so the optimizer builds a feasible day, not just a short
   drive. **Keep it backward compatible**: `durations` optional → existing callers
   unaffected. **Do NOT touch the gate** (`OFFICE_LIKE.has(role)`, the
   `check_route_opt_quota` call BEFORE Google, the 503-on-no-`GOOGLE_MAPS_SERVER_KEY`
   fallback). Claude-direct will review this route at the build-gate before ship.
2. **`src/app/api/lawn/cron/remind/route.ts`** — when a visit has
   `scheduled_window_start`/`_end`, include the window in the reminder copy
   ("between 9 and 11"). NULL window → current "today" copy.
3. **`/lawn/insights`** — once `started_at` has data, show actual vs estimated
   duration (actual = `completed_at − started_at`; estimated = the resolution
   above). Gated behind "has any `started_at` rows" so it doesn't render empty
   on day one.

## Schema facts (verified by Claude-direct against live code — don't re-derive)
- `lawn_visits` live columns: `id, recurring_schedule_id, job_id, organization_id,
  due_date, status, crew_id, completed_at, notes, created_at, notified_at,
  invoice_id, route_order, share_token, notified_skipped_at, skip_reason` (+ the 3
  new ones after STEP 0). `due_date` is a `date` (no time). `completed_at` exists,
  `started_at` did NOT (until STEP 0).
- `lawn_services`: `id, organization_id, name, default_price, active, created_at`
  (+ `default_duration_minutes` after STEP 0).
- `recurring_schedules`: `id, job_id, organization_id, frequency, interval_weeks,
  days_of_week, day_of_month, start_date, end_date, service_type, price_per_visit,
  active, notes, created_by, created_at` (+ `estimated_duration_minutes` after STEP 0).
- `lawnRouting.ts` `RouteStop` type has NO duration field today — you'll likely add
  an optional `durationSec`/`estMinutes` there so the planner carries it.
- route-optimize `validPoints` today: 2-25 `{lat,lng}` points, finite numeric.
- Customer is reached THROUGH `jobs.customer_id` (lawn_visits/recurring_schedules/
  chemical_applications have no `customer_id`).

## Ground rules (verbatim project rules)
- **Blue primary** (`bg-blue-600`) on BOTH deploys. Lawn green is chrome/back-links/
  badges only — never on `Button`/`LinkButton` primary.
- **Role gates EXACT**, cross-referenced against `src/lib/navItems.ts`. On lawn,
  `project_manager` returns base nav only; the office-surface list is the
  fallthrough block reached by **office + admin only**. `super_admin` has a null
  org → bounce from every org-scoped page. Flag mismatches; never silently change
  access.
- **No new SQL without sign-off** — the migration in STEP 0 is the signed-off
  exception. Any further schema change stops and comes back to Claude-direct.
- **RLS session client** for reads; service role is server-only and never for a
  read the session client can do.
- Public/token portals do NOT get `PageContainer` app chrome.
- Status changes go through `src/lib/lifecycles/*` (see the Start decision above).
- Don't touch other features' uncommitted files. Never `git add -A`; stage only
  your own files.

## Build gate (run BEFORE reporting done)
Wipe `.next` BEFORE each variant build (avoids stale generated types), but
run `tsc` AFTER a build **without** wiping — `LayoutProps` is a Next-*generated*
global that lives in `.next/types`, so `rm -rf .next && tsc` fails with
`TS2304: Cannot find name 'LayoutProps'`. tsc reads what the last build wrote:
```
rm -rf .next && NEXT_PUBLIC_APP_VARIANT=lawn npx next build
rm -rf .next && NEXT_PUBLIC_APP_VARIANT=construction npx next build
npx tsc --noEmit
```
All three exit 0.

## Report back
1. Confirmation you ran `lawn_time_model.sql` + the 5-row verification result.
2. File list of everything you created/changed.
3. The route-optimize change (diff summary) — Claude-direct reviews before ship.
4. Build-gate results (all three exit 0).
5. Any schema drift you found vs the "Schema facts" above.
Do NOT push — Claude-direct does the build-gate re-verify + ship after the user
says "push".