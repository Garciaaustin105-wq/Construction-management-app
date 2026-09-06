# HANDOFF — mouse drag is dead on touchscreen laptops

**For: GLM 5.3 Flash. Written 2026-09-04 by Claude Opus 5.**
**Base: `main`. Branch `fix/hybrid-mouse-drag`. Own worktree. Commit, do not push.**

---

## The regression

`5a09d54` correctly switched the sensor test from `pointer: coarse` to
`any-pointer: coarse` — a touchscreen laptop reports its *primary* pointer as
fine, so touch users were getting the instant-grab `PointerSensor` and a drag
followed their scrolling finger.

But both files still pick **exactly one** sensor:

```ts
const sensors = useSensors(isCoarse ? touchSensor : pointerSensor);
```

`any-pointer: coarse` is true for **any** touch input on the device. So a
touchscreen laptop or 2-in-1 now gets `TouchSensor` **only** — and `TouchSensor`
binds `touchstart`/`touchmove`, which a mouse never fires. **Mouse dragging is
dead on those devices.**

It does not show up in testing because it needs hardware with both: a phone is
fine, a non-touch desktop is fine.

## The fix

`RouteList`'s own comment explains why one-at-a-time was chosen — "this setup let
PointerSensor's distance constraint win on the initial touch slide." That is true
of `PointerSensor`, which handles mouse **and** touch. It is not true of
`MouseSensor`, which is mouse-only and **is exported by `@dnd-kit/core`**
(verified).

So stop choosing. Run both — disjoint event types, no conflict:

```ts
const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 6 } });
const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 25 } });
const sensors = useSensors(mouseSensor, touchSensor);
```

Mouse gets the instant 6px drag; touch keeps the 400ms hold; a hybrid device gets
both, correctly. Swap `PointerSensor` for `MouseSensor` in the imports.

**Keep the existing activation values.** 6px distance is what lets a plain tap
still open the schedule editor; 400ms / 25px is what stops a slow scroll grabbing
a chip. Neither is being revisited here.

## Both files

- `src/components/LawnCalendarBoard.tsx` — sensors around lines 683–700.
- `src/components/RouteList.tsx` — sensors around lines 246–259.

**`isCoarse` must stay in `RouteList`** — it also gates the drag scroll-lock
(around lines 272 and 280). Only the sensor composition changes. In
`LawnCalendarBoard`, if `isCoarse` ends up unused after the change, remove it
rather than leaving a lint warning.

## Do not touch

Month view, week day rows, desktop matrix, day view, agenda, `handleDragEnd`,
`handleDayRowDragEnd`, `route_order` persistence, `dayRowCollision`, or the
`touch-pan-y` classes. No migrations, no SQL, no new dependency.

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (13 pre-existing warnings are fine).

## Report back

1. Mouse drag works on a device reporting `any-pointer: coarse` — say how you
   simulated it (emulating touch on a desktop browser while dragging with the
   mouse is the cheap repro).
2. Touch hold-to-drag still needs 400ms and still ignores a slow scroll.
3. A plain tap still opens the schedule editor.
4. `RouteList`'s scroll-lock still engages on touch.
5. Zero diff lines outside the sensor blocks in the two files.

## Process

Work in your own worktree, not the shared checkout — two lanes there once let a
path-scoped `git stash` sweep up another lane's uncommitted edits.
