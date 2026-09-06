# HANDOFF → Opus: Desktop UI pass (lawn office)

**From**: Claude-direct · **Date**: 2026-09-06 · **Status**: design APPROVED, zero code shipped
**Spec**: [`handoff-ui-desktop-pass.md`](handoff-ui-desktop-pass.md) (the contract — read it first)
**Also read first**: [`handoff-ui-state-of-play.md`](handoff-ui-state-of-play.md) — its
folder conventions bind you too: `npx tsc --noEmit` exit 0 + `npx eslint` clean before
reporting, Tailwind + lucide-react only, and the estimator lanes' files are theirs
(your Phase 2 touches `PlantCatalogueManager.tsx` — that is Lane A's file, so coordinate
or rebase rather than surprise them).
**Visual reference**: `C:\Users\garci_9e2kg3l\Projects\design\lawn-nav-regroup.html` (v1) ·
`lawn-desktop-home-v2.html` (v2) — open in a browser; they are interactive.

## Why this pass exists

Austin's verdict: the lawn app on desktop "looks like a mobile app in a desktop view" — and
he does not want the app to look generic. Both are the same root cause: the app was built
mobile-first (~60 pages capped at `max-w-md` in `PageContainer`), the office sidebar grew to
26 flat tabs, and a phone-style `TopBar` + tap-row idioms carried onto desktop. A previous
UI lane already hand-rolled desktop tables into ~13 list pages (invoices, estimates, jobs,
customers, chemical managers, daily-logs, punch, change-orders, submittals, orgs, …), and
left `src/components/ui/DataTable.tsx` orphaned (built, never imported). This pass finishes
the job as one coherent release instead of 13 divergent one-offs.

## What was decided with the owner — do not re-litigate

1. **Grouped sidebar** (v1 mockup): lawn office/admin only. 26 tabs → 7 collapsible
   sections (Today / Money / Customers / Work / Chemical / Team / System) + Home pinned.
   Count pills: Overdue (red), Approvals (amber), Leads (amber). Dark-green sidebar shell
   with light content — approved, do not flip to light.
2. **Desktop density** (v2 mockup): in-flow page header replacing TopBar at `lg:`, 6-up KPI
   strip, real tables (tabular-nums, right-aligned money, loud status chips), quick-actions
   toolbar, and a per-user STANDARD/COMPACT density toggle.
3. **Status color language stays loud.** This is a deliberate lesson from Jobber's redesign
   backlash (they greyed out completed jobs and users revolted). `--success/--warning/
   --danger` chips must survive every migration untouched.
4. **Open questions with defaults** (owner may override later, one-line changes): AI admin →
   System; Email Preview → System; Scheduling → Today tab.

## The one hard rule

**Only `lg:`-and-up rendering changes. Mobile output stays byte-identical wherever
possible.** No route changes, no role-gate changes, no RLS, no new queries on pages that
already have them (Sidebar counts must reuse queries the /lawn KPI strip already runs —
feed them through the existing layout providers like the unread badge does). If a diff
changes what a phone shows, stop and ask before proceeding.

## Phase order (build exactly this order, verify between phases)

| Phase | Work | Notes |
|---|---|---|
| 1 | Density tokens (`--row-py/--row-fs`) in `globals.css` + **resurrect `DataTable.tsx`** (density prop, sortable headers, num/right-align columns) + `DensityToggle` client component | DataTable has zero importers — API changes are free today, never cheaper |
| 2 | Migrate the ~13 hand-rolled tables onto `<DataTable>` | Mechanical — same columns/sorts/chips. Find them all: `grep -r "hidden lg:block" src`. Spot-check 3 at `lg` before/after; mobile cards untouched |
| 3 | Shell: `PageContainer` `lg:` tiers widen + `desktopHeader` slot (renders only at `lg:`) + `TopBar` hidden at `lg:` when a desktopHeader exists + `pointer: coarse` gating for PTR and `active:` tap states | CSS gating only — do not delete mobile behavior |
| 4 | `navItems.ts` gains `section?: …` on lawn office/admin items ONLY (all other role navs + BOTH mobile builders ignore it — mobile hubs already exist) → `Sidebar.tsx` renders groups → rebuild `/lawn` home presentation per v2 (page header, 6-up KPIs at `xl:`, Today + schedules tables, toolbar, activity feed). Queries on /lawn stay exactly as-is | `/lawn/page.tsx` role redirects + solo-owner branch are load-bearing — leave them |
| 5 | Owner browser pass: desktop 1440/1920 vs v2 mockup; **mobile 390px pixel-unchanged on every touched surface** (THE regression risk of this whole pass); `pnpm build` + Playwright green | Owner runs this — your job is to hand it over in a state where it can pass |

## Division of labor

All five phases are UI work — yours. Claude-direct retains review of the `navItems.ts`
section wiring (nav is the app's single source of truth and has merge-conflict history
with the ISP branch) and the final mobile-unchanged audit before the owner's browser pass.

## Gotchas

- `PageContainer` is used by ~60 pages — a mistake in Phase 3 is a fleet-wide bug. Verify
  with the pages in each maxWidth tier, not just one.
- `TopBar`'s `backHref` behavior is deliberate on action pages (`/crew/photo?job=…`) —
  those are touch surfaces anyway; the `lg:` hide must not break their mobile back link.
- Sidebar counts: do NOT add three new round-trips per layout render. The /lawn KPI strip
  already computes overdue/approval counts — reuse that path (see how the unread badge is
  fed today). If the layout can't reach it cheaply, ship Phase 4 with static section
  headers and add pills in a follow-up rather than hacking a fetch into the Sidebar.
- localStorage keys: sections persist under `tv-sidebar-grps` (matches mockups); density
  under `tv-row-density`.
- The mockups' fonts/colors are design-reference only — the app implements them with its
  existing tokens (`globals.css` `@theme` block) and system font stack; do not add web
  font dependencies to the app for this pass.

**Start with Phase 1.** Commit per phase so the owner can bail at any boundary.