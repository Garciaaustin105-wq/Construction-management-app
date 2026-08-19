-- ============================================================================
-- roles_expand.sql — expand the role model: Sales + Accountant + Superintendent
-- ============================================================================
-- Companion to the app-side role expansion (roles.ts + navItems.ts + page gates
-- + dashboard fan-out). Idempotent. Run ONCE via the Supabase SQL Editor —
-- paste from Notepad, NOT the terminal (the terminal mangles multiline SQL).
--
-- What this does:
--   1. RECONCILE the base role helpers to their canonical multi_tenancy_a
--      definitions (include `admin`). multi_tenancy_b.sql rewrote every POLICY
--      to use the tier_* helpers but did NOT redefine the base functions, so
--      if the narrow copies in subcontractors.sql (is_office_or_pm /
--      is_management WITHOUT admin) were the live ones, `admin` was silently
--      excluded from every tier_office_or_pm / tier_management policy
--      (invoices, estimates, receipts, time_entries, subcontractors,
--      change_orders, jobs update, …). This restore's multi_tenancy_a's intent
--      ("admin is treated as office everywhere"). Idempotent either way.
--   2. Add is_pipeline() + is_accountant() + tier_pipeline() + tier_accountant()
--      helpers (same SECURITY DEFINER / search_path=public pattern as the
--      existing tier_* helpers).
--   3. SALES: widen estimates + estimate_line_items from tier_office_or_pm to
--      tier_pipeline (admits sales — the estimator/pre-sale role — on top of
--      PM/office/admin/super_admin). Sales owns the pre-sale funnel.
--   4. ACCOUNTANT: add read-only (FOR SELECT) policies on invoices,
--      invoice_line_items, customers, jobs, receipts, time_entries,
--      subcontractors, change_orders via tier_accountant. No WITH CHECK / write
--      policies — accountant is strictly read-only.
--
-- NOT done here (moot): the "superintendent can't upload job photos" fix.
-- multi_tenancy_b.sql already rewrote the job-photos insert policy to
-- `storage_caller_assigned_to_job(name)` — assignment-based, NOT role='crew' —
-- so a superintendent assigned to a job (assign_job_crew admits crew AND
-- superintendents) can already upload. No storage change needed.
--
-- Depends on (already run): multi_tenancy_a.sql (is_office/is_super_admin/
-- same_org/tier_*), multi_tenancy_b.sql (the tier_* policies this widens).
-- ============================================================================


-- ── 1. Reconcile base helpers (include admin) ──────────────────────────────

create or replace function public.is_office(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin')
  );
$$;

create or replace function public.is_office_or_pm(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin', 'project_manager')
  );
$$;

create or replace function public.is_management(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin', 'superintendent', 'project_manager')
  );
$$;


-- ── 2. New role helpers: pipeline (sales) + accountant ─────────────────────

-- Sales pipeline: sales + PM + office + admin (the estimate-authoring set).
-- super_admin is OR'd in at the tier_ layer (platform-wide), not here.
create or replace function public.is_pipeline(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('sales', 'project_manager', 'office', 'admin')
  );
$$;

-- Read-only financials: accountant + office + admin. (office/admin already
-- have write access via other policies; membership here only gates page ENTRY
-- and the read policies below — it grants no writes.)
create or replace function public.is_accountant(uid uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('accountant', 'office', 'admin')
  );
$$;

-- Tier helpers = role check AND same_org, with super_admin explicit (same
-- shape as tier_office / tier_office_or_pm / tier_management in
-- multi_tenancy_a.sql). Every policy below routes through these — never call
-- is_pipeline / is_accountant directly in a policy (no org boundary).
create or replace function public.tier_pipeline(org_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (public.is_pipeline(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$$;

create or replace function public.tier_accountant(org_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select (public.is_accountant(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$$;

grant execute on function public.is_pipeline(uuid)        to authenticated;
grant execute on function public.is_accountant(uuid)      to authenticated;
grant execute on function public.tier_pipeline(uuid)      to authenticated;
grant execute on function public.tier_accountant(uuid)    to authenticated;


-- ── 3. SALES — estimates + estimate_line_items (pre-sale funnel) ───────────
-- Was tier_office_or_pm (office/admin/PM/super_admin). Widened to tier_pipeline
-- so `sales` can author estimates. The policy NAME is historical ("office_*");
-- the drop-if-exists makes this a safe in-place replace. Crew read policies
-- (crew_estimates_select / crew_estimate_items_select) are untouched.

drop policy if exists "office_estimates_all" on public.estimates;
create policy "office_estimates_all" on public.estimates
  for all to authenticated
  using (public.tier_pipeline(organization_id))
  with check (public.tier_pipeline(organization_id));

drop policy if exists "office_estimate_items_all" on public.estimate_line_items;
create policy "office_estimate_items_all" on public.estimate_line_items
  for all to authenticated
  using (public.tier_pipeline(organization_id))
  with check (public.tier_pipeline(organization_id));


-- ── 4. ACCOUNTANT — read-only SELECT policies (no writes) ──────────────────
-- One FOR SELECT policy per table, org-scoped via tier_accountant. These only
-- ADD read access for `accountant`; office/admin/super_admin are already
-- admitted by the existing tier_office / tier_office_or_pm / tier_management
-- policies (OR'd), so this is a pure widening for the accountant role.

drop policy if exists "Accountant read invoices" on public.invoices;
create policy "Accountant read invoices" on public.invoices
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read invoice_line_items" on public.invoice_line_items;
create policy "Accountant read invoice_line_items" on public.invoice_line_items
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read customers" on public.customers;
create policy "Accountant read customers" on public.customers
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read jobs" on public.jobs;
create policy "Accountant read jobs" on public.jobs
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read receipts" on public.receipts;
create policy "Accountant read receipts" on public.receipts
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read time_entries" on public.time_entries;
create policy "Accountant read time_entries" on public.time_entries
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read subcontractors" on public.subcontractors;
create policy "Accountant read subcontractors" on public.subcontractors
  for select to authenticated
  using (public.tier_accountant(organization_id));

drop policy if exists "Accountant read change_orders" on public.change_orders;
create policy "Accountant read change_orders" on public.change_orders
  for select to authenticated
  using (public.tier_accountant(organization_id));


-- ── Verify (run in SQL Editor after) ────────────────────────────────────────
-- select proname from pg_proc where proname in
--   ('is_pipeline','is_accountant','tier_pipeline','tier_accountant');
-- select polname, polcmd from pg_policy where polname like 'Accountant read%';
-- As an accountant profile, SELECT invoices ok, INSERT invoice denied:
--   set role authenticated; -- then query as the accountant's auth.uid()