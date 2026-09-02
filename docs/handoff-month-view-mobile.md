# HANDOFF — the month calendar is unreadable on a phone. Fix the cell.

**For: the local model (ollama, `gpt-oss:20b`). Written 2026-09-01 by Claude Opus 5.**

---

## Scope — ONE block in ONE file. Nothing else.

You are replacing **exactly one JSX block**: the month grid in
`src/components/LawnCalendarBoard.tsx`, currently lines **796–841** — the
`<div className="grid grid-cols-7 gap-1">` that maps `month.cells`, up to and
including its closing `</div>`.

**Do not touch anything else in that file.** Not the week view, not the day view,
not the agenda, not the DnD setup, not the imports. Do not create files. Do not
change any other file.

## The problem

The grid is `grid-cols-7` with no minimum width and no scroll container. On a
375px phone that is ~48px per cell, and each cell tries to render chips carrying
a customer name, a crew colour and a lateness label at `text-[10px]`. You get
about four characters before truncation. The user's words: *"its all squished and
nothing can be read."*

The week view below already handles this differently (`overflow-x-auto` +
`min-w-[900px]`). **Do not copy that.** Sideways-scrolling a month grid is worse
than the disease.

## The fix

**A month cell on a phone shows DENSITY, not detail.** Detail is what the Day and
Agenda views are for.

- **Below `lg`:** render the day number, then up to 4 small status **dots** (one
  per visit, coloured by `colorFor(v).dot`), then a `+N` count if there are more
  than 4. **No chips.**
- **At `lg` and above:** behaviour is unchanged from today — chips exactly as
  they render now, including the existing `+N more`.

Use Tailwind responsive classes (`hidden lg:block`, `lg:hidden`) so both branches
render in the DOM and the breakpoint decides. Do not use JS window-width checks —
`react-hooks/set-state-in-effect` is enforced in this repo and a resize listener
will not pass review.

## What must NOT break

- **`DroppableCell` stays the cell wrapper**, with the same `id={dateStr}` and the
  same `min-h-[64px] lg:min-h-[110px] ... ` classes it has now. It is the drop
  target for drag-to-assign — if you replace it with a plain `div`, dragging a
  visit onto a day silently stops working.
- **`DraggableChip` must still render for the desktop branch**, with the same
  props it has now (`today`, `visit`, `crewName`, `color`, `extraClassName`,
  `onClick`). Keep `onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}`.
- The today highlight (`isToday` → `bg-blue-50 ring-1 ring-blue-300`) and the rain
  icon (`rainRiskSet.has(dateStr)` → `<CloudRain />`) both stay, on both branches.
- Blank cells (`dateStr === null`) keep rendering the same spacer div.

**Accepted tradeoff, do not try to preserve it:** dragging a chip on a phone goes
away, because the chips are hidden there. It was not usable at 48px anyway, and
assignment is done on desktop or in the Route Planner. Mention it in your report.

## Identifiers available in scope — use these, invent nothing

```
month.cells         string|null[]   the 42 day cells
filteredVisits      BoardVisit[]    already filtered; .due_date, .id, .recurring_schedule_id
todayIso            string          "YYYY-MM-DD"
rainRiskSet         Set<string>
colorFor(visit)     -> colour object; `.dot` is the dot class (used elsewhere in this file)
nameFor(visit)      -> crew name string
openSchedule        ((id) => void) | undefined
DroppableCell, DraggableChip, CloudRain
MAX_CHIPS_PER_CELL = 3, MAX_CHIPS_PER_CELL_DESKTOP = 6
```

## The exact current block you are replacing

```tsx
            <div className="grid grid-cols-7 gap-1">
              {month.cells.map((dateStr, i) => {
                if (dateStr === null) return <div key={`b-${i}`} className="min-h-[64px] lg:min-h-[110px]" />;
                const dayVisits = filteredVisits.filter((v) => v.due_date === dateStr);
                const isToday = dateStr === todayIso;
                const shown = dayVisits.slice(0, MAX_CHIPS_PER_CELL_DESKTOP);
                const mobileExtra = dayVisits.length - Math.min(dayVisits.length, MAX_CHIPS_PER_CELL);
                const desktopExtra = dayVisits.length - shown.length;
                return (
                  <DroppableCell
                    key={dateStr}
                    id={dateStr}
                    className={`min-h-[64px] lg:min-h-[110px] rounded-lg p-1 lg:p-1.5 flex flex-col gap-1 ${
                      isToday ? "bg-blue-50 ring-1 ring-blue-300" : "bg-white"
                    }`}
                  >
                    <span className="flex items-center justify-end gap-1 self-end leading-none">
                      {rainRiskSet.has(dateStr) && (
                        <CloudRain className="w-2.5 h-2.5 text-blue-400" aria-label="Rain risk" />
                      )}
                      <span
                        className={`text-[10px] lg:text-xs font-semibold ${
                          isToday ? "text-blue-700" : "text-gray-400"
                        }`}
                      >
                        {Number(dateStr.slice(-2))}
                      </span>
                    </span>
                    {shown.map((v, idx) => (
                      <DraggableChip
                        today={todayIso}
                        key={v.id}
                        visit={v}
                        crewName={nameFor(v)}
                        color={colorFor(v)}
                        extraClassName={idx >= MAX_CHIPS_PER_CELL ? "hidden lg:block" : ""}
                        onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                      />
                    ))}
                    {mobileExtra > 0 && <span className="text-[9px] text-gray-400 px-1 lg:hidden">+{mobileExtra} more</span>}
                    {desktopExtra > 0 && (
                      <span className="hidden lg:block text-[9px] text-gray-400 px-1">+{desktopExtra} more</span>
                    )}
                  </DroppableCell>
                );
              })}
            </div>
```

Note `mobileExtra` becomes meaningless once mobile shows dots — replace it with a
dot-count overflow instead. `desktopExtra` keeps its current meaning.

Keep the existing indentation (12 spaces on the opening `<div>`).

## Output format — obey exactly

Emit the replacement block and nothing else. No prose, no markdown fences, no
backticks around it. Use these delimiter lines verbatim:

```
===BLOCK===
<the complete replacement JSX, correctly indented>
===END===
```

## Checks I will run on your output

- `npx tsc --noEmit` exits 0.
- `npx eslint src/components/LawnCalendarBoard.tsx` gains no new error.
- `DroppableCell` still wraps every cell; `DraggableChip` still receives all six props.
