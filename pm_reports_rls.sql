-- Terra Vista — give project_manager (PM) read access to the org-wide reports
-- (per-worker weekly report + receipts report). Today the report PAGES gate on
-- role office/admin, and the underlying time_entries + receipts "office" RLS
-- policies use tier_office (office/admin/super_admin) — so PM is blocked from
-- the data even if the page admitted them. This widens those two office
-- policies to tier_office_or_pm so PM (who already has is_office_or_pm on jobs,
-- change orders, submittals, job_subcontractors) can read org time + receipts
-- for reporting.
-- ----------------------------------------------------------------------------
-- Scope: READ/WRITE of time_entries + receipts for PM. PM already runs jobs and
-- oversees crews/subs; seeing org labor + receipts for reports is the natural
-- extension (user green-lit 2026-08-17). Crew/own-record policies are untouched.
--
-- Idempotent (drop policy if exists before recreate). Safe to re-run.
-- Run in the Supabase SQL editor (single-quoted literals; paste from a text
-- editor — NOT the web editor, which mangles quotes).
-- ============================================================================
-- Run BEFORE deploying the app-side PM-reports gate change (so PM doesn't hit
-- the page and get empty data).

-- ── time_entries: office_all widened office → office_or_pm ─────────────────
drop policy if exists "office time_all" on public.time_entries;
create policy "office time_all" on public.time_entries for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- ── receipts: office_all widened office → office_or_pm ─────────────────────
drop policy if exists "office_receipts_all" on public.receipts;
create policy "office_receipts_all" on public.receipts for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));