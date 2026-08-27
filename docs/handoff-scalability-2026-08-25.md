# Scalability Remediation — HANDOFF

> ## ✅ COMPLETE 2026-08-26
>
> **Priority 1 (crons)** — done by a prior session, commit `83f6877`
> (`perf(cron): batch the nightly lawn crons + add maxDuration headroom`).
>
> **Priority 2 (RLS `auth.uid()` sweep)** — done 2026-08-26. Migrations:
> `rls_initplan_tier_wrappers`, `rls_policy_backup_pre_initplan`,
> `rls_initplan_policy_sweep` (all applied and recorded).
>
> Done in two layers, as this handoff predicted would be cheaper:
> 1. **The four `tier_*` wrappers each called `auth.uid()` THREE times**
>    internally (and `same_org()` fans out to more helpers that read
>    `profiles`). Fixing those four functions covered **101 of 193 policies**
>    with a four-function change.
> 2. The remaining **89 policies** that call `auth.uid()` directly in their own
>    qual/with_check were rewritten programmatically.
>
> **Result: `auth_rls_initplan` advisor count 89 → 0.**
>
> **Semantic-neutrality proof.** Before changing anything, every policy was
> snapshotted to `public._rls_policy_backup_20260826`. Afterwards each policy
> body was normalised (stripping the `( SELECT auth.uid() AS uid)` wrapper back
> to `auth.uid()`) and diffed against that snapshot: **193/193 identical, 0
> differences**, with `cmd` and `roles` unchanged. The rewrite altered only the
> query plan, never the logic.
>
> **Tenant-isolation regression test** (this handoff insisted on it, and it
> matters more than the advisor number). Impersonated admin/office/crew/customer
> in each org via real JWT `sub` claims:
> - each role saw only its own org's slice; two admins in the same org saw
>   identical counts; office matched admin; crew saw a strict subset (assigned
>   jobs only, 0 customers/invoices); customers saw just their own record
> - **no role saw the global totals** (jobs 17 / customers 24 / invoices 3 /
>   lawn_visits 235) — the maximum any role saw was its own org's portion
>
> **Idempotency note:** the recorded sweep migration skips already-wrapped
> policies using a **case-insensitive** test, because Postgres re-formats the
> stored expression as uppercase `( SELECT auth.uid() AS uid)`. Without that the
> re-run would double-wrap. Verified: re-running produced 0 double-wrapped.
>
> **Rollback:** `public._rls_policy_backup_20260826` holds every pre-change
> policy definition.
>
> ### Still open from the "secondary RLS items" below
> - **`multiple_permissive_policies` (71 warnings)** — deliberately NOT done, and
>   Phase 3 below explains why: `EXPLAIN` shows Postgres short-circuits the OR'd
>   policies (`never executed`), so consolidating them buys almost nothing while
>   changing access semantics. The real cost was elsewhere — see Phase 3.
> - **The legacy `{public}`-scoped `jobs` policy** — **dropped** 2026-08-26,
>   migration `drop_legacy_public_crew_jobs_policy` (it lacked the `same_org()`
>   tenant check its `{authenticated}` twin has).
> - `unindexed_foreign_keys` — the 7 that are actually hot are now indexed
>   (Phase 3); the rest stay unindexed on purpose. `unused_index` (92) is still
>   an open low-priority cleanup.
>
> ## ✅ Phase 3 — policy-body hoisting + hot FK indexes (2026-08-26)
>
> The InitPlan sweep above fixed `auth.uid()`. It did **not** fix the bigger
> cost, which this phase found and removed.
>
> **The real bottleneck was not multiple permissive policies.** Consolidating
> them turned out to be near-worthless: `EXPLAIN` shows Postgres **short-circuits
> the OR'd policies** — the later subplans come back `never executed` once an
> earlier branch matches. The 71 `multiple_permissive_policies` warnings are
> mostly noise.
>
> **What actually cost:** `tier_office(organization_id)` and
> `same_org(auth.uid(), organization_id)` take a **column** argument. A function
> of a column cannot be an InitPlan, so Postgres re-entered the SECURITY DEFINER
> body and re-read `profiles` **once per candidate row**. `SECURITY DEFINER` is
> load-bearing here (the `profiles` policies themselves call `tier_office()`, so
> an INVOKER version recurses — that is what the old `fix_recursion*.sql` files
> were about), which also means Postgres can never inline them. The hoisting has
> to happen in the policy body.
>
> **The rewrite.** Split each call into a no-arg part the planner *can* hoist and
> a plain column comparison:
> ```sql
> -- before (per-row, fans out to profiles every row)
> using (tier_office(organization_id))
> -- after (two InitPlans + one indexable equality)
> using (((select public.me_is_office()) or (select public.me_is_super()))
>        and ((select public.me_is_super())
>             or (organization_id is not null
>                 and organization_id = (select public.me_org()))))
> ```
> New no-arg helpers (`me_org`, `me_is_super`, `me_is_office`,
> `me_is_office_or_pm`, `me_is_management`, `me_is_accountant`) are `stable
> security definer`, `search_path=public`, and **revoked from `anon`**.
>
> Correlated `EXISTS (... where jobs.id = photos.job_id ...)` subqueries in the
> crew policies were also rewritten to uncorrelated `job_id in (select ...)`,
> which the planner hashes once instead of re-probing per row. Equivalent: both
> require a matching row whose crew contains the caller, and a NULL `job_id`
> yields false either way.
>
> **Measured (`explain (analyze, buffers)`, same rows returned):**
>
> | table | before | after | buffers |
> |---|---|---|---|
> | `lawn_visits` | 119.99 ms | **1.34 ms** (~90x) | 1390 → 46 |
> | `photos` (office) | 12.10 ms | **4.37 ms** | 145 → 43 |
> | `photos` (crew) | 27.33 ms | **7.21 ms** | 382 → 64 |
>
> `photos` holds only 35 rows, so its wall-clock gain is muted — the **buffer**
> ratio is the number that matters, because it is the per-row `profiles` fan-out
> that was removed. That cost scales with table size; the remaining cost does not.
>
> **Verification.** A baseline of per-user visible row counts was captured to
> `public._hoist_baseline_20260826` **before** each change, then re-run after:
> **12/12 roles matched exactly** on `jobs`, `profiles`, and `photos`, and 12/12
> on `lawn_visits`.
>
> Row counts only exercise SELECT, so the write paths were probed separately
> (each insert rolled back inside a plpgsql subtransaction, 0 rows left behind):
>
> | scenario | result |
> |---|---|
> | crew inserts photo on their assigned job | allowed ✓ |
> | crew inserts photo on an unassigned job (same org) | denied ✓ |
> | office inserts photo in own org | allowed ✓ |
> | office inserts photo on **another org's** job | denied ✓ |
> | office updates **another org's** photos | 0 rows ✓ |
>
> Note for anyone re-running that probe: `trg_photos_org` stamps
> `organization_id` from the parent **before** `WITH CHECK` runs, so a
> cross-tenant test must use a foreign **job**, not a hand-set
> `organization_id` — otherwise the trigger corrects it and the test passes
> vacuously. Also, recording a "pass" into a scratch table *inside* the
> subtransaction you then roll back loses the row; keep the result in a plpgsql
> variable instead.
>
> **Hot FK indexes** (`index_hot_foreign_keys`). The advisor lists 83 unindexed
> FKs; indexing all of them is write amplification for no read benefit (the DB
> already has 92 unused indexes). Seven were added, on the two criteria that
> matter: the column is now compared to a hoisted scalar by a rewritten policy,
> or it backs a constantly-run query / ON DELETE parent check.
> - `photos(organization_id)`, `photos(uploaded_by)` — these are what make the
>   hoisting actually pay off; without them the policy still seq-scans.
> - `lawn_visits(job_id)` — **NOT NULL and had no index at all**; every
>   jobs→visits join and "visits for this property" screen was a seq scan.
> - `lawn_visits(crew_id)`, `lawn_visits(invoice_id)` — `crew_id` only existed as
>   the 2nd column of `idx_lawn_visits_route_order`, useless for a crew-leading
>   lookup.
> - `jobs(customer_id)`, `profiles(customer_id)` — both sides of the
>   "Customer see own photos" subquery.
>
> **Scratch-table leak, found and fixed** (`lock_down_rls_scratch_tables`). The
> baseline/backup tables were created in `public` — the schema PostgREST
> exposes — and inherited the default `anon`/`authenticated` grants with RLS
> off. Any unauthenticated caller could have read them over the REST API. They
> only held row counts and policy text, but the grants are revoked and RLS is on
> (no policies = deny). **Worth remembering as a general rule: a scratch table in
> `public` on Supabase is a public table.**
>
> **Migrations applied and recorded:** `rls_hoistable_me_helpers`,
> `rls_hoist_lawn_visits`, `rls_hoist_jobs_profiles`, `rls_hoist_photos`,
> `lock_down_rls_scratch_tables`, `index_hot_foreign_keys`.
>
> **Still open:** the ~101-policy long tail still uses the column-argument form.
> Each table needs its own baseline + verify cycle, and the payoff drops off fast
> after the hot tables — reassess before grinding through it. Rollback reference
> for everything above: `public._rls_policy_backup_20260826`.
>
> The original handoff text is preserved below.

