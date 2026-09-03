# HANDOFF — the month view becomes navigation, not a working view

**For: GLM 5.3 Flash. Written 2026-09-01 by Claude Opus 5.**
**Base branch: `main` (now at `e5fd9c9`). Work on `feat/month-navigation`.**
**Commit, do not push.**

---

## Scope

`src/components/LawnCalendarBoard.tsx`, the **month view only** — the
`{view === "month" && month && (...)}` block and its cells.

**Do not touch** the week view (its phone day rows shipped today and are the
working view), the day view, the agenda view, `handleDragEnd`, or any other file.
No migrations, no SQL, no new dependency.

---

## Why — this is the last piece of a layered design

The user, twice: *"the monthly is still a horrible view."* They are right, and
the two previous attempts at it both failed for the same reason — they tried to
make the month grid a **working** view.

The researched pattern is layered:

> "A compressed monthly overview for navigation context, a detailed week or day
> view for active planning, and clear visual differentiation between today,
> selected dates, and event-occupied days."

The middle layer now exists: as of today the week view on a phone is seven
scrollable day rows with real names, sortable routes and working drag. **So the
month view no longer has to carry any of that.** Its only job is: *which days
have work, and take me there.*

Seven columns on a 375px phone is ~45px per cell. That is hopeless for a name —
but it is entirely adequate for a date and a few dots, which is all navigation
needs.

## What to build

**Below `lg`,** a month cell shows:

- the day number (today visually distinct — the file already uses
  `bg-blue-50 ring-1 ring-blue-300`),
- up to **3 dots**, one per visit, coloured by `colorFor(v).dot`,
- a small `+N` when there are more,
- the `CloudRain` icon when `rainRiskSet.has(dateStr)`, as now.

**The whole cell is a link** to the week containing that day:

```
/lawn/calendar?view=week&date=${dateStr}
```

That route already exists — the page accepts `?view=week&date=YYYY-MM-DD` and
centres the week on it. Use `next/link`. Week, not day: the week view is where
the good phone layout lives.

Cells should be **short**. With no chips there is nothing to stack, so the mobile
cell can come back down near its original `min-h-[64px]` — a month should fit on
a screen with little scrolling. That is the point of an overview.

**At `lg` and above: completely unchanged.** Chips, drag, `+N more`, all of it.

Tailwind breakpoints only (`lg:hidden` / `hidden lg:block`). **No JS viewport
checks** — `react-hooks/set-state-in-effect` is enforced.

## Drag on the phone month goes away — deliberately

Chips are not rendered below `lg`, so there is nothing to drag there. **This is
not a capability being removed.** The user explicitly objected to losing mobile
drag when it was proposed before, and they were right at the time — there was
nowhere else to do it. There is now: the week view's day rows support both
cross-day drag and route reordering on a phone, properly. Drag moves to where it
works instead of being simulated badly in a 45px cell.

**`DroppableCell` must remain the cell wrapper** with its current `id={dateStr}`
— the desktop grid still drops onto it, and removing it would silently break
drag-to-schedule on desktop.

## Prior art — read, do not copy

`fix/month-view-mobile` (pushed, unmerged) contains an earlier attempt at dots
and bars for this cell. **Its sizing is wrong for this lane** — it was built when
the month was still meant to be a working view, so cells are tall (104px) and
bars are drag targets. Take the dot rendering idea; leave the dimensions. Do not
merge that branch.

## Rules

- `DraggableChip` keeps all its current props on the desktop branch. Do not pass
  `dense` (that prop does not exist on `main`).
- **Never `toISOString()` for "today"** — `todayIso` is passed in.
- Read-only: no `.insert`, `.update`, `.delete` in your new code.
- The cell link must be keyboard reachable, with a sensible accessible name
  (e.g. the date plus the visit count) — it is a navigation control now.
- Stage explicitly by path.

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (13 pre-existing warnings are fine).

## Report back, with evidence

1. At phone width a month cell shows date + dots + `+N` and **no chips**; the
   whole month fits with little scrolling. State the cell height you settled on.
2. Tapping a day opens the week view centred on that date.
3. At `lg`+ the month grid is unchanged — chips, drag, `+N more`. Say how you
   confirmed it, and that `DroppableCell` still wraps every cell.
4. Desktop drag-to-schedule onto a month cell still works.
5. Today is visually distinct from other days, and from a day that merely has
   visits.
6. Nothing derives "today" from `toISOString()`.
7. Week, day and agenda views have zero diff lines.

## Test data

`Terra Verde Test Co` — `600d02fa-fae2-440b-99ab-42e96997da91`. Fabricated; seed
and delete freely. `Peanutz L&L` — `d236eba1-8e84-4dae-a40d-ef2651cbbb9c` — is a
**real paying customer. Never write to it.**
