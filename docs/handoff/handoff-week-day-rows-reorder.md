# HANDOFF — reorder the route inside a day, and make the drop target visible

**For: GLM 5.3 Flash. Written 2026-09-01 by Claude Opus 5.**
**Base branch: `feat/week-day-rows` (NOT main). Work on `feat/week-day-reorder`.**
**Commit, do not push.**

---

## Scope

`src/components/LawnCalendarBoard.tsx`, the **mobile day rows only** — the
`lg:hidden` block inside the week view that the previous lane added.

**Do not touch** the month view, the day view, the agenda view, the desktop
crew × day matrix, or `handleDragEnd`. No migrations, no SQL, no new dependency.

---

## The feedback, in the user's words

> "there isnt any control to where i drag and drop jobs on the weekly everything
> seems so cramped and when i hold and try to drag to a certain day or in the
> same day to move around the schedule it doesnt really highlight the day when i
> drag over each day, or make space to drop in between the other routes in the
> same day or the other days to place it first or last on the route list"

Three distinct problems. Two are bugs; one is a missing capability.

## Problem 1 — the drop highlight is invisible (a real bug)

`DroppableCell` already applies `isOver ? "bg-blue-50 ring-1 ring-blue-300"`.
**The day row uses those exact classes for "today".** So on today's row there is
no visible change whatsoever, and elsewhere `bg-blue-50` on white is too faint to
notice mid-drag.

**Fix:** give the drag-over state a treatment that is unmistakably different from
the today state and readable at arm's length on a phone — a stronger fill and a
heavier ring, not a one-shade nudge. Today and drag-over must remain
distinguishable when they coincide, because the day you are dropping onto is very
often today.

Do not change `DroppableCell`'s signature; other views use it.

## Problem 2 — no reordering inside a day (the missing capability)

Chips are `useDraggable`, cells are `useDroppable`. That pattern moves an item
*between* containers and nothing more. Making a gap open at the insertion point,
dropping between two visits, placing something first or last — that is
**`@dnd-kit/sortable`**, which is **already a dependency (^10.0.0)**. Do not add
anything.

**Build:** each day row becomes a `SortableContext` over that day's visits
(`verticalListSortingStrategy`). Dragging within a row reorders; a real gap opens
where the item will land.

**`DraggableChip` is shared with the month, week-matrix and day views — do not
convert it to `useSortable`.** Add a sortable variant, or a prop that switches
which hook it uses, so the other three views keep the exact behaviour they have.
Say in your report which you chose and why.

Cross-day dragging must keep working exactly as it does now, via the bare-date
`DroppableCell` id and the untouched `handleDragEnd`.

## Problem 3 — cramped

Rows are `p-2` with `gap-1.5`, sized when the layout was still fighting for
width. There is room to breathe now. Give chips a comfortable touch height and
the row honest padding. A drag handle is not required, but the chip must be
grabbable without triggering a scroll.

---

## Persisting the order — read this carefully, it is the risky part

`route_order` already exists and is already written by `RouteMapPlanner`. **Mirror
that pattern; do not invent one.** From `src/components/RouteMapPlanner.tsx`:

- `route_order` is **per crew, 1..n**, counted by walking the visual order and
  incrementing a counter keyed by `crew_id`.
- A visit with **no crew gets `route_order: null`**.
- Writes are **debounced ~800ms** and **skipped on mount**, so the initial render
  never persists an order nobody asked for.
- Each visit is a plain `supabase.from("lawn_visits").update({ route_order })`
  in a `Promise.all`. **No `router.refresh()`** — local state is the truth and a
  refresh mid-drag is jarring.

**The wrinkle you must solve:** `route_order` is per-crew, but a day row shows
**every crew mixed together**. "Position 2" is ambiguous when the list holds
visits from three crews.

Resolve it this way:

- **Sort each day row by `route_order` (nulls last), then `scheduled_window_start`
  (nulls last).** The saved sequence becomes the visible order — which is what a
  route list should show, and it replaces the window-only sort the previous lane
  used.
- **On reorder, walk the new visual order and assign per-crew counters**, exactly
  as `RouteMapPlanner` does. Moving a visit above another visit **of the same
  crew** changes their order. Moving it past a **different** crew's visit leaves
  both crews' sequences intact.
- For a solo operator — one crew, our most common case — this is simply "first to
  last", which is what the user asked for.

**Only write `route_order`. Do not write `crew_id` from this surface.** Crew
assignment on a phone is not part of this lane, and
`guard_lawn_visit_crew_update` restricts who may change it.

---

## What must not break

- The desktop crew × day matrix — byte-identical.
- Month, day and agenda views — byte-identical.
- `handleDragEnd` — no changes. Cross-day drops still go through the bare-date id.
- `react-hooks/set-state-in-effect` is enforced. No polling. Defer with
  `queueMicrotask` if you must set state from an effect.
- **Never `toISOString()` for "today"** — `todayIso` is passed in.
- Stage explicitly by path; other lanes have work in this tree.

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (13 pre-existing warnings are fine).

## Report back, with evidence

1. Drag-over is obviously visible **and** distinct from today — including when the
   day you are dragging onto IS today.
2. A gap opens between visits at the insertion point while dragging.
3. Dropping first / last / between within a day persists, and the order survives a
   reload.
4. `route_order` is written per crew as 1..n, unassigned visits get null, and the
   write is debounced and skipped on mount. Say how you confirmed it.
5. Cross-day drag still reschedules and keeps the crew; `handleDragEnd` has zero
   diff lines.
6. Which approach you took for the sortable chip, and evidence the other three
   views are unchanged.
7. `crew_id` is never written from this surface.

## Test data

`Terra Verde Test Co` — `600d02fa-fae2-440b-99ab-42e96997da91`. Fabricated; seed
and delete freely. `Peanutz L&L` — `d236eba1-8e84-4dae-a40d-ef2651cbbb9c` — is a
**real paying customer. Never write to it.**
