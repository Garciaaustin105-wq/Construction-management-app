# HANDOFF — make the phone drag feel right

**For: GLM 5.3 Flash. Written 2026-09-02 by Claude Opus 5.**
**Base branch: `main`. Work on `feat/day-row-drag-feel`.**
**Work in a DEDICATED WORKTREE, not the shared checkout — see "Process" below.**
**Commit, do not push.**

---

## Scope

`src/components/LawnCalendarBoard.tsx`, the **phone day rows** in the week view
(`MobileDayRow`, `SortableDayChip`, the sensors, and the day-row `DndContext`).

**Do not touch** the month view, the desktop crew × day matrix, the day view, the
agenda, `handleDragEnd`, or `handleDayRowDragEnd`'s persistence logic. No
migrations, no SQL, no new dependency.

---

## The feedback

> "the weekly scheduled is very finiky with pressing and holding then when i drag
> it around it doesnt follow my finger it kind of waits until im in the box to
> highlight the box and drop, then also it seems like the middle box or for now
> wensday is stuck in highlighted blue for some reason"

Three problems. **Wednesday is not stuck** — 2 September 2026 IS a Wednesday, and
today's row is permanently `bg-blue-50 ring-1 ring-blue-300`. That it reads as a
stuck drag state is problem 3.

## Problem 1 — the chip does not follow the finger

There is **no `DragOverlay`** in this file (zero occurrences). Without one,
dnd-kit translates the original element in place. Inside a vertical scrolling
list on touch that lags, clips at the row boundary, and gives exactly the
"doesn't follow my finger, waits until I'm in the box" feel described.

**Fix:** add a `<DragOverlay>` to the **day-row `DndContext` only**. Track the
active chip on `onDragStart`, clear it on `onDragEnd`/`onDragCancel`, and render
the dragged visit's face in the overlay so a real chip follows the pointer.

`VisitChipFace` already exists — it was extracted precisely so a chip's visuals
could be rendered independently of its drag hook. Use it. Do not duplicate the
markup, and do not give the overlay a `useDraggable`/`useSortable` id.

Keep the source chip visible-but-dimmed while dragging (it already has an
`isDragging` opacity treatment) so the row does not collapse under the finger.

## Problem 2 — press-and-hold is finicky

```
PointerSensor: { activationConstraint: { distance: 6 } }
TouchSensor:   { activationConstraint: { delay: 200, tolerance: 8 } }
```

`tolerance: 8` aborts the drag if the finger moves more than 8px during the
200ms hold. On a phone, holding a fingertip within 8px for a fifth of a second
while a list is scrollable is genuinely hard — a small drift cancels it and the
page scrolls instead.

**Fix:** loosen the touch activation so an ordinary hold succeeds without making
accidental drags likely during a scroll. Raising `tolerance` matters more than
changing `delay`. **Leave `PointerSensor` alone** — mouse drag on desktop is not
reported as a problem, and the 6px distance is what lets a plain tap still open
the schedule editor.

State in your report what you settled on and why.

## Problem 3 — today looks like a stuck drop target

Today's row and the drag-over state are both blue:

| state | styling |
|---|---|
| today (permanent) | `bg-blue-50 ring-1 ring-blue-300` |
| drag-over | `bg-blue-200 outline-2 outline-dashed outline-blue-500` |

They are technically different, but a permanently-blue row next to a
blue-on-drag row reads as stuck. The user reported it as a bug, which is the
only evidence that matters.

**Fix:** give **today** a treatment that is not blue at all in the phone day
rows — a neutral or accent tone, a left border, a "Today" label, whatever reads
as *identity* rather than *state*. Blue stays reserved for the transient
drag-over. Desktop and the month view keep their current today styling; only the
phone day rows change.

The principle: **state changes are blue and temporary; identity is not blue.**

## Rules

- Tailwind breakpoints only. **No JS viewport checks** —
  `react-hooks/set-state-in-effect` is enforced.
- **Never `toISOString()` for "today"** — `todayIso` is passed in.
- `route_order` persistence and `handleDayRowDragEnd`'s write must be unchanged.
  Only `route_order` is ever written from this surface; never `crew_id`.
- Cross-day drag must still reschedule and keep the crew.
- The collision detection for day rows is `dayRowCollision` (pointerWithin with a
  rectIntersection fallback) — **keep it**. It fixed a separate complaint about
  having to drag two inches past the target.

## Process — read this, it cost us today

**Do not work in the shared checkout** (`C:\Users\garci_9e2kg3l\Projects\lowvoltage-app`).
Two lanes ran there at once earlier and a path-scoped `git stash` in one swept up
the other's uncommitted edits, which were then committed under the wrong message.
Nothing was lost, but only because it was noticed.

Create your own worktree, as you did for the month lane:

```
git worktree add ../lowvoltage-app-dragfeel -b feat/day-row-drag-feel main
```

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (13 pre-existing warnings are fine).

## Report back, with evidence

1. A chip visibly tracks the pointer during a drag, including across row
   boundaries. Say how you confirmed it.
2. Press-and-hold starts a drag reliably; a plain tap still opens the schedule
   editor; a scroll still scrolls. Give the sensor values you chose.
3. Today is unmistakably not a drop target — state the styling.
4. Drag-over is still obvious, and still distinct from today.
5. Cross-day drop reschedules and keeps the crew; within-day reorder still
   persists `route_order` per crew 1..n.
6. Month, desktop matrix, day and agenda views: zero diff lines.

## Test data

`Terra Verde Test Co` — `600d02fa-fae2-440b-99ab-42e96997da91`. Fabricated; seed
and delete freely. `Peanutz L&L` — `d236eba1-8e84-4dae-a40d-ef2651cbbb9c` — is a
**real paying customer. Never write to it.**
