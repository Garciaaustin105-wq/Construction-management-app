# HANDOFF — Safe job delete + archive

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` @ `1479c12` or later. Work on `feat/job-archive`.**

---

## Lane boundaries

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Cluster geofence, libs, migrations | Claude | `src/lib/*.ts`, migrations |
| Readiness banner | GLM (other branch) | `src/components/FieldReadinessBanner.tsx`, `src/app/lawn/page.tsx` |
| **Job delete + archive — YOURS** | **you** | `src/components/DeleteJobButton.tsx`, `src/app/lawn/jobs/page.tsx`, `src/app/jobs/[id]/page.tsx` |

**Do not create migrations — they are applied.** Do not push. Commit to
`feat/job-archive` and stop.

---

## There is a live hazard here, and it ships today

`src/components/DeleteJobButton.tsx` is mounted on `src/app/jobs/[id]/page.tsx`
(construction). It currently:

1. **Permanently deletes photo and blueprint FILES from storage**, then
2. deletes photos / blueprints / rfis / job_views rows, then
3. runs `supabase.from("jobs").delete()`.

Step 3 **cascades to 21 tables**, including `invoices`, `receipts`,
`time_entries`, `chemical_applications`, `estimates`, `lawn_visits` and
`recurring_schedules`. There is an RLS policy (`office_delete_jobs`) permitting
it, so it genuinely works.

On the live construction org, the job **"John Murnane"** has 1 invoice, 1
estimate, 5 photos and 2 time entries. One click currently destroys all of it,
files included, with no way back. `chemical_applications` are pesticide
application records with legal retention requirements — the compliance module
exists to keep them.

Fixing that is the first half of this task. Adding delete/archive to the lawn
jobs list is the second.

## What is already built for you (applied, do not re-create)

**`jobs.archived_at timestamptz`** — nullable. When set, the job is hidden from
active lists but fully retained. Deliberately NOT a new `status` value: `status`
is lifecycle (`scheduled` → `in_progress` → `on_hold` → `completed`) and
archiving is visibility. Folding them together would mean archiving a completed
job erased the fact that it was completed. Index `idx_jobs_org_archived` covers
the `archived_at is null` list query.

**`delete_job_if_empty(p_job_id uuid) returns jsonb`** — the ONLY delete path
you may use.

```ts
const { data, error } = await supabase.rpc("delete_job_if_empty", { p_job_id: jobId });
// data: { deleted: true, total: 0 }
//   or: { deleted: false, total: 17, blocked_by: { invoices: 1, photos: 5, time_entries: 2, ... } }
```

- Office/admin only, enforced server-side; raises for anyone else.
- Counts history across 18 tables. `lawn_jobs` (a 1:1 extension of the job) and
  `job_views` (analytics) are deliberately excluded — counting either would make
  almost every job permanently undeletable.
- Returns `deleted: false` **with the reasons**, so your UI can name what is in
  the way instead of just failing.

## What to build

### 1. Rewrite `DeleteJobButton`

- **Delete `supabase.from("jobs").delete()` entirely. Never call it again.**
- **Do not delete storage files up front.** The current code removes photos and
  blueprints from storage BEFORE it knows whether the job can be deleted, so a
  failed delete still loses the files permanently. Only clean up storage after
  the RPC reports `deleted: true`.
- Call the RPC. On `deleted: false`, do not present it as an error — present the
  `blocked_by` counts in plain language ("This project has 1 invoice, 5 photos
  and 2 time entries") and offer **Archive** as the action instead.
- Keep the two-step confirm.

### 2. Archive

Archiving is an ordinary update: `.update({ archived_at: new Date().toISOString() })`
(RLS policy `Office update jobs` already allows office/PM). Un-archive sets it
back to `null`. Offer un-archive wherever archived jobs are listed — an archive
you cannot reverse is just a slower delete.

### 3. Lawn jobs list — `src/app/lawn/jobs/page.tsx`

This is the page the user actually asked about.

- Default the list to `archived_at is null`.
- Add an **Archived** option to the existing status filter (it currently has
  all / active / paused) so archived jobs remain reachable.
- Per-row actions: **Archive** always; **Delete** only as described above.
- If you show a Delete affordance on a job with history, it must explain why it
  is unavailable rather than silently failing on click.

## Constraints

- `npx tsc --noEmit` exits 0; `npx eslint <changed files>` clean.
- `react-hooks/set-state-in-effect` enforced — derive, never setState in an effect body.
- No polling loops.
- `src/app/jobs/[id]/page.tsx` is the CONSTRUCTION detail page (`/jobs` is
  proxy-blocked on lawn). `src/app/lawn/jobs/page.tsx` is lawn-only. Both
  variants must keep working — this is one of the few tasks that legitimately
  touches both, so be deliberate about which change lands where.
- Stage explicitly. `src/lib/turnstile.ts` is another lane's work; leave it.

## Verify, and report what you verified

**Never write to `Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) — a real
paying customer.** Use `Terra Verde Test Co`
(`600d02fa-fae2-440b-99ab-42e96997da91`), scope every statement by
`organization_id` including cleanup, and delete what you seed.

Confirm specifically:
1. Deleting a job that HAS history is refused, names what blocked it, and
   **leaves its storage files intact**.
2. Deleting a genuinely empty job succeeds.
3. Archiving hides a job from the default list and un-archiving brings it back.
4. A crew-role user cannot delete (the RPC raises).
