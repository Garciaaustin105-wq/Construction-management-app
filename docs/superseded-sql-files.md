# Superseded / dead root `.sql` files

Generated 2026-08-25 by a read-only sweep of all 104 root `.sql` file headers
(+ body where the header was unclear). Companion to `docs/migrations-policy.md`.

**Nothing here is deleted.** This is a categorized inventory so a future,
deliberate cleanup can delete the dead files after a reviewer confirms the
surviving DDL is already in the live schema / `docs/schema-baseline-2026-08-25.sql`.
Deletion is a separate step with its own review.

Items marked **⚠️ verify against live DB** could not be confirmed superseded
from the filesystem alone — their policies may have been rewritten in place by
a later file (e.g. `multi_tenancy_b.sql`, `close_legacy_rls_bypass.sql`) without
an explicit "replaces" header. Confirm against `pg_policy` / `pg_proc` before
deleting.

## A — Superseded (16)

A later file replaces, reverses, or subsumes this one. Safe to delete after
confirming the superseding file's DDL is live.

| File | Superseded by | Reason |
|------|---------------|--------|
| `blueprints_storage_fix.sql` | `blueprints_private.sql` + `blueprints_office_or_pm.sql` | Made bucket public + office-only; later files make it private + widen to PM. Bucket creation itself is live/idempotent. |
| `connect_payouts_enabled.sql` | `drop_connect_columns.sql` | Per project notes **never run**; conflicts with the payments pivot; column dropped by `drop_connect_columns.sql`. Dead/skip. |
| `crew_status_rls.sql` | `office_only_jobs_update.sql` | "Crew update assigned job status" policy dropped and replaced by office-only update. |
| `fix_recursion.sql` | `fix_recursion_v2.sql` | JWT/app_metadata approach to "Office read all profiles"; v2 drops both profile policies and creates the `is_office` SECURITY DEFINER helper. |
| `harden_function_execute.sql` | `harden_function_execute_v2.sql` | **Kept on purpose** — v2 is additive (extends to `decide_change_order` / `sign_proposal`), not a drop-in replacement. Do not delete. |
| `invoice_deposit_applied.sql` | `approve_deposit_invoice.sql` | `approve_estimate` RPC redefinition superseded ("GUARDS preserved VERBATIM"). The `amount_paid` column it added is still live. |
| `invoice_pay_connect.sql` | `drop_connect_columns.sql` | Adds Stripe Connect org columns; **reversed** by `drop_connect_columns.sql` (drops all four Connect columns). |
| `invoices_standalone.sql` | `estimates_merge_b.sql` | Drops NOT NULL on `invoices.quote_id` + unique constraint; v2 drops the `invoices.quote_id` column entirely. |
| `office_delete_jobs.sql` | `multi_tenancy_b.sql` / `close_legacy_rls_bypass.sql` | Unscoped (role='office', no `same_org`) office delete policies; superseded by org-scoped rewrites. ⚠️ verify against live DB. |
| `office_only_jobs_update.sql` | `multi_tenancy_b.sql` | Unscoped role='office' jobs UPDATE; superseded by org-scoped `tier_office(organization_id)` rewrite. Also drops the crew-update policy from `crew_status_rls.sql`. ⚠️ verify against live DB. |
| `photo_insert_rls.sql` | `photo_upload_gating.sql` | "Crew insert photos" (role-only, no assignment gate) superseded by assignment-gated version on both storage bucket and photos table. |
| `photos_gps.sql` | `phase3.sql` | Adds `photos.lat/lng` + index; subsumed by `phase3.sql` (same columns/index, idempotent, redundant). |
| `receipts_extra_fields.sql` | `phase3.sql` | Adds receipts category/tax/payment_method/receipt_no; subsumed by `phase3.sql` (same columns, redundant). |
| `storage_fix.sql` | `photo_upload_gating.sql` | Loosened "Crew upload photos" to role-only (dropped assignment gate from `storage_setup.sql`); reversed by re-tightened assignment-gated policy. |
| `storage_setup.sql` | `photos_private.sql` + `photo_upload_gating.sql` | Created the job-photos bucket (live/idempotent) + "Public read" + "Crew upload" policies; both policies superseded (read → `photos_private`, upload → `storage_fix` → `photo_upload_gating`). |

## B — Dead (3)

References a table/column/RPC that was later dropped. The dropped object no
longer exists in the live schema.