---

**Prepared:** 2026-08-25 by a read-only audit session.
**Repo:** `C:\Users\garci_9e2kg3l\Projects\lowvoltage-app` (Next.js 16 / React 19 / Supabase, two build variants: construction = Terra Vista, lawn = Terra Verde).
**Supabase project id:** `avmqteevisqxwmmxkrbg` (MCP tools: `execute_sql`, `apply_migration`, `get_advisors`).

## TL;DR

The schema and indexes are in good shape. **Do not go index-hunting.** The scaling risk is concentrated in the **nightly cron jobs**, which are serial N+1 loops running platform-wide with no timeout override. Their ceilings are low enough that **one Pro-tier customer breaks them**, and they fail *silently* — orgs just stop getting service with no error surfaced.

Priority 1 (cron) is a contained, high-value fix. Priority 2 (RLS) is mechanical but touches 89 policies — do it second, and only after Priority 1 is verified.

---

## Verified baseline (already checked — don't redo)

- `npx tsc --noEmit` → exit 0
- `npx next lint` → exit 0
- All recent autopay/Connect/applicator-license DDL is confirmed **live** in production.
- Indexes on `lawn_visits`, `recurring_schedules`, `jobs`, `notifications` are **good** — including the partial indexes (`idx_lawn_visits_unbilled`, `idx_lawn_visits_notified`) and `uniq_lawn_visits_schedule_due`. The fixes below do not need new indexes on these tables.

