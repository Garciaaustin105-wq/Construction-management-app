# HANDOFF — The calendar is hard to read. Fix it.

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` @ `ad75a8f` or later. Work on `feat/calendar-legibility`.**

---

## Lane boundaries

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Migrations, crons, libs | Claude | `src/lib/*.ts` (except as noted), `src/app/api/**`, migrations |
| **Calendar — YOURS** | **you** | `src/app/lawn/calendar/page.tsx`, `src/components/LawnCalendarBoard.tsx` |

**Do not create migrations.** Do not push. Commit to `feat/calendar-legibility` and stop.

---

## The complaint, in the user's words

> "hard to see or find jobs, if i look at the calendar with the month it shows unassigned and then the job detail, i dont see customer name or details on whether the job is behind or never done, then when i go to agenda i have no way to see the past dates it shows only current today and then future dates."

All three are real and I have confirmed each in the code. This is not a polish task — the calendar currently cannot answer "whose lawn is this" or "is this late", and hides missed work entirely.

## Cause 1 — the customer is never fetched

`src/app/lawn/calendar/page.tsx` selects:

```
"id, due_date, status, crew_id, recurring_schedule_id, scheduled_window_start,
 scheduled_window_end, recurring_schedules(service_type), jobs(name, lawn_jobs(map_lat, map_lng))"
```

No customer, no address. The board *cannot* show a name it was never given.

**Fix:** add `customers(name)` and `address` to the `jobs` embed. Keep it a LEFT join — do not add `!inner` — because **4 of Terra Verde's 8 overdue visits have no customer at all**, and an inner join would silently drop them. Fall back to the job name when the customer is null, the way `/lawn/overdue` does.

Add the fields to `BoardVisit` in `LawnCalendarBoard.tsx` and show the customer as the primary label on the chip, with the job name secondary — a crew knows "the Hendersons", not "job 4c1".

## Cause 2 — nothing marks a visit as late

The board receives `todayIso` but only uses it to highlight today. A chip renders `status` verbatim, so a visit due *tomorrow* and one that was due *seven days ago* both read "pending".

**Fix:** derive a display state, do not add a column:

| Condition | Reads as |
|---|---|
| `status === "pending"` and `due_date < todayIso` | **Overdue** — plus how late, via `lateLabel` from `@/lib/orgDate` |
| `status === "pending"` and `due_date >= todayIso` | Scheduled |
| `status === "done"` | Done |
| `status === "skipped"` | Skipped |
| `status === "paused"` | Paused |

Overdue needs to be visually obvious at a glance in month view, where chips are small — colour plus the day count. "Never done" is not a separate state: it is Overdue that has been overdue a long time, and `lateLabel` already says "7 days late".

**Use `todayInZone` / `lateLabel` / `dueBucket` from `@/lib/orgDate`. Never `toISOString()` for "today"** — that bug shifted the whole app by a day every evening after 20:00 Eastern and was fixed hours ago. `page.tsx` already resolves the org timezone; thread it through.

## Cause 3 — agenda cannot show the past

```ts
} else {                       // agenda
  gte = todayIso;
  lte = toISODate(addDays(new Date(), 30));
}
```

Overdue visits are excluded from the query outright, which is why they are unreachable in agenda. This is the worst of the three: the work most needing attention is the work you cannot see.

**Fix:**

- Widen the agenda window to start before today. Default to something like 30 days back through 30 days forward.
- **Group past-due work at the TOP, not in date order below today.** Chronological order buries the important part; a "Past due (8)" group first is the whole point.
- Give the user a way to go further back — a "show earlier" control or a range selector. Do not silently cap and leave them wondering.
- Empty state should distinguish "nothing overdue" (good) from "nothing scheduled" (maybe not).

## Also

- **Month view leads with "Unassigned".** Unassigned is a real state — most of the live data is unassigned — but it should not be the loudest thing on the chip. Customer first, assignment secondary.
- Consider surfacing the existing status filter more prominently, and defaulting the agenda to exclude `done` so the list is about outstanding work.
- Link a chip to the visit detail if it does not already.

## Constraints

- `npx tsc --noEmit` exits 0. `npx eslint src/` must not gain a new error — about 14 pre-existing are being fixed separately; do not add to them and do not fix them here.
- `react-hooks/set-state-in-effect` is enforced. **No polling loops.**
- Lawn only. **Construction must be byte-identical** — I verify by executing `buildNavItems` and `buildMobileNav` for all 8 roles in both variants and diffing against a `git show main:` baseline. (Your own harness produced a false zero-diff last lane by comparing the branch against a copy of itself — build the baseline from git, not from the working tree.)
- RLS scopes the queries. No manual `organization_id` filters.
- The drag-to-assign behaviour in this board already works. **Do not regress it** while restyling chips.
- Stage explicitly. `src/lib/turnstile.ts` holds another lane's uncommitted work; leave it.

## Verify, and report what you verified

`Terra Verde Test Co` (`600d02fa-fae2-440b-99ab-42e96997da91`) is the user's own sandbox and **all of its data is fabricated — seed and delete freely**. It currently has **8 genuinely overdue visits, 4 to 7 days late**, so you should not need to seed anything for this.

`Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) is a **real paying customer — never write to it.**

Confirm specifically:

1. A month-view chip shows the customer name, and the job name when there is no customer.
2. An overdue chip is distinguishable from a scheduled one at a glance, and states how late.
3. Agenda shows past-due work, grouped first.
4. Drag-to-assign still works.
5. Nothing you touched derives "today" from `toISOString()`.
