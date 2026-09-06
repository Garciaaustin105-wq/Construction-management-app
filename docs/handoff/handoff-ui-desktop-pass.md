# Desktop UI pass — implementation contract

**Status**: APPROVED design (v1 sidebar regroup + v2 desktop density). Phases 1+2 shipped
on `feat/desktop-ui-pass` (`06fd3d9` density tokens + DataTable resurrection; `28f9421`
11 tables migrated — DataTable gained framed/mobileCardClassName/mobileCardBare/
mobileListClassName/rowExpansion parity props). Phases 3-5 pending. Mobile output is
pixel-identical so far; `PlantCatalogueManager.tsx` (Lane A's file) still hand-rolled —
flagged, not touched.
**Design mockups**: `C:\Users\garci_9e2kg3l\Projects\design\lawn-nav-regroup.html` (v1),
`lawn-desktop-home-v2.html` (v2) — the visual reference for every phase below.

## The one rule

**This pass only changes `lg:`-and-up rendering. Mobile (`<lg`) output is byte-identical
wherever possible.** Every phase is desktop chrome/layout; no route changes, no RLS, no
gates, no data changes. If a diff changes what a phone shows, stop and reconsider.

## Design decisions already made (do not re-litigate)

- **Grouped sidebar** — lawn office/admin nav collapses into 7 sections (Today / Money /
  Customers / Work / Chemical / Team / System) + Home pinned on top. Counts (bad/amber
  pills) on Overdue / Approvals / Leads. Sections collapse; state persists in
  localStorage. Source of truth: v1 mockup.
- **Dark-green sidebar shell** on desktop (the frame) with light content — approved.
- **Density is a per-user setting**: STANDARD / COMPACT toggle in the page header,
  persisted (localStorage `tv-sidebar-grps` pattern applies to `tv-row-density`).
  Drives CSS custom properties `--row-py` / `--row-fs` (see globals.css phase).
- **Status color language stays loud** (Jobber redesign backlash lesson): the existing
  `--success/--warning/--danger` chips must not be neutralized by this pass.
- **Money/count columns**: `tabular-nums`, right-aligned. Headers: uppercase,
  `font-mono`, 9.5–11px, tracked.
- **Open questions (owner decides later, defaults chosen)**: AI admin stays in System
  (default); Email Preview stays in System (default); Scheduling stays as a Today tab
  (default). If the owner overrides, that is a one-line `section` value change.

## Phase 1 — density tokens + the table primitive

1. `src/app/globals.css`: add to the existing `:root` token block:
   `--row-py: 11px; --row-fs: 13.5px;` and expose `--color-row-py/--color-row-fs` via
   `@theme inline` (or a utility class pair `.dt-standard/.dt-compact` that overrides
   the two properties on a container). Compact = `--row-py: 5px; --row-fs: 13px`.
2. **Resurrect `src/components/ui/DataTable.tsx`** (currently orphaned — zero imports).
   Extend it with:
   - density prop wired to the tokens (default standard);
   - sortable header option (the pages that hand-roll `Th` sort buttons migrate to it);
   - `align`/`num` column support (right-align + tabular-nums);
   - keep the existing stretched-link row affordance and mobile card fallback as-is.
3. Add a small `DensityToggle` client component (STANDARD | COMPACT segmented control,
   mono labels) writing localStorage + toggling a class on the table container.

**Verify**: build clean; existing DataTable API users = none, so no regressions possible.

## Phase 2 — migrate the 13 hand-rolled tables

Surfaces with `hidden lg:block` inline tables today: `InvoicesList.tsx`,
`src/app/estimates/page.tsx`, `src/app/lawn/jobs/page.tsx`, `CustomersManager.tsx`,
`CrewMembersManager.tsx`, `ChemicalProductsManager.tsx`, `ChemicalApplicationsManager.tsx`,
`daily-logs`, `punch`, `change-orders`, `submittals`, `admin/orgs`, `PlantCatalogueManager.tsx`
(+ any found by `grep -r "hidden lg:block" src`). Mechanical: same columns, same sorts,
same chips — swap the inline grid for `<DataTable columns={…} rows={…}>`.

**Verify**: each page renders identically at `lg` before/after (side-by-side spot check
on 3 of the 13 is enough); mobile card lists untouched.

## Phase 3 — desktop shell

1. `PageContainer.tsx`: at `lg:` the tiers widen — `list` drops its cap (content grid
   fills the sidebar-adjacent width), `wide`/`full` already exist but get used on the
   pages that need them. Mobile keeps `max-w-md`. Add a `desktopHeader` slot that
   renders ONLY at `lg:` (title + subtitle + right-aligned actions — the v2 pagehead).
2. `TopBar.tsx`: gains `desktop="hide"` behavior (or PageContainer stops rendering it
   at `lg:` when a desktopHeader is provided). Mobile TopBar unchanged.
3. Gate touch-only affordances: `ClientPullToRefresh` and `active:bg-*` tap states
   render/apply only under `@media (pointer: coarse)` (CSS) — no JS removal.

## Phase 4 — grouped sidebar + /lawn home rebuild

1. `navItems.ts`: add optional `section?: "today"|"money"|"customers"|"work"|"chemical"|
   "team"|"system"` to `NavItem`. Only the lawn office/admin flat list sets it; all
   other role navs and BOTH mobile builders ignore it (mobile hubs already exist —
   do not touch `buildMobileNav`). `Sidebar.tsx` renders pinned Home + collapsible
   section groups from `section`; unknown/no section renders as today (flat fallback
   for construction, which keeps its current sidebar).
2. `/lawn` home (`src/app/lawn/page.tsx`): rebuild the desktop presentation per v2 —
   page header with actions (Quick quote / New lawn job), six-up KPI strip at `xl:`,
   Today table (stop/customer/service/crew/window/status), Recurring schedules table
   (job/cadence/price/next-due/status), quick-actions toolbar in the rail, customer
   activity feed. Queries stay exactly as they are — this is presentation only. Solo
   owner branch and role redirects untouched.
3. Sidebar counts: Overdue/Approvals/Leads pills need counts at the Sidebar level —
   reuse the queries the /lawn KPI strip already runs; pass through layout providers
   rather than new round-trips (see how unread badge is fed today).

## Phase 5 — verification (owner-run browser pass)

- Desktop 1440/1920: `/lawn`, invoices, estimates, jobs, customers, calendar — compare
  against the v2 mockup.
- Mobile 390px: confirm the listed surfaces are pixel-unchanged (this is THE regression
  risk of the whole pass).
- `pnpm build` + existing Playwright suite green.

## Out of scope (explicitly)

Mobile redesign of any kind · route/URL changes · role-gate changes · RLS · the
construction variant's sidebar (keeps flat) · dark mode for the app itself.