---

# PRIORITY 1 — Cron jobs (do this first)

## 1a. Add `maxDuration` to all four cron routes

No route or `vercel.json` entry declares `maxDuration`, so every cron runs on Vercel's **default 10s (Hobby) / 15s (Pro)** timeout. This is the multiplier on every problem below.

Add to each of these four route files:

```ts
export const maxDuration = 300; // seconds; confirm the account plan allows it
```

- `src/app/api/lawn/cron/generate/route.ts`
- `src/app/api/lawn/cron/remind/route.ts`
- `src/app/api/lawn/cron/bill-cycle/route.ts`
- `src/app/api/leads/cron/follow-up/route.ts`

They already have `export const dynamic = "force-dynamic"`, so follow that existing pattern. **Verify the Vercel plan actually permits 300s** — if it caps lower, set the real cap and note it. This alone is a one-line-per-file change that buys immediate headroom, but it is **not** a substitute for 1b/1c.

## 1b. `/api/lawn/cron/remind` — the acute one

**File:** `src/app/api/lawn/cron/remind/route.ts`, loop at **lines 105–145**.

Runs daily at 13:08, selects **all** pending visits due today across **every org** (no org filter, no limit, no ordering), then per visit does, serially:

1. a `jobs` query (line ~108)
2. an `organizations` query (line ~128) — **redundant**, refetches the same org row for every visit in that org
3. `await sendCustomerNotification(...)` (line ~151), which internally makes **up to 5 more DB round-trips** (`notification_templates`, `notification_settings`, `customers`, `profiles`, `notification_log` insert — see `src/lib/customerNotifications.ts` lines 71/91/116/137/178, none cached) **plus an external email HTTP call**

That's **~7–9 DB round-trips + 1 external send per visit**, fully serial. At ~20ms DB RTT and ~300ms per email, that's roughly **450–500ms per visit**.

> **Current ceiling: ~30 visits/day platform-wide** on the default 15s timeout. Pro tier allows 1,000 customers; one Pro org on weekly mowing produces ~200 visits/day.

### Required changes

