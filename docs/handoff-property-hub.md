# HANDOFF — The property hub. One page, no navigation.

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main`. Work on `feat/property-hub`. Commit, do not push.**

---

## Lane boundaries

| Lane | Owner | Files |
|---|---|---|
| Migrations, RLS, money, accounting sync | Claude | `src/lib/lawnBilling.ts`, `src/lib/accounting/**`, `src/app/api/**`, all `.sql` |
| Pure billing-review arithmetic | local model | `src/lib/billingReview.ts` |
| **The hub — YOURS** | **you** | `src/app/lawn/customers/page.tsx`, `src/components/PropertyHub.tsx` |

**Create no migrations. Write no SQL files. Touch no file under
`src/lib/accounting/` or `src/lib/lawnBilling.ts`.** If the hub needs a column
that does not exist, stop and say so — do not add it.

---

## The problem, in the user's words

> "very hard after the job was completed to find the completed jobs and which
> one it was" … "opening these we dont need to switch pages it should stay on
> the same page and just bring a pop up"

Today a property's history is scattered across `/lawn/jobs`, `/lawn/completed`,
`/lawn/photos`, `/lawn/overdue` and the calendar. Answering "when did we last
cut the Hendersons, and what did it look like" means four page loads and losing
your place each time.

## What to build

A **master–detail** page at `/lawn/customers`.

- **Left rail:** every customer, searchable by name, showing property count and
  a state hint (e.g. "2 properties · 1 overdue"). The rail **persists** — it is
  never replaced by the detail view on desktop.
- **Right pane:** the selected customer. Selecting one **must not navigate.**
  No `router.push`, no `<Link>`, no URL change, no server round trip. All data
  for every customer is fetched once by the server component and handed to the
  client component as props.
- **Tabs inside the right pane:** `Visits · Photos · Schedule · Details`.
  Switching tabs is local state. Same rule: no navigation.
- **Mobile:** the rail is the page; tapping a customer slides the detail in over
  it, with a back control that returns to the rail. Do not render both at once
  on a narrow screen.

This is **read-only**. No editing, no status changes, no writes of any kind.
Where editing is genuinely needed, link out to the existing page — that is the
one legitimate reason to navigate, exactly as `CompletedVisitsList` does today.

## Reuse, don't reinvent

Read these first; they are the house patterns and I want the hub to match them:

- `src/components/CompletedVisitsList.tsx` — **the reference implementation** for
  the modal: bottom sheet on mobile, centred dialog on desktop, Escape to close,
  backdrop click to close, `document.body` scroll lock, `role="dialog"` +
  `aria-modal`. Copy this behaviour; do not invent a second modal idiom.
- `src/components/PhotoLightbox.tsx` — use as-is for every photo grid. It already
  mints signed URLs, enlarges on click, and carries the download button.
- `src/components/LawnPhotoGallery.tsx` — the before/after column layout. The
  Photos tab should look like this, scoped to one customer.
- `src/lib/orgDate.ts` — `todayInZone`, `lateLabel`, `formatDueStamp`,
  `daysLate`. **Never `toISOString()` for "today".** That bug shifted the whole
  app by a day every evening after 20:00 Eastern and is already fixed; do not
  reintroduce it. `page.tsx` resolves the org timezone — thread it through.

## The tabs

**Visits** — every visit for this customer across all their properties, newest
first. Show: property name, date, status, and for completed ones the duration
with its source (`measured` vs `start→done` — these are different claims and the
label must say which). Overdue visits state **how late** via `lateLabel`, and
sort to the top. Clicking a visit opens the **modal**, not a page.

**Photos** — before/after grouped by visit, same treatment as
`LawnPhotoGallery`, filtered to this customer.

**Schedule** — the customer's recurring schedules. Columns: property, service
type, interval, **last completed visit date**, **next due date**, price per
visit. Those last three are the point — an operator uses them to confirm a
schedule is actually firing. Derive last/next from the visits you already
fetched; do not add a column to the database.

**Details** — name, contact, addresses, properties. Read-only. Link to the
existing customer edit page.

## Data

One server component fetch in `page.tsx`, everything handed down as props.
Follow the shape used by `src/app/lawn/completed/page.tsx` — in particular the
**photos-in-one-query** trick there (`.in("visit_id", ids)` then group in JS).
Do not do a per-customer or per-visit round trip.

**Two traps, both of which have already bitten this codebase:**

1. **Do not use `!inner` on the customer embed.** Several of Terra Verde's
   overdue visits have **no customer at all**; an inner join silently drops
   them. A property with no customer must still be reachable — put those under
   a clearly-labelled "No customer assigned" entry at the bottom of the rail,
   not nowhere.
2. **Filter lawn jobs by `type = "lawn"`.** The construction org owns a lawn
   job and RLS alone will not keep the two apps' lists apart.

RLS scopes every query to the caller's org. **Do not write manual
`organization_id` filters.**

Gate the route the way `/lawn/completed` does: `getMe()`, `isLawn()`, and
`FIELD` or `MANAGEMENT`. Crews have a legitimate reason to look up a property.

## Navigation

Add one nav entry for the hub. **Lawn only — construction must be
byte-identical.** Verify by executing `buildNavItems` and `buildMobileNav` for
all 8 roles in both variants and diffing against a baseline built from
`git show main:` — **build the baseline from git, not from your working tree.**
A previous lane produced a false zero-diff by comparing a branch against a copy
of itself.

## Constraints

- `npx tsc --noEmit` exits 0.
- `npx eslint src/` gains no new error.
- `react-hooks/set-state-in-effect` is enforced. **No polling loops.** If you
  must set state from an effect, defer with `queueMicrotask` — that is the
  pattern already used in this repo.
- Every interactive element reachable and operable by keyboard; the modal traps
  focus and restores it on close.
- Wide content scrolls inside its own container; the page body never scrolls
  sideways.
- Stage explicitly by path. Other lanes have uncommitted work in the tree —
  do not `git add -A`, and do not stash.

## Test data

`Terra Verde Test Co` — `600d02fa-fae2-440b-99ab-42e96997da91`. The user's own
sandbox; **every row in it is fabricated. Seed and delete freely.** It currently
has 8 genuinely overdue visits, 4–7 days late, and some visits with no customer
— which is exactly the case trap #1 describes, so test against it.

`Peanutz L&L` — `d236eba1-8e84-4dae-a40d-ef2651cbbb9c`. **A real paying
customer. Never write to it.** Read-only if you touch it at all.

## Report back, with evidence

1. Selecting a customer changes no URL and issues no network request. Say how
   you confirmed it.
2. A property with no customer is still reachable.
3. An overdue visit states how late and sorts above the rest.
4. The Schedule tab shows last-completed and next-due.
5. Mobile shows rail *or* detail, never both; back returns to the rail.
6. Construction nav diff is empty, and say which baseline you diffed against.
7. Nothing you wrote derives "today" from `toISOString()`.
