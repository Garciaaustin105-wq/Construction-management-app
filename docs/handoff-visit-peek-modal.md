# HANDOFF — Peek at a visit from the calendar and the home Today card.

**For: GLM 5.3 Flash. Written 2026-09-01 by Claude Opus 5.**
**Base branch: `main`. Work on `feat/visit-peek`. Commit, do not push.**

---

## Lane boundaries — three lanes are live at once

| Lane | Owner | Files |
|---|---|---|
| **This one — YOURS** | **you** | `src/components/VisitPeekModal.tsx` (new), `src/app/lawn/page.tsx`, `src/components/LawnCalendarBoard.tsx` |
| `/lawn/overdue` → modal | a local model, **in flight right now** | `src/components/OverdueVisitsList.tsx`, `src/app/lawn/overdue/page.tsx` |
| Migrations, RLS, money | Claude | `src/lib/lawnBilling.ts`, `src/lib/accounting/**`, `src/app/api/**`, all `.sql` |

**Do not touch `/lawn/overdue` or anything under `src/app/lawn/overdue/`.**
Another model is rewriting those files as you work. I will reconcile that lane
onto your shared modal afterwards — you do not need to think about it.

Create no migrations. Write no SQL. Add no dependency.

---

## Why

Two places still leave the page to show a visit:

- `src/app/lawn/page.tsx:315` — the Today card links to `/lawn/visits/[id]?from=home`
- `src/components/LawnCalendarBoard.tsx:1049` — a chip links to `/lawn/visits/[id]?from=calendar`

The user's instruction:

> "opening these we dont need to switch pages it should stay on the same page
> and just bring a pop up"

A page navigation is a server render and a Vercel function invocation to show
information the page already has in memory. Opening a modal costs nothing.

## What to build

**One shared component, `src/components/VisitPeekModal.tsx`**, used by both call
sites. Not two modals — this is the third and fourth surface to need it, and a
fourth copy of the same dialog is how the codebase rots.

**Read `src/components/CompletedVisitsList.tsx` first.** Its `VisitModal` is the
reference implementation and already solves every hard part: bottom sheet on
mobile / centred dialog on desktop, Escape to close, backdrop click to close,
`stopPropagation` so inner clicks do not, `document.body` scroll lock restored
on unmount, `role="dialog"` + `aria-modal` + a labelled close button. Extract
that behaviour into `VisitPeekModal` rather than re-deriving it, and keep the
same comment voice.

Give it a props shape that both callers can satisfy from data they **already
have in memory**. Opening the modal must issue **no network request** — if you
find yourself needing a field neither caller holds, leave it out and say so in
your report rather than adding a fetch or widening a query.

## What it shows

Customer name as the primary label, job name secondary — **fall back to the job
name when there is no customer.** Several lawn visits genuinely have no customer
and they must not render blank. Then: the due date, how late it is if it is
late, status, service type, address, assigned crew or team, the scheduled
window if present, and notes.

Foot it with a link to `/lawn/visits/[id]?from=home` or `?from=calendar` — set
by the caller, since that is what the visit page's back button reads. That link
is the one legitimate navigation: editing still warrants a real page.

## The calendar is the risky half — read this twice

`LawnCalendarBoard.tsx` is 1147 lines and carries real behaviour that has
already shipped:

- **drag-to-assign** — dragging a chip onto a crew
- **bulk move** (`/api/lawn/visits/bulk-move`, day view)
- **inline status update** (`/api/lawn/visits/[id]/status`)

**Do not regress any of them.**

To be precise about what you are changing, because I checked: the **only** link
to a visit page in this file is the one at line ~1049, inside the **day-view
list** (`dayVisits.map(...)`). Month-view chips do not link to a visit page at
all — leave them alone. So you are converting one `<Link>` in a list, not
touching the draggable chips.

That said, the drag handlers live in the same component and share state. After
your change, verify by exercising them that assignment-by-drag, bulk move and
inline status update all still work, and say in your report how you confirmed
it. If your change does end up touching anything a drag handler reads, say so
explicitly rather than assuming it is fine.

## Rules

- **Dates come from `@/lib/orgDate`** — `todayInZone`, `lateLabel`, `daysLate`,
  `formatDueStamp`. **Never `toISOString()` for "today".** That bug shifted the
  whole app by a day every evening after 20:00 Eastern and is already fixed.
  Both pages already resolve the org timezone; thread it through.
- Read-only. No `.insert`, `.update`, `.delete`, `.upsert` in your new code. The
  calendar's existing status/move writes stay exactly as they are.
- RLS scopes every query. No manual `organization_id` filters.
- `react-hooks/set-state-in-effect` is enforced. No polling. Defer with
  `queueMicrotask` if you must set state from an effect.
- **Lawn only. Construction must be byte-identical.** You are not changing
  `navItems.ts`, so this should be free — but confirm you did not touch it.
- Keyboard reachable and closable; close button needs an accessible name.
- **Stage explicitly by path.** Two other lanes have uncommitted work in this
  tree. Do not `git add -A`, do not stash, do not touch
  `src/app/crew/photo/page.tsx` or `src/app/punch/[id]/page.tsx` — those hold a
  bug fix of mine that is not yet committed.

## Checks

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error (~13 pre-existing warnings are fine).

## Test data

`Terra Verde Test Co` — `600d02fa-fae2-440b-99ab-42e96997da91`. The user's own
sandbox; **every row is fabricated, seed and delete freely.** It has 8 genuinely
overdue visits 4–7 days late, and visits with no customer — exactly the
fallback case above.

`Peanutz L&L` — `d236eba1-8e84-4dae-a40d-ef2651cbbb9c`. **A real paying
customer. Never write to it.**

## Report back, with evidence

1. Both call sites open the modal and issue no network request. How did you confirm?
2. A visit with no customer renders with the job name, not blank.
3. Drag-to-assign still works — and say how you kept click and drag apart.
4. Bulk move and inline status update still work.
5. One modal component, used twice — not two.
6. Nothing derives "today" from `toISOString()`.
7. You did not touch `/lawn/overdue`, `navItems.ts`, or the two files named above.
