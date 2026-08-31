# HANDOFF — Office approval queue + settlement settings

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` @ `64dac74` or later. Work on `feat/settlement-approval`.**

---

## Lane boundaries

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Settlement cron + geofence changes | Claude | `src/lib/*.ts`, `src/app/api/**`, migrations, `vercel.json` |
| **Approval queue + settings — YOURS** | **you** | `src/app/lawn/approvals/**` (new), `src/app/lawn/notifications/page.tsx`, `src/lib/navItems.ts` |

**Do not create migrations — applied.** Do not push. Commit to
`feat/settlement-approval` and stop.

---

## What this is

When a crew finishes, the customer gets "your yard is done". Sending that while
the mower is still running is the worst thing this product can do, so four gates
must pass first:

1 + 2. **The whole crew left, and stayed gone.** One check, not two:
`on_site_last_at` is a high-water mark any crew phone pushes forward while any
of them is on the property, so it stops advancing when the last person leaves.
3. **On site long enough to be real work** (default 4 minutes).
4. **The office approves** — default ON, and this is your lane.

Gates 1–3 are already enforced in the database. Your job is gate 4: the queue
where a human says yes, and the settings that control the whole thing.

## What exists (do not rebuild)

**`settleable_visits(p_org uuid default null)`** — returns visits that passed
gates 1–3:

```
visit_id, organization_id, completion_mode, on_site_first_at,
on_site_last_at, on_site_minutes, already_queued
```

**`lawn_visits.awaiting_approval_since`** — timestamp; non-null means it is
sitting in your queue.

**`notification_settings`** now carries `completion_mode`
(`auto` | `office_approval`, default `office_approval`),
`settlement_grace_minutes` (default 30, allowed 5–480), and
`min_on_site_minutes` (default 4, allowed 1–120). The check constraints will
reject out-of-range values — validate in the UI so the user gets a sentence
rather than a Postgres error.

**`src/lib/settlement.ts`** — mirrors the gate rules for DISPLAY. Use
`assessSettlement` / `describeSettlement` for wording like "Settles in 12
minutes". **The database is authoritative**; this is for showing state, never
for deciding it.

## What to build

### 1. Approval queue — `src/app/lawn/approvals/`

Office/admin only, gated like `/lawn/crews` (`getMe` → `isLawn()` →
`isOfficeLike`). List visits awaiting approval: property, customer, date,
measured on-site minutes, how many phones were on site
(`on_site_user_ids.length`).

Two actions per row:

- **Approve** → `POST /api/lawn/visits/[id]/status` with `{ status: "done" }`.
  **Use that route. Do not update `lawn_visits` directly** — the route is what
  sends the customer email and the review request, and a direct update silently
  skips both. This mistake has been made in this codebase before.
- **Not yet** → clear `awaiting_approval_since` back to null, leaving the visit
  pending. It will re-queue if it still qualifies.

Offer **Approve all** only if you also show what is being approved. A bulk
button that emails eleven customers without listing them is not a feature.

### 2. Settings — `src/app/lawn/notifications/page.tsx`

Add the three controls. The copy matters more than the widgets:

- **Completion mode.** Explain the actual difference: "Send automatically" vs
  "Hold for my approval". Do not describe approval as a delay to be switched
  off — for many operators it is the reason they would trust this at all.
- **Grace period.** Say what it is for: how long after the crew leaves before
  the visit is treated as finished. Mention that going back to a property
  restarts it.
- **Minimum on-site time.** Say what it prevents: a visit too brief to be real
  work never tells a customer their lawn is done.

### 3. Nav

Add Approvals to the lawn office/admin block in `src/lib/navItems.ts` and to the
Office hub aliases. **Run `buildMobileNav` for every role and check nothing is
orphaned** — that has nearly happened here before. A pending-count badge is
welcome if it costs no extra query beyond the one you already make.

## Constraints

- `npx tsc --noEmit` exits 0. `npx eslint src/` — **the whole tree** — must not
  gain any new error. There are ~14 pre-existing ones being fixed separately;
  do not add to them and do not fix them here.
- `react-hooks/set-state-in-effect` enforced. No polling loops.
- Lawn only, `isLawn()`. **Construction must be byte-identical** — I verify by
  executing `buildNavItems`/`buildMobileNav` for all 8 roles in both variants
  and diffing, so claiming it is not enough.
- RLS scopes everything. No manual `organization_id` filters.
- Stage explicitly. `src/lib/turnstile.ts` is another lane's work; leave it.

## Verify, and report what you verified

**Never write to `Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) — a real
paying customer, and this feature EMAILS CUSTOMERS. Approving one of their
visits would send mail to a real homeowner.** Seed only in `Terra Verde Test Co`
(`600d02fa-fae2-440b-99ab-42e96997da91`), scope every statement by
`organization_id` including cleanup, and delete what you seed.

To create a queue entry: set `on_site_first_at` to ~70 minutes ago,
`on_site_last_at` to ~45 minutes ago, and `awaiting_approval_since` to now on a
Terra Verde pending visit.

Confirm specifically:
1. The queue lists it, with the right measured minutes.
2. "Not yet" clears it from the queue without completing the visit.
3. The settings reject an out-of-range grace period with a readable message.
4. **A crew-role user cannot reach `/lawn/approvals`.**
