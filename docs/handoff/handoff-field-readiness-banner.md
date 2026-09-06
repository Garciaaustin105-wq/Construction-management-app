# HANDOFF — "Will today actually work?" banner

**For: GLM 5.3 Flash. Written 2026-08-31 by Claude Opus 5.**
**Base branch: `main` (after `feat/field-readiness` merges). Work on `feat/readiness-banner`.**

---

## Lane boundaries

| Lane | Owner | Files — do NOT touch outside your row |
|---|---|---|
| Cluster geofence, libs, migrations | Claude | `src/lib/*.ts`, migrations |
| **Readiness banner — YOURS** | **you** | `src/components/FieldReadinessBanner.tsx` (new), `src/app/lawn/page.tsx` |

Work in the main checkout. **Do not create migrations. Do not push.** Commit to
`feat/readiness-banner` and stop.

---

## The problem, from a real customer

A lawn org runs in one of two modes:

- **SOLO** — no crew member has a login. The owner IS the field worker, and a
  visit with nobody assigned shows on their route automatically. Zero setup.
- **CREW** — at least one crew member has a login. The owner becomes a
  dispatcher and is redirected off My Route, and an unassigned visit now shows
  on **nobody's** route.

Hiring one person flips solo into crew **with no error message.** A live
customer sat in that state with 45 unassigned visits, an owner locked out of his
own route, a crew member staring at an empty list, and the geofence inert —
nothing in the product said why.

Two halves fix it. The database now fires a **one-shot notification** at the
moment of transition (type `crew_mode_started`, links to `/lawn/calendar`) —
that already works, you do not build it. **You build the other half:** the
persistent, always-current answer to "is today going to work".

## Use the library, do not re-derive the rules

```ts
import { assessReadiness, hasBlocking, type Readiness } from "@/lib/fieldReadiness";
```

You supply counts, it returns `{ mode, issues, autoStampableToday }`. Issues come
back **already ordered** blocking → warning → info. Do not re-sort, re-severity,
or re-interpret them — the whole point is that the banner and the actual field
behaviour can never disagree.

Counts you need for **today's** pending visits, scoped by RLS (no manual
`organization_id` filters):

| Field | Meaning |
|---|---|
| `crewMembersWithLogin` | `crew_members` where `user_id is not null` — **null-`user_id` members must not count** |
| `visitsToday` | pending visits due today |
| `unassignedToday` | of those, `crew_id is null AND crew_team_id is null` |
| `withPinToday` | of those, the job's `lawn_jobs.map_lat` is not null |
| `withSqftToday` | of those, `lawn_jobs.lot_sqft` is not null |

## THE RULE THAT MATTERS MOST

**Solo mode is not a problem and must never be presented as one.**

`assessReadiness` already omits the unassigned-visits issue in solo mode. Your UI
must not add it back with its own copy, badge, or "set up crew" prompt. Solo is a
correct, fully working configuration — most new orgs are one person with a truck,
and nagging them to fix something that works is how you teach people to ignore
banners.

- **Solo, nothing wrong** → one quiet line, or nothing. Not a call to action.
- **Crew, unassigned visits** → this is the real one. State plainly that N visits
  today are on nobody's route, and link to `/lawn/calendar` to assign them.
  Mention setting a default crew on the recurring schedule so it does not recur.
- **Missing pins** (warning) → those visits still work via the manual Start/Done
  buttons; say that, so it reads as reduced automation and not breakage.
- **Missing sqft** (info) → time is still recorded, only pricing is unavailable.
  **Never phrase any of these as the crew doing something wrong** — a gap here
  almost always means the office has not measured a property.

Show `autoStampableToday` as the honest headline, e.g. "3 of 7 visits today will
record arrival automatically". It is deliberately a conservative lower bound.

## Constraints

- `npx tsc --noEmit` exits 0; `npx eslint <changed files>` clean.
- `react-hooks/set-state-in-effect` enforced — derive, never setState in an effect body.
- **No polling.** One fetch on load. This app had 10-second page loads from
  exactly that and the fix is recent.
- Lawn only, gated on `isLawn()`. **Construction must be byte-identical** — I
  verify by executing `buildNavItems`/`buildMobileNav` for all 8 roles in both
  variants and diffing, so claiming it is not enough.
- Stage explicitly. `src/lib/turnstile.ts` is another lane's work; leave it.

## Verify, and report what you verified

**Never write to `Peanutz L&L` (`d236eba1-8e84-4dae-a40d-ef2651cbbb9c`) — real
paying customer.** Seed in `Terra Verde Test Co`
(`600d02fa-fae2-440b-99ab-42e96997da91`) and delete what you seed. Scope every
statement you run by `organization_id`, including the cleanup.

Confirm specifically:
1. A solo org with unassigned visits shows **no** call to action about them.
2. The same org, after adding one crew member with a login, shows the blocking
   message. (Terra Verde is solo right now — its one crew member has no login.)
3. The zero-visits day reads as "nothing scheduled", not as a misconfiguration.
