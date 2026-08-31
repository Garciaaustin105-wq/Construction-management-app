# HANDOFF — Overdue visits get their own place

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` (after `feat/org-date` merges). Work on `feat/overdue-visits`.**

---

## Lane boundaries

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Migrations, crons, libs, `my-route` | Claude | `src/lib/*.ts`, `src/app/api/**`, `src/app/lawn/my-route/page.tsx`, migrations |
| **Overdue surface — YOURS** | **you** | `src/app/lawn/overdue/**` (new), `src/app/lawn/page.tsx`, `src/app/lawn/calendar/page.tsx`, `src/lib/navItems.ts` |

**Do not create migrations — they are applied.** Do not push. Commit to `feat/overdue-visits` and stop.

---

## The problem

Work that did not happen stays mixed in with work that is scheduled. There are **12 overdue pending visits across the two live lawn orgs right now, the oldest 7 days late**, and nothing has ever told anyone. A visit that was missed keeps appearing as if it were normal, with no indication of *when* it was actually due.

## A date bug you must not reintroduce

Every date comparison in the lawn app used `new Date().toISOString().slice(0, 10)` — the **UTC** date. From 20:00 Eastern each evening that is already tomorrow, so the app silently shifted by a day: today's remaining visits were labelled "Overdue" and tomorrow's became "Today". Every night, for four hours.

**Never use `toISOString()` to get "today" again.** Use:

```ts
import { todayInZone, dueBucket, daysLate, lateLabel, formatDueStamp, DEFAULT_TIME_ZONE } from "@/lib/orgDate";
```

`organizations.timezone` is applied (IANA name, defaults to `America/New_York`). Fetch it alongside the profile in one round trip — `my-route` shows the pattern:

```ts
.select("role, organizations(timezone)")
```

This matters on the server especially: Vercel runs in UTC, so a "local date" helper changes nothing there. The zone must come from the organisation.

## What to build

### 1. `/lawn/overdue` — the overdue list

Office/admin, gated like `/lawn/crews`. The daily notification already links here, so the route name is fixed.

Each row shows the property, the customer, **the date it was actually due** (`formatDueStamp`) and **how late it is** (`lateLabel` — "7 days late"). The date stamp is the whole point: an overdue visit with no original date is just a visit you cannot plan around.

Sort oldest first. Group by how late if it reads better, but do not hide the count.

### 2. Actions on each row

- **Reschedule** — set a new `due_date`. Office/PM only; the crew guard trigger blocks a crew member from moving a date, so this page being office-gated matches what the database will allow.
- **Mark skipped** — `POST /api/lawn/visits/[id]/status` with `{ status: "skipped", skip_reason: "..." }`. **Use the route, never a direct table update** — it sends the customer's skipped notice, and a direct update silently skips that. Require a reason; a skip without one is indistinguishable from forgetting.
- **Mark done** — `POST /api/lawn/visits/[id]/status` with `{ status: "done" }`. This **emails the customer**. Label it so nobody taps it thinking it is bookkeeping — something like "It was done — notify the customer".

Bulk actions are welcome for reschedule and skip. **Not for done**, since that sends mail.

### 3. Get overdue out of "today" everywhere else

- `src/app/lawn/page.tsx` — its `dueLabel` still uses the UTC date; switch it to the org zone, and make the overdue KPI link to `/lawn/overdue`.
- `src/app/lawn/calendar/page.tsx` — `todayIso` has the same bug.

### 4. Nav

Add Overdue to the lawn office/admin block and the Office hub aliases. **Run `buildMobileNav` for every role and confirm nothing is orphaned.** A count in the label is fine here — unlike the payroll list, overdue work is a real backlog the office should feel.

## Constraints

- `npx tsc --noEmit` exits 0. `npx eslint src/` must not gain a new error — about 14 pre-existing are being fixed separately; do not add to them and do not fix them here.
- `react-hooks/set-state-in-effect` is enforced. No polling loops.
- Lawn only, gated on `isLawn()`. **Construction must be byte-identical** — I verify by executing `buildNavItems` and `buildMobileNav` for all 8 roles in both variants and diffing.
- RLS scopes the queries. No manual `organization_id` filters.
- Stage explicitly. `src/lib/turnstile.ts` holds another lane's uncommitted work; leave it.

## Verify, and report what you verified

**Never write to `Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) — a real paying customer, and two of these actions EMAIL THEIR HOMEOWNERS.** Seed only in `Terra Verde Test Co` (`600d02fa-fae2-440b-99ab-42e96997da91`), scope every statement by `organization_id` including cleanup, and delete what you seed. Terra Verde already has 8 genuinely overdue visits, so you may not need to seed at all.

Confirm specifically:

1. The list shows the original due date and days late for each row.
2. Reschedule moves the date and the row leaves the list.
3. Skip requires a reason and goes through the status route.
4. A crew-role user cannot reach `/lawn/overdue`.
5. Nothing you touched still calls `toISOString()` to derive "today".
