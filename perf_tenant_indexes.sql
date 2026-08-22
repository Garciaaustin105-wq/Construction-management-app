-- perf_tenant_indexes.sql
-- Performance audit 2026-08-21 (Tier 2 #4). The core tenant tables had NO
-- index on organization_id — every org-scoped list/RLS read did a seq scan
-- across the RLS-filtered set. Confirmed missing via live pg_indexes on
-- jobs/customers/profiles/subcontractors/receipts/time_entries; estimates/
-- invoices/quotes confirmed missing from committed .sql (if-not-exists keeps
-- these safe if any already exist live via ad-hoc SQL Editor).
--
-- Run in the Supabase SQL Editor. Non-CONCURRENTLY is fine here (small tenant,
-- builds in ms). If any table grows large, re-run with CREATE INDEX
-- CONCURRENTLY one statement at a time (CONCURRENTLY can't run in a
-- transaction block, so run each separately).

-- ---- Confirmed missing live (2026-08-21 pg_indexes check) ----

-- jobs: the central table. Composite serves the dashboard/list pattern
-- (RLS org filter + .eq("type",...) + ORDER BY created_at desc). Leftmost
-- organization_id also serves org-only scans.
create index if not exists idx_jobs_org_type_created
  on public.jobs (organization_id, type, created_at desc);

-- customers: admin/customers list, org-scoped + ORDER BY name.
create index if not exists idx_customers_org_name
  on public.customers (organization_id, name);

-- profiles: admin/users + /time worker lists, org-scoped + ORDER BY full_name.
create index if not exists idx_profiles_org_full_name
  on public.profiles (organization_id, full_name);

-- subcontractors: admin/subcontractors list, org-scoped + ORDER BY company.
create index if not exists idx_subcontractors_org_company
  on public.subcontractors (organization_id, company);

-- receipts: /receipts list, org-scoped + ORDER BY captured_at desc.
create index if not exists idx_receipts_org_captured
  on public.receipts (organization_id, captured_at desc);

-- ---- Refinement: time_entries per-user history sort ----
-- user_id index exists but ORDER BY clock_in_at desc isn't index-served.
-- Serves /time + crew/time (per-user, newest first). The existing partial
-- (organization_id, status) index still serves the open/pending queries.
create index if not exists idx_time_entries_user_clock
  on public.time_entries (user_id, clock_in_at desc);

-- ---- File-evidence missing (not in the 6-table live check; if-not-exists safe) ----

-- estimates: /estimates list, org-scoped + ORDER BY created_at desc.
create index if not exists idx_estimates_org_created
  on public.estimates (organization_id, created_at desc);

-- invoices: /invoices list, org-scoped + ORDER BY created_at desc.
create index if not exists idx_invoices_org_created
  on public.invoices (organization_id, created_at desc);

-- quotes: org-scoped list, ORDER BY created_at desc.
create index if not exists idx_quotes_org_created
  on public.quotes (organization_id, created_at desc);