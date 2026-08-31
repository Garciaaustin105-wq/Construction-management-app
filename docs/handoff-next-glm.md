# HANDOFF — what's left on the time/clock work

**Written 2026-08-31 by Claude Opus 5. Base: `main` @ `48b8ea9`.**
**`main` is 4 commits AHEAD of origin and UNPUSHED. Do not push it.**

---

## State of play

Phases 1–4 are built and merged locally. Nothing is deployed.

| Done | Where |
|---|---|
| Shift clock (lawn clocks a whole day, `job_id` null) | `ad0fcb5` |
| Start button on My Route (visits finally get a duration) | `ad0fcb5` |
| Payroll grid, worker × week, drillable | `e4ba2d8` (yours) |
| Nav rename: **Clock in/out**, **Team** | `48b8ea9` |

Three migrations are live on prod: `time_entries_shift_clock`,
`time_entries_allow_shift_insert`, `time_entries_org_stamp_allows_shift`.
**Do not add migrations for the tasks below — none of them need one.**

---

## Task 1 — Account tab (the user asked for this; it is NOT yet designed)

The request: *"for account tab, lets add the billing tab to the account tab. also admin does too."*

The lawn admin sidebar currently ends with two separate tabs:

```
Admin    /admin/users
Billing  /admin/billing
```

The user wants those folded into one **Account** tab.

**Read this before you build it — there is a real conflict.**
`/account` is deliberately PERSONAL, not org-level. Its own header comment says
so: it is open to ANY authenticated role (a crew member or customer uses it to
set up MFA on their own login), and it is explicitly contrasted with `/manage`,
which is the org-level admin surface.

So you must NOT simply add billing + users to `/account`. Either:
- crew and customers would see org billing, or
- you gate the page and crew lose access to their own MFA.

Both are worse than today.

**Recommended shape** (confirm with the user before writing much):
`/manage` already IS this hub — it has cards for `/account`, `/admin/billing`,
`/admin/users`, `/admin/orgs`, and it is `OFFICE_LIKE`-gated with
`showBilling = role === "office" || role === "admin"`. On mobile it is already
the "Manage" tab. So the smallest correct change is:

1. On the **desktop** sidebar, drop the separate `Admin` and `Billing` entries
   and add ONE entry → `/manage`, labelled **Account**.
2. Retitle the `/manage` page to **Account** so the nav and the page agree.
3. Leave `/account` (personal/MFA) exactly as it is, linked as a card from that
   hub — which it already is.

That gives the user one Account tab containing billing + users + their own
login, with the existing role gates intact and no new page.

Files: `src/lib/navItems.ts`, `src/app/manage/page.tsx`. Nothing else.

## Task 2 — Browser verification (nobody has done this)

**No human or agent has opened any of this in a browser.** Not the shift clock,
not the Start button, not your grid. tsc/eslint/build pass and the data layer is
verified under RLS, but every UI claim is unverified.

If you can drive a browser, log in on `localhost:3000` (dev server, lawn
variant) as **`jane` (crew, Terra Verde Test Co)** for the crew flow and
**`Lawn Test Admin`** for the office flow, and check:

- `/crew/time` — no job picker on lawn, button says "Start shift", the location
  disclosure renders, and clocking in writes a row with `job_id IS NULL`
- `/lawn/my-route` — the **Start** button appears, then the "On site 12m" chip,
  then Mark done. This is the one that proves a visit gets a duration.
- `/admin/reports/weekly` — a 30-day range renders your week grid; a ≤14-day
  range still renders the original day grid; the job filter is hidden on lawn
- `/lawn/track` — map mounts and the roster renders
- Both themes, and 375px width (sticky first column + horizontal scroll)

Note `Austin Garcia` is **super_admin**, which has NO Clock tab and is bounced
from `/crew/time` by the page gate. That is correct behaviour, not a bug — do
not "fix" it.

## Task 3 — Optional, only if you have room

- **`/office` hub** still lists construction-only cards (`/daily-logs`,
  `/punch`, `/receipts`, `/photos`, `/change-orders`, `/submittals`) that the
  lawn proxy redirects away. Dead links on the lawn variant.
- **payrollWeeks.ts** — you flagged `weekStart()` as UTC-unsafe. It was already
  fixed before your branch; the committed file has zero `toISOString()` calls.
  No action needed, noted so you don't re-report it.

---

## Rules

- `npx tsc --noEmit` exit 0 and `npx eslint <changed files>` clean before commit.
- `react-hooks/set-state-in-effect` is enforced — derive state, never setState in
  an effect body.
- No polling, no `useEffect` fetch. This app had 10s page loads from exactly that.
- Stage explicitly, never `git add -A`. `src/lib/turnstile.ts` has another lane's
  uncommitted work in the tree — **leave it alone**.
- Branch from `main`, commit to `feat/account-tab`, do not push `main`.
- Report what you verified, not just that you finished.