- **Hoist the org lookup out of the loop.** Collect the distinct `organization_id`s from `visitRows`, fetch them in one `.in("id", orgIds)` query, and build a `Map<orgId, name>`.
- **Batch the job lookups.** Replace the per-visit `jobs` query with one `.in("id", jobIds)` fetch (keep the `lawn_jobs(map_lat, map_lng)` join) into a `Map<jobId, job>`.
- **Cache settings/templates per org inside the run.** `getSettings` (line 86) and the template fetch (line 71) in `src/lib/customerNotifications.ts` are uncached and called once per visit. Add an optional per-invocation cache — the cleanest non-invasive option is a `Map` passed in via the input type, or a module-level `Map` keyed by `organizationId` that the cron seeds and clears. **Do not** introduce a cross-request/global cache that could leak settings between orgs — it must be scoped to a single cron invocation.
- **Bound the email concurrency.** Replace the serial `await` with batched concurrency (e.g. process in chunks of 5–10 via `Promise.allSettled`). Do **not** use an unbounded `Promise.all` over all visits — that will hit the mail provider's rate limit and lose sends.
- **Add deterministic ordering + a resume cursor.** Order by `(organization_id, id)` and record progress so a timeout resumes rather than silently dropping whichever orgs happened to sort last. There is already an `idx_lawn_visits_org_due` index supporting org-scoped ordering.

