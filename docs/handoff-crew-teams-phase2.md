# HANDOFF — Crew teams + crew size on the shift (crew model, phase 2)

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` @ `1121e38` or later. Work on `feat/crew-teams`.**

> **STATUS: the migration `crew_teams_and_crew_size` is NOT yet applied.**
> Claude is waiting on the user to unblock it. Do not start writing queries
> against these tables until this line says APPLIED. Everything else in this
> doc is final.

---

## Lane boundaries — read this first

Three agents are working this phase in parallel. **Stay inside your lane.**

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Schema, migrations, review, all pushes | Claude | migrations only |
| Pure man-hours math | local model | `src/lib/manHours.ts` |
| **Crew teams UI + crew size — YOURS** | **you** | `src/app/lawn/crews/**`, `src/app/crew/time/page.tsx`, `src/lib/navItems.ts` |

**Do not create or edit any migration.** **Do not push.** Commit to
`feat/crew-teams` and stop — Claude pushes everything after review.

**Do not touch `src/lib/manHours.ts`.** It is being generated in parallel.

---

## Why this phase exists

Labour is priced in **man-hours**, not clock time. A 4-person crew on site for
20 minutes produced **1.33 man-hours, not 0.33**. Recording duration without
crew size under-prices every job by the size of the crew — a 4x error.

So: work is assigned to a **team**, and the lead confirms **how many people are
on the truck** at shift start. That single number is what makes every duration
convertible into a price. Nothing downstream works without it.

## Schema you are building against

| Table / column | Notes |
|---|---|
| `crew_teams` | `id, organization_id, name, lead_id -> crew_members(id), active, created_at` |
| `crew_team_members` | `id, organization_id, crew_team_id, crew_member_id, created_at`, unique on `(crew_team_id, crew_member_id)` |
| `lawn_visits.crew_team_id` | nullable FK. The per-person `crew_id` **stays** for solo operators — do not migrate or remove it |
| `time_entries.crew_size` | nullable `integer`, check `>= 1` |

**A crew member with no phone and no login is a `crew_members` row with
`user_id IS NULL`.** That already exists and is already handled. Do **not**
invent a second representation for them, and do not require a login to add
someone to a team.

RLS is done: same-org read, office-tier write, on both new tables. **Do not add
manual `.eq("organization_id", ...)` filters** — policy does the scoping.

## What to build

### 1. Crew teams management — `src/app/lawn/crews/`

Office/admin only. List teams, create a team, rename it, set its lead, add and
remove members, deactivate a team.

- Members are picked from existing `crew_members` in the org — including ones
  with a null `user_id`. Show those plainly (e.g. a "no app" chip); they are
  normal, not broken.
- The lead must be a member of the team. Enforce it in the UI.
- Deactivate rather than delete when a team has history.

### 2. Crew size at shift start — `src/app/crew/time/page.tsx`

When a crew lead clocks in, ask **"How many people on the truck today?"** and
write it to `time_entries.crew_size`.

- Default the number to the team's member count, but it MUST be editable — the
  whole point is that someone is out sick or a helper joined.
- Include people with no phone. The prompt should say so in words.
- Do not block clock-in on it. A refused or dismissed prompt clocks in with
  `crew_size` null; that is a measurement we lose, not a shift we refuse.
  **Never default it to 1 silently** — a wrong number is worse than a null,
  because null is visibly missing and 1 looks like an answer.

### 3. Nav

Add the crews page under the lawn Office hub in `src/lib/navItems.ts`.
**Run `buildMobileNav` and check the result** — a card was nearly orphaned on
mobile this way once already.

## Constraints (non-negotiable)

- **`npx tsc --noEmit` must exit 0 before you commit.**
- **`npx eslint <your changed files>` must be clean.** `react-hooks/set-state-in-effect`
  is enforced — never `setState` synchronously in an effect body; derive it.
- **No polling loops, no `useEffect` fetch loops.** This app had 10-second page
  loads from exactly that; the fix is recent and must not be undone.
- **Lawn variant only.** Gate on `isLawn()` from `@/lib/variant`. The
  construction build shares this code and must be unaffected — that mistake has
  been made in this repo before.
- **Stage explicitly. Never `git add -A`.** `src/lib/turnstile.ts` holds another
  lane's uncommitted work; leave it alone. `.local-ai-bundles/` and
  `.claude/worktrees/` are deliberately untracked.

## Verification before you hand back

**The production database has one live paying customer in it (`Peanutz L&L`).
Do not write to that org under any circumstances.** Use `Terra Verde Test Co`
(`600d02fa-fae2-440b-99ab-42e96997da91`) for any seeded data, and delete what
you seed.

Report what you verified, not that you finished. Specifically confirm:

1. A team can be created, a member with a **null `user_id`** added to it, and a
   lead set — and the lead selector only offers members of that team.
2. Clocking in writes an editable `crew_size`, and dismissing the prompt leaves
   it **null** rather than 1.
3. The construction build is untouched — `NEXT_PUBLIC_APP_VARIANT=construction`
   still builds and the crews page does not appear in its nav.