| File | Dropped by | Dead object |
|------|-----------|-------------|
| `quotes_invoices.sql` | `estimates_merge_b.sql` | `quotes` + `quote_line_items` tables (the `invoices` half of this file is still live). |
| `quotes_send.sql` | `estimates_merge_b.sql` | `quotes.share_token` (the `quotes` table was dropped). |
| `reject_quote.sql` | `estimates_merge_b.sql` | `reject_quote()` RPC + the `quotes` table. |

## D — Inspection-only (5)

SELECT-only diagnostic scripts, never applied as DDL. Safe to delete from a
migration-cleanup perspective (they are not migrations).

- `check_invoices_table.sql`
- `check_is_office.sql`
- `check_phase2_deps.sql`
- `check_phase2_tables.sql`
- `list_schemas.sql`

## C — Live / current (80)

Still the state of the DB; no later file supersedes. **Kept.** Not listed
individually here for brevity — see the full sweep in the generating agent's
report. Notable live files that an earlier draft might wrongly assume dead:

- `fix_jobs_recursion.sql` — **NOT** superseded by `fix_recursion_v2.sql`; they fix different recursions (jobs↔lawn_visits vs profiles). `fix_jobs_recursion` redefines the "Crew read jobs via lawn visit" policy that `lawn_crew_route.sql` first created (same policy name, drop+recreate) — so only that one policy in `lawn_crew_route.sql` is superseded; its other policies are live.
- `estimates_merge_a.sql` + `estimates_merge_b.sql` — a two-phase migration (A adds/backfills, B drops the quotes surface); both ran and both are live — **neither supersedes the other**.
- `lawn_time_model.sql` + `lawn_time_model_harden.sql` — `lawn_time_model_harden.sql` replaces the guard trigger **function** in place; the time-model columns from `lawn_time_model.sql` stay live. Both live.
- `customer_notifications.sql` + `notification_templates_fix.sql` — the fix patches the **seed function** from `customer_notifications.sql` (not from `notifications.sql` / `gc_pro_notifications.sql`).

### C-files flagged ⚠️ verify against live DB

These are live in intent but use the pre-`multi_tenancy_b.sql` unscoped
`role='office'` pattern, so their policies may have been rewritten in place by
`multi_tenancy_b.sql` / `close_legacy_rls_bypass.sql` without an explicit
"replaces" header. Confirm against `pg_policy` before deleting:

- `customer_rls.sql` — `profiles.customer_id` column is live; policies may be rewritten.
- `office_photo_upload.sql` — "Office upload photos" storage INSERT; `photo_upload_gating.sql` says office policies untouched, but uses unscoped `role='office'`.
- `customer_payment_methods.sql` — adds customer Stripe card-on-file columns for the old Connect direct-charges path; the Pay Here path was removed and no file explicitly drops these columns — they may be **orphaned**.
- `estimates.sql` — estimates tables are the current surface, but the `convert_estimate_to_quote` RPC it creates was later dropped by `estimates_merge_b.sql`; verify the RPC drop.

## Cross-reference chains (verified)

- **Photo-RLS chain:** `storage_setup` (open) → `storage_fix` (loosened crew upload) → `photos_private` (private bucket + photos table RLS) → `photo_upload_gating` (re-tightened crew upload) → `photos_storage_fix` (crew signed-URL helper fix). Final live state = private bucket, assignment-gated crew upload, scoped read.
- **Connect reversal:** `invoice_pay_connect.sql` + `connect_payouts_enabled.sql` → `drop_connect_columns.sql` (drops the four Connect columns; idempotent no-op now).
- **Profiles recursion:** `fix_recursion.sql` → `fix_recursion_v2.sql` (creates `is_office` SECURITY DEFINER).
- **Jobs/lawn_visits recursion:** `lawn_crew_route.sql` (first "Crew read jobs via lawn visit" policy) → `fix_jobs_recursion.sql` (drop+recreate of that one policy; rest of `lawn_crew_route.sql` live).

## Cleanup checklist (for a later, deliberate pass)

1. Confirm `docs/schema-baseline-2026-08-25.sql` contains the surviving DDL for every A/B/D file.
2. For each ⚠️ file, run the live `pg_policy` / `pg_proc` check to confirm supersession.
3. Delete the A/B/D files in one commit (keep `harden_function_execute.sql` — kept on purpose).
4. Do not touch any C file.