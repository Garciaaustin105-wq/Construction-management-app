# HANDOFF — Time clock: mis-taps, forgotten starts, forgotten ends

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` (after `feat/shift-rules` merges). Work on `feat/time-clock-fixes`.**

---

## Lane boundaries

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Migrations, crons, libs | Claude | `src/lib/*.ts`, `src/app/api/**`, migrations |
| **Time clock UI — YOURS** | **you** | `src/app/crew/time/page.tsx`, `src/app/admin/reports/weekly/page.tsx`, `src/app/office/**` |

**Do not create migrations — they are applied.** Do not push. Commit and stop.

---

## The three problems, all real in live data

- **The shortest shift on record is 18 seconds.** Someone tapped Start then End, and it became a payroll row.
- **One entry stayed open for 174 hours** — seven days. A forgotten clock-out.
- **A crew member who forgets to press Start** has no way to record the hours they actually worked.

## What already exists (do not rebuild)

**`src/lib/shiftRules.ts`** — use it, do not re-derive: `isTriviallyShort`, `validateBackdate`, `isBackdated`, `describeShiftFlags`, `formatDuration`, plus `TRIVIAL_SHIFT_MS` and `MAX_BACKDATE_MS`.

**`time_entries.clock_in_backdated`** and **`time_entries.auto_closed`** — booleans set by the database. `clock_in_backdated` is stamped by a trigger, not by the client, so an entry cannot be backdated without being labelled.

**Server-side limits already enforced** (`guard_time_entry_clock_in`): no start in the future, none more than 16 hours back. Your validation should stop the user before they reach these, but they are the real rule.

**The nightly cron closes shifts left open** past 12 hours, at `clock_in + 12h` (not `now()`), flagged `auto_closed`.

## What to build

### 1. Discard-or-record on a short shift — `src/app/crew/time/page.tsx`

When End shift is pressed and the shift is `isTriviallyShort`, ask instead of saving: show how long it actually was (`formatDuration`) and offer **Discard** or **Record it anyway**.

- Discard deletes the entry. `removeEntry` already exists in this file, and RLS already permits a crew member to delete their own unapproved entry.
- **Never auto-discard.** A genuinely short visit is real — someone pops back for ten minutes to redo an edge — and silently deleting recorded time is how a time clock loses trust. Ask.

### 2. Backdated start — same page

At clock-in, offer "I started earlier" with a time picker for today.

- Validate with `validateBackdate` and show its `message`. The user should get a sentence, never a Postgres error.
- Default to now. Backdating must be a deliberate extra step, not the path of least resistance.
- Say plainly that a typed start time is reviewed by the office. Do not hide it.

### 3. Show the flags wherever hours are reviewed

`describeShiftFlags` returns the phrases. Show them on the shift card, in Recent Shifts, and in the weekly report.

**The wording is load-bearing.** These describe a reduced claim about the data, never a judgement about the person — "Ended automatically — the crew did not clock out" is a fact about the sweep, not an accusation. Do not editorialise them into "forgot to" or "failed to".

### 4. Office view: who has not clocked in today

Somewhere on the office side (`/office` is fine), list crew members with **no time entry today**. This is the only reliable way a forgotten clock-in gets caught the same day — the phone genuinely cannot detect it, because GPS only runs while clocked in, by design.

Show name, and last-seen-on-shift date if you can get it cheaply. One query, no polling.

## Constraints

- `npx tsc --noEmit` exits 0. `npx eslint src/` must not gain a new error — there are about 14 pre-existing ones being fixed separately; do not add to them and do not fix them here.
- `react-hooks/set-state-in-effect` is enforced. **No polling loops.**
- Lawn only where it is lawn-specific, gated on `isLawn()`. **Construction must be byte-identical** unless a change is explicitly for it — I verify by executing `buildNavItems` and `buildMobileNav` for all 8 roles in both variants and diffing. (The auto-close cron does cover both variants; that is deliberate and already done. Your UI work is the lawn time page.)
- Stage explicitly. `src/lib/turnstile.ts` holds another lane's uncommitted work; leave it.

## Verify, and report what you verified

**Never write to `Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) — a real paying customer.** Seed in `Terra Verde Test Co` (`600d02fa-fae2-440b-99ab-42e96997da91`), scope every statement by `organization_id` including cleanup, and delete what you seed.

Confirm specifically:

1. Ending a 20-second shift offers Discard, and Discard actually removes the row.
2. "Record it anyway" keeps it.
3. A backdated start is accepted, and the saved row comes back with `clock_in_backdated = true` **without the client setting it**.
4. A start 20 hours back is refused with a readable sentence, not an error code.
5. The office list shows a crew member with no entry today.
