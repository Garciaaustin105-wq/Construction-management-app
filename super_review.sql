-- ============================================================================
-- super_review.sql — Superintendent review features (time approval, daily-log
-- review, punch ownership). Companion to the app-side Super review UI.
-- ----------------------------------------------------------------------------
-- Idempotent + additive (passes scripts/check-migrations.mjs). Run ONCE in the
-- Supabase SQL Editor — paste from Notepad, NOT the terminal.
--
-- What this does:
--   1. time_entries: add approval columns (status / approved_by / approved_at)
--      + admit FIELD_MGMT (tier_management) to READ + UPDATE. Until now the
--      live `office time_all` policy used tier_office_or_pm, which EXCLUDES
--      superintendent — so a super reaching /time (page gate FIELD_MGMT) saw an
--      empty list. INSERT/DELETE stay office/PM-only (office time_all).
--   2. daily_logs: add a tier_management UPDATE policy so a superintendent can
--      mark a log reviewed. Office/PM already manage via "Office manage daily
--      logs"; crew update their own. (Super can already INSERT a log as an
--      assigned-to-job user via "Crew insert daily logs" — that policy checks
--      created_by + assignment, not role.)
--   3. punch_items: widen "Office manage punch items" to tier_management so a
--      superintendent can create, assign, and close punch items on their site.
--      Office/admin/PM/super_admin are unchanged (still in tier_management);
--      this only ADDS superintendent.
--
-- tier_management(uid, org_id) = (is_management(uid) or is_super_admin(uid))
-- and same_org — is_management includes office/admin/superintendent/PM (reconciled
-- in roles_expand.sql). So tier_management == the app-side FIELD_MGMT set.
--
-- Depends on (already run): multi_tenancy_a.sql (tier_management), roles_expand.sql
-- (is_management includes admin + super), pm_reports_rls.sql (office time_all),
-- gc_pro_features.sql (daily_logs/punch_items tables + policies).
-- ============================================================================

begin;

-- ── 1. time_entries approval columns ────────────────────────────────────────
alter table public.time_entries
  add column if not exists status text not null default 'pending'
    check (status in ('pending','approved','rejected'));

alter table public.time_entries
  add column if not exists approved_by uuid
    references public.profiles(id) on delete set null;

alter table public.time_entries
  add column if not exists approved_at timestamptz;

-- Existing rows backfill to 'pending' (NOT NULL + default fills on ADD COLUMN).
-- Index the un-approved rows so the review queue is cheap to scan.
create index if not exists idx_time_entries_status
  on public.time_entries(organization_id, status) where status <> 'approved';

-- ── 2. time_entries RLS: field management can READ + UPDATE (review/approve) ─
-- `office time_all` (pm_reports_rls.sql) is FOR ALL with tier_office_or_pm — it
-- already grants office/admin/PM/super_admin full CRUD. These two policies only
-- ADD superintendent (via tier_management) for SELECT + UPDATE. INSERT/DELETE
-- remain tier_office_or_pm (office/PM), so a super can approve + edit crew time
-- but not add or delete entries.
drop policy if exists "Field mgmt read time" on public.time_entries;
create policy "Field mgmt read time" on public.time_entries
  for select to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "Field mgmt review time" on public.time_entries;
create policy "Field mgmt review time" on public.time_entries
  for update to authenticated
  using (public.tier_management(organization_id))
  with check (public.tier_management(organization_id));

-- ── 3. daily_logs RLS: field management can mark reviewed (UPDATE) ───────────
-- Office/PM already UPDATE via "Office manage daily logs" (tier_office_or_pm);
-- crew UPDATE their own via "Crew update own daily logs". This adds super.
drop policy if exists "Field mgmt review daily logs" on public.daily_logs;
create policy "Field mgmt review daily logs" on public.daily_logs
  for update to authenticated
  using (public.tier_management(organization_id))
  with check (public.tier_management(organization_id));

-- ── 4. punch_items RLS: widen office manage → field management ───────────────
-- Supers create/assign/close punch on their site. Drops the old "Office manage
-- punch items" (tier_office_or_pm) and recreates as tier_management. Office/
-- admin/PM/super_admin are still admitted (all in tier_management); only
-- superintendent is newly added. Crew policies (read assigned / insert /
-- advance assigned) + customer read are untouched.
drop policy if exists "Office manage punch items" on public.punch_items;
drop policy if exists "Field mgmt manage punch items" on public.punch_items;
create policy "Field mgmt manage punch items" on public.punch_items
  for all to authenticated
  using (public.tier_management(organization_id))
  with check (public.tier_management(organization_id));

-- ── Reload PostgREST so new columns/policies are visible immediately ─────────
notify pgrst, 'reload schema';

commit;

-- ── Verify (run in SQL Editor after) ─────────────────────────────────────────
-- select column_name from information_schema.columns
--   where table_name = 'time_entries' and column_name in ('status','approved_by','approved_at');
-- select polname, polcmd from pg_policy where polname in
--   ('Field mgmt read time','Field mgmt review time','Field mgmt review daily logs','Field mgmt manage punch items');
-- As a superintendent profile, SELECT time_entries ok, UPDATE status ok:
--   update time_entries set status='approved', approved_at=now(), approved_by=auth.uid()
--     where id='<some-row-id>' returning status;