**Preserve exactly:** the `CRON_SECRET` bearer auth guard (lines ~44–60), the `isLawn()` no-op guard, the `{{arrival_window}}` / `{{service_date}}` token behavior (there's a deliberate comment at lines ~135–145 explaining why the window is appended to `service_date` — do not "clean that up"), and the existing `errors[]` accumulation shape in the JSON response.

## 1c. `/api/lawn/cron/generate` — silent visit-generation loss

**File:** `src/app/api/lawn/cron/generate/route.ts`, loop at **lines 113–160**.

Fetches all `active` schedules platform-wide (line ~98, no limit/order), then per schedule queries the latest `lawn_visits.due_date` (line ~118) before inserting. ~2 round-trips each, ~40ms per schedule.

> **Current ceiling: ~375 schedules platform-wide** on a 15s timeout. Pro allows 150 schedules/org — this breaks at roughly **3 Pro orgs**.

### Required changes

- **Eliminate the per-schedule "last visit" query entirely.** Replace the whole loop's lookup with one aggregate before the loop:

  ```sql
  select recurring_schedule_id, max(due_date) as last_due
  from lawn_visits
  where recurring_schedule_id = any($1)
  group by recurring_schedule_id
  ```

  Load it into a `Map<scheduleId, lastDue>`. The existing `uniq_lawn_visits_schedule_due (recurring_schedule_id, due_date)` index covers this well. If you'd rather not add an RPC, an equivalent `.in("recurring_schedule_id", ids)` select + JS reduce is acceptable — but chunk the `.in()` list (Supabase/PostgREST degrades on very large `IN` lists; ~500–1000 per chunk).
- **Batch the inserts.** Instead of one `.insert(inserts)` per schedule, accumulate across schedules and insert in chunks. **Keep the `23505` handling** — the code deliberately treats duplicate-date conflicts as expected/skippable (line ~156). With batched inserts, a single conflict can reject the whole batch, so either use `.upsert(..., { onConflict: "recurring_schedule_id,due_date", ignoreDuplicates: true })` or keep chunks small enough to isolate failures. Verify generated counts still come out correct either way.
- **Add ordering + resume cursor**, same rationale as 1b.

**Preserve exactly:** the seasonal auto-resume block at lines ~91–96 (flipping `active=true` / clearing `paused_from`/`paused_until` for schedules whose pause window has elapsed) — it must keep running *before* the active-schedule select, since it feeds it. Also preserve `HORIZON_DAYS = 90`, the `end_date` clamping, and the "never backfill before today" rule.

## 1d. Verification for Priority 1

- `npx tsc --noEmit` → must exit 0.
- Seed a scratch org with **~500 active schedules** and **~300 pending visits due today**, then invoke both crons locally with the `CRON_SECRET` bearer header. Both must complete well under the timeout, and — critically — **process every row**, not just the first N. Compare `processed` in the JSON response against the true row count.
- Confirm re-running `generate` immediately is idempotent (no duplicate visits, no `23505` spam in `errors[]`).
- Confirm `remind` does not double-send on a re-run (check `notification_log`).

---

# PRIORITY 2 — RLS per-row re-evaluation (89 policies)

**Do not start this until Priority 1 is merged and verified.**

Every policy uses bare `auth.uid()` instead of `(select auth.uid())`. Postgres treats the bare call as volatile and re-runs it — **plus the helper function wrapping it** — for every row scanned. Production evidence: `profiles` shows **8.25M sequential scans against 13 rows** (99.8% seq).

The helper functions themselves (`my_org_id`, `is_office`, `same_org`, `is_office_or_pm`, `is_management`, `get_my_tenant`) are already correctly `STABLE SECURITY DEFINER` — **do not modify them.** The bug is purely at the call site in the policies.

### The fix

Wrap every `auth.uid()` inside a policy `USING`/`WITH CHECK` in a scalar subselect:

```sql
-- before
using (same_org(auth.uid(), organization_id))
-- after
using (same_org((select auth.uid()), organization_id))
```

This lets the planner hoist it to a one-time InitPlan. Enumerate the affected policies with:

```sql
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname='public'
  and (qual like '%auth.uid()%' or with_check like '%auth.uid()%');
```

Also check `tier_office`, `tier_office_or_pm`, `tier_management`, `tier_accountant` — those wrappers appear in many policies and may embed `auth.uid()` internally; if so, fixing them at the source is far cheaper than editing every call site. **Inspect them before mass-editing policies.**

### Secondary RLS items (same pass)

- **Consolidate `lawn_visits` SELECT policies.** It currently has **5 permissive SELECT policies** for `authenticated` (`Office manage lawn visits`, `Crew read assigned lawn visits`, `Crew read my route lawn visits`, `Customer read own lawn visits`, `Management read lawn visits`). Postgres ORs all of them, so one row scan can trigger 5 policy evaluations, each hitting `profiles`. Merging into a single policy with `OR`'d branches would cut evaluations ~5× on the hottest table. **Be extremely careful to preserve the exact access semantics** — write out the current truth table first and verify each role still sees exactly what it saw before.
- **Investigate the legacy `jobs` policy `"Crew view assigned jobs"`.** It is scoped to role `{public}` (applies to `anon`), and duplicates `"Crew see assigned jobs"` which is correctly scoped to `{authenticated}` **and** includes the `same_org()` tenant check the public one lacks. It looks like a superseded leftover. Confirm nothing depends on it, then drop it. Flag to the user before dropping — do not silently remove a policy.

### Verification for Priority 2

- Re-run `get_advisors(type='performance')`; the `auth_rls_initplan` count must drop from 89 toward 0. Report before/after.
- **Regression-test tenant isolation explicitly.** For each role (office, admin, project_manager, crew, customer, accountant, super_admin), confirm they see exactly the same row sets as before the change on `jobs`, `customers`, and `lawn_visits`. An RLS refactor that leaks cross-tenant data is far worse than the perf problem it fixes.

---

# Lower priority (note, don't necessarily fix now)

- **79 unindexed foreign keys** (advisors INFO) — harmless at current volume; matters for cascade deletes and joins later.
- **25 unused indexes** — dead write overhead; safe to review but low value.
- **`/lawn/insights`** (`src/app/lawn/insights/page.tsx`, lines ~183–209) pulls 13 months of invoices, 12 weeks of visits, and 8 weeks of time entries, then aggregates in JS. It *is* correctly date-windowed, but a 1,000-customer org means ~12k visit rows in memory per page load. Push aggregation into SQL when it becomes a real complaint — not now.

---

# Boundaries

- **Stage explicitly. Never `git add -A`.**
- **Do not commit** the untracked root files: `CONNECT_PAYMENTS_HANDOFF.md`, `PHASE1_CONTENT_PACKAGE.md`, `TERRA_VERDE_MARKETING_PLAN_2026-08-23.md`, `.claude/launch.json`. They are intentionally uncommitted.
- **Do not touch** `public/terra-verde-*` or `public/terra-vista-*` brand assets — the logo work is finished and committed.
- **Do not push.** Leave commits local for review.
- Any DDL goes through `apply_migration` with a recorded name (migration tracking is already drifted — do not make it worse by applying raw SQL).
- If another agent/session is working the same repo concurrently, **coordinate before touching shared live state** (Supabase policies especially) — local file conflicts are recoverable, a half-applied RLS migration is not.
- `npx tsc --noEmit` must exit 0 before any commit.
