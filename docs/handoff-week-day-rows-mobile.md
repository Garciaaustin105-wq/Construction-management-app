# HANDOFF — the week view becomes a scrollable day list on a phone

**For: GLM 5.3 Flash. Written 2026-09-01 by Claude Opus 5.**
**Base branch: `main`. Work on `feat/week-day-rows`. Commit, do not push.**

---

## Scope — ONE view in ONE file

`src/components/LawnCalendarBoard.tsx`, the **week view only** (the
`{view === "week" && week && (...)}` block, currently ~line 848 onward).

**Do not touch** the month view, the day view, the agenda view, `handleDragEnd`,
the sensors, the bulk-move path, or any other file. No migrations, no SQL.

---

## Why

The user, on a phone in portrait: *"its all squished and nothing can be read"*,
then *"i can see long and skinny boxes with no names showing"*, then *"lets make
this into weekly schedule and break down the days into a line that i can just
scroll down instead of showing it all."*

Seven columns on a 375px screen is ~45px per cell. **No amount of cell styling
fits a customer name in 45px** — I tried density (coloured bars) and the correct
complaint was that the names were gone.

## The researched pattern — build to this, not to my earlier attempts

Three findings from mobile-calendar UX guidance (sources at the end), because
they explain *why* this shape and should inform the details you choose:

1. **Agenda/list is the primary mode on a phone; grids are not.** "Mobile
   calendar design typically favors agenda view (chronological list) over grid
   view as the primary mode — grids become too small to be actionable below
   360px width." Our cells are ~45px. This is not a styling problem to solve; it
   is a layout that does not belong on a phone.

2. **The right architecture is LAYERED, not one view stretched.** "A compressed
   monthly overview for navigation context, a detailed week or day view for
   active planning, and clear visual differentiation between today, selected
   dates, and event-occupied days." **This lane builds the middle layer** — the
   week as the active-planning view. The month becomes navigation context later
   (see "Not in this lane"), which is why you must not touch it here.

3. **A deliberate mobile layout, not smaller text.** "Responsive behavior usually
   needs a deliberate mobile fallback, not just smaller text." Do not attempt to
   shrink the matrix to fit. Build the day list as its own layout and let the
   breakpoint choose between them.

The practical consequence for your work: **full width is the feature.** A day row
exists so a customer name has room. Anything that eats horizontal space —
indentation, avatars, a crew column, side-by-side layout — works against the one
thing this change is for. Keep the row's content left-aligned and let the chip
have the width.

Point 2 also tells you what "clear visual differentiation" means concretely:
today, and days that have work, must read differently from empty days at a
glance — see the day row spec below.

## What to build

Inside the week view, **two layouts of the same data**:

- **Below `lg`** — a vertical list of **7 day rows**, one per `week.days` entry,
  scrolled downward. This is the new part.
- **`lg` and above** — the existing crew × day matrix, **completely unchanged**,
  including its `overflow-x-auto` + `min-w-[900px]` wrapper.

Use Tailwind (`lg:hidden` / `hidden lg:block`). **No JS viewport checks** —
`react-hooks/set-state-in-effect` is enforced here and a resize listener will not
pass lint.

## The day row

Each row, for one `dateStr` from `week.days`:

- **Header line:** weekday + date (e.g. "Mon 15"), the `CloudRain` icon when
  `rainRiskSet.has(dateStr)`, and a count of that day's visits. Today
  (`dateStr === todayIso`) is visually distinct — the month view uses
  `bg-blue-50 ring-1 ring-blue-300`; match that language.
- **Body:** every visit for that day, **all crews together**, as full-width
  `DraggableChip`s. Names are the entire point of this change — do not truncate
  them harder than the chip already does, and do not pass `dense`.
- **Empty day:** a quiet one-line placeholder. Do not collapse the row away —
  an empty day is a valid drop target and hiding it makes rescheduling harder.

Order visits within a day by `scheduled_window_start` (nulls last), matching the
day view's existing convention.

## Drag — the important detail

**Wrap each day row in a `DroppableCell` whose id is the BARE `dateStr`**, not
`${dateStr}::${crewId}`.

I checked `handleDragEnd`: it branches on whether the cell id contains `::`.
With `::` it sets date **and** crew; without it, it sets `newDate = cellId` and
**leaves the crew alone**. A day row spans all crews, so the bare id is exactly
right — dropping onto a row reschedules the visit to that day and keeps whoever
was assigned. **No change to `handleDragEnd` is needed or wanted.**

The desktop matrix keeps its `${date}::${crewId}` ids. Both forms already work.

## Rules

- Read `src/components/CompletedVisitsList.tsx` and the existing month/day views
  first and match the house style — same comment voice, same Tailwind idiom.
- `DraggableChip` keeps all its current props. Do not add new ones.
- Dates via `@/lib/orgDate` where a helper exists. **Never `toISOString()` for
  "today"** — that bug shifted the whole app by a day every evening after 20:00
  Eastern and is already fixed. `todayIso` is passed in; use it.
- Read-only with respect to data: no `.insert`, `.update`, `.delete` in your new
  code. The existing drag/status writes stay exactly as they are.
- Keyboard reachable; the row header should not be a click target that competes
  with the chips.

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (13 pre-existing warnings are fine).

## Report back, with evidence

1. Below `lg` the week is 7 stacked day rows; at `lg`+ the crew matrix is
   byte-identical to before. Say how you confirmed the desktop half is unchanged.
2. A customer **name is visible** on a phone-width row. This is the whole point.
3. Dropping a chip on a day row changes its date and **keeps its crew** — and you
   did not modify `handleDragEnd`.
4. An empty day still renders and still accepts a drop.
5. Today is visually distinct.
6. Nothing derives "today" from `toISOString()`.

## Not in this lane

The **month** view is still cramped on a phone. It becomes the *navigation
context* layer from finding 2 — a compressed overview with dots for density and
tap-a-day-to-jump, not a working view. Dots are correct THERE, where the job is
"which days have work"; they were wrong in a working view, where the job is
"whose lawn is this". That is a separate change; do not attempt it here.

## Sources

- Calendar design best practices — https://bootcamp.uxdesign.cc/best-practices-for-calendar-design-fix-ux-dc57b62d9bb7
- Calendar UI examples and UX tips — https://www.eleken.co/blog-posts/calendar-ui
- Calendar view pattern — https://uxpatterns.dev/patterns/data-display/calendar
