-- ============================================================================
-- MULTI-TENANCY PART B: org-scoped RLS rewrite + with check + NOT NULL
-- ============================================================================
-- Run AFTER multi_tenancy_a.sql AND after the app deploy is confirmed live.
-- This file rewrites every business-table RLS policy to AND on same_org / the
-- appropriate tier_* helper (so rows are visible only within the caller's org,
-- with super_admin as a platform-wide bypass), mirrors every INSERT/UPDATE/
-- DELETE policy with a `with check`, adds the missing policies for jobs/rfis/
-- blueprints (which previously relied on RLS being OFF), extends the storage
-- helpers + policies with same_org, adds in-body org checks to the SECURITY
-- DEFINER RPCs, and finally sets organization_id NOT NULL on the 18 business
-- tables + a CHECK on profiles tying super_admin to a null org.
--
-- Idempotent (drop policy if exists + create). Run via Supabase SQL Editor —
-- paste from Notepad, NOT the terminal.
--
-- PREREQUISITES:
--   * multi_tenancy_a.sql has been run (columns + backfill + helpers + triggers).
--   * The app deploy is LIVE (root inserts now set organization_id; child
--     inserts are trigger-stamped). If any root insert path still omits org,
--     the NOT NULL step at the bottom will fail — that is intentional.
--   * Every existing row has organization_id populated (file A backfilled all).
-- ============================================================================

-- ── 0. Enable RLS on every business table (idempotent) ─────────────────────
-- Four tables (jobs, profiles, rfis, blueprints) had policies but RLS was never
-- enabled — so the policies were no-ops and every authenticated user saw every
-- row. Enabling RLS here is what actually makes the policies below enforce.
alter table public.organizations          enable row level security;
alter table public.profiles               enable row level security;
alter table public.jobs                   enable row level security;
alter table public.customers              enable row level security;
alter table public.cost_codes             enable row level security;
alter table public.subcontractors         enable row level security;
alter table public.photos                 enable row level security;
alter table public.rfis                   enable row level security;
alter table public.blueprints             enable row level security;
alter table public.job_views              enable row level security;
alter table public.time_entries           enable row level security;
alter table public.receipts               enable row level security;
alter table public.quotes                 enable row level security;
alter table public.quote_line_items       enable row level security;
alter table public.invoices               enable row level security;
alter table public.invoice_line_items     enable row level security;
alter table public.estimates              enable row level security;
alter table public.estimate_line_items    enable row level security;
alter table public.job_subcontractors     enable row level security;
alter table public.subcontractor_attachments enable row level security;

-- ── 1. organizations ───────────────────────────────────────────────────────
-- NOTE: the organizations table has NO organization_id column — its own
-- primary key `id` IS the org id. So the same_org() check below uses `id`,
-- not organization_id. (Every other table in this file uses organization_id.)
-- Any org member may read their own org (e.g. to render the business name).
-- Only the org admin (or super_admin) may update it. Inserts happen via the
-- service role in /api/signup (bypasses RLS); no public insert/delete policy.
drop policy if exists "Org members read org" on public.organizations;
create policy "Org members read org" on public.organizations for select
  to authenticated
  using (public.same_org(auth.uid(), id));

drop policy if exists "Org admin update org" on public.organizations;
create policy "Org admin update org" on public.organizations for update
  to authenticated
  using (
    public.same_org(auth.uid(), id)
    and (
      public.is_super_admin(auth.uid())
      or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    )
  )
  with check (
    public.same_org(auth.uid(), id)
    and (
      public.is_super_admin(auth.uid())
      or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    )
  );

-- ── 2. profiles ────────────────────────────────────────────────────────────
-- Own row always readable (needed by the app's role/org lookups). Office/admin
-- read all profiles WITHIN their org (so /admin/users lists only their people).
-- Management reads the field-team (crew/super/PM) in their org. Office/admin
-- may insert (create users) + update within their org; super_admin anywhere.
drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile" on public.profiles for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "Office read all profiles" on public.profiles;
create policy "Office read all profiles" on public.profiles for select
  to authenticated
  using (public.tier_office(organization_id));

drop policy if exists "Management read field-team profiles" on public.profiles;
create policy "Management read field-team profiles" on public.profiles for select
  to authenticated
  using (
    public.tier_management(organization_id)
    and role in ('crew', 'superintendent', 'project_manager')
  );

drop policy if exists "Office insert profiles" on public.profiles;
create policy "Office insert profiles" on public.profiles for insert
  to authenticated
  with check (public.tier_office(organization_id));

drop policy if exists "Office edit customer_id on profiles" on public.profiles;
create policy "Office edit customer_id on profiles" on public.profiles for update
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

-- ── 3. jobs (hub) ──────────────────────────────────────────────────────────
-- jobs previously had NO select policy (RLS was off → everyone saw everything).
-- Now: management sees all jobs in their org; crew sees only jobs they're
-- assigned to; customers see their own jobs. Insert = office/admin; update =
-- office/admin/PM (matches the app's OFFICE_OR_PM edit gate); delete = office.
drop policy if exists "Customer see own jobs" on public.jobs;
drop policy if exists "Office update jobs" on public.jobs;
drop policy if exists "Crew update assigned job status" on public.jobs;
drop policy if exists "office_delete_jobs" on public.jobs;
drop policy if exists "Management see jobs" on public.jobs;
drop policy if exists "Crew see assigned jobs" on public.jobs;
drop policy if exists "Office insert jobs" on public.jobs;

create policy "Management see jobs" on public.jobs for select
  to authenticated
  using (public.tier_management(organization_id));

create policy "Crew see assigned jobs" on public.jobs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and auth.uid() = any(assigned_crew)
  );

create policy "Customer see own jobs" on public.jobs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
  );

create policy "Office insert jobs" on public.jobs for insert
  to authenticated
  with check (public.tier_office(organization_id));

create policy "Office update jobs" on public.jobs for update
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "office_delete_jobs" on public.jobs for delete
  to authenticated
  using (public.tier_office(organization_id));

-- ── 4. customers ───────────────────────────────────────────────────────────
drop policy if exists "Customer see own record" on public.customers;
drop policy if exists "Office all customers" on public.customers;
drop policy if exists "Management read customers" on public.customers;

create policy "Customer see own record" on public.customers for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and id in (select customer_id from public.profiles where id = auth.uid())
  );

create policy "Office all customers" on public.customers for all
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

create policy "Management read customers" on public.customers for select
  to authenticated
  using (public.tier_management(organization_id));

-- ── 5. cost_codes ───────────────────────────────────────────────────────────
-- `read cost_codes` was `true` (any authenticated user, any org). Gate to
-- same-org so a second tenant can't read another's cost codes.
drop policy if exists "office cost_codes_all" on public.cost_codes;
drop policy if exists "read cost_codes" on public.cost_codes;

create policy "office cost_codes_all" on public.cost_codes for all
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

create policy "read cost_codes" on public.cost_codes for select
  to authenticated
  using (public.same_org(auth.uid(), organization_id));

-- ── 6. subcontractors ───────────────────────────────────────────────────────
drop policy if exists "Office all subcontractors" on public.subcontractors;
drop policy if exists "Management read subcontractors" on public.subcontractors;

create policy "Office all subcontractors" on public.subcontractors for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "Management read subcontractors" on public.subcontractors for select
  to authenticated
  using (
    public.is_management(auth.uid())
    and not public.is_office_or_pm(auth.uid())
    and public.same_org(auth.uid(), organization_id)
  );

-- ── 7. job_subcontractors ───────────────────────────────────────────────────
drop policy if exists "Office all job_subcontractors" on public.job_subcontractors;
drop policy if exists "Management read job_subcontractors" on public.job_subcontractors;

create policy "Office all job_subcontractors" on public.job_subcontractors for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "Management read job_subcontractors" on public.job_subcontractors for select
  to authenticated
  using (
    public.is_management(auth.uid())
    and not public.is_office_or_pm(auth.uid())
    and public.same_org(auth.uid(), organization_id)
  );

-- ── 8. subcontractor_attachments ───────────────────────────────────────────
drop policy if exists "Office all sub attachments" on public.subcontractor_attachments;
drop policy if exists "Management read sub attachments" on public.subcontractor_attachments;

create policy "Office all sub attachments" on public.subcontractor_attachments for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "Management read sub attachments" on public.subcontractor_attachments for select
  to authenticated
  using (
    public.is_management(auth.uid())
    and not public.is_office_or_pm(auth.uid())
    and public.same_org(auth.uid(), organization_id)
  );

-- ── 9. photos ───────────────────────────────────────────────────────────────
drop policy if exists "Office photos select" on public.photos;
drop policy if exists "Crew photos assigned" on public.photos;
drop policy if exists "Customer see own photos" on public.photos;
drop policy if exists "Office insert photos" on public.photos;
drop policy if exists "Crew insert photos" on public.photos;
drop policy if exists "Office update photos" on public.photos;
drop policy if exists "Crew update own photos" on public.photos;
drop policy if exists "office_delete_photos" on public.photos;

create policy "Office photos select" on public.photos for select
  to authenticated
  using (public.tier_office(organization_id));

create policy "Crew photos assigned" on public.photos for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs where id = photos.job_id and auth.uid() = any(assigned_crew))
  );

create policy "Customer see own photos" on public.photos for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and job_id in (
      select j.id from public.jobs j
      where j.customer_id in (select customer_id from public.profiles where id = auth.uid())
    )
  );

create policy "Office insert photos" on public.photos for insert
  to authenticated
  with check (public.tier_office(organization_id));

create policy "Crew insert photos" on public.photos for insert
  to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs where id = photos.job_id and auth.uid() = any(assigned_crew))
  );

create policy "Office update photos" on public.photos for update
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

create policy "Crew update own photos" on public.photos for update
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and uploaded_by = auth.uid()
  )
  with check (
    public.same_org(auth.uid(), organization_id)
    and uploaded_by = auth.uid()
  );

create policy "office_delete_photos" on public.photos for delete
  to authenticated
  using (public.tier_office(organization_id));

-- ── 10. rfis ────────────────────────────────────────────────────────────────
-- rfis previously had ONLY a delete policy (no select/insert/update; RLS was
-- off). RFIs are office-internal per the app (the crew/rfi page admits only
-- office/admin), so gate all CRUD to office/admin within the org.
drop policy if exists "office_delete_rfis" on public.rfis;
drop policy if exists "Office rfis all" on public.rfis;

create policy "Office rfis all" on public.rfis for all
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

-- ── 11. blueprints ──────────────────────────────────────────────────────────
-- blueprints previously had ONLY a delete policy (RLS off). Office/admin manage
-- them; crew assigned to the job + the owning customer may read.
drop policy if exists "office_delete_blueprints_db" on public.blueprints;
drop policy if exists "Office blueprints all" on public.blueprints;
drop policy if exists "Crew blueprints select" on public.blueprints;
drop policy if exists "Customer blueprints select" on public.blueprints;

create policy "Office blueprints all" on public.blueprints for all
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

create policy "Crew blueprints select" on public.blueprints for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs where id = blueprints.job_id and auth.uid() = any(assigned_crew))
  );

create policy "Customer blueprints select" on public.blueprints for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and job_id in (
      select j.id from public.jobs j
      where j.customer_id in (select customer_id from public.profiles where id = auth.uid())
    )
  );

-- ── 12. job_views ───────────────────────────────────────────────────────────
drop policy if exists "Users manage own views" on public.job_views;
drop policy if exists "office_delete_job_views" on public.job_views;

create policy "Users manage own views" on public.job_views for all
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
  )
  with check (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
  );

create policy "office_delete_job_views" on public.job_views for delete
  to authenticated
  using (public.tier_office(organization_id));

-- ── 13. time_entries ────────────────────────────────────────────────────────
drop policy if exists "office time_all" on public.time_entries;
drop policy if exists "crew time_select_own" on public.time_entries;
drop policy if exists "crew time_insert_own" on public.time_entries;
drop policy if exists "crew time_update_own" on public.time_entries;
drop policy if exists "crew time_delete_own" on public.time_entries;

create policy "office time_all" on public.time_entries for all
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

create policy "crew time_select_own" on public.time_entries for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
  );

create policy "crew time_insert_own" on public.time_entries for insert
  to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
    and exists (select 1 from public.jobs j where j.id = job_id and auth.uid() = any(j.assigned_crew))
  );

create policy "crew time_update_own" on public.time_entries for update
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
  )
  with check (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
  );

create policy "crew time_delete_own" on public.time_entries for delete
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and user_id = auth.uid()
  );

-- ── 14. receipts ────────────────────────────────────────────────────────────
drop policy if exists "office_receipts_all" on public.receipts;
drop policy if exists "crew_receipts_select" on public.receipts;
drop policy if exists "crew_receipts_insert" on public.receipts;
drop policy if exists "crew_receipts_delete_own" on public.receipts;

create policy "office_receipts_all" on public.receipts for all
  to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

create policy "crew_receipts_select" on public.receipts for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs j where j.id = receipts.job_id and auth.uid() = any(j.assigned_crew))
  );

create policy "crew_receipts_insert" on public.receipts for insert
  to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs j where j.id = receipts.job_id and auth.uid() = any(j.assigned_crew))
  );

create policy "crew_receipts_delete_own" on public.receipts for delete
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and uploaded_by = auth.uid()
  );

-- ── 15. quotes ──────────────────────────────────────────────────────────────
drop policy if exists "office_quotes_all" on public.quotes;
drop policy if exists "crew_quotes_select" on public.quotes;
drop policy if exists "customer_quotes_select" on public.quotes;

create policy "office_quotes_all" on public.quotes for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "crew_quotes_select" on public.quotes for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs j where j.id = quotes.job_id and auth.uid() = any(j.assigned_crew))
  );

create policy "customer_quotes_select" on public.quotes for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
  );

-- ── 16. quote_line_items ───────────────────────────────────────────────────
drop policy if exists "office_quote_line_items_all" on public.quote_line_items;
drop policy if exists "crew_quote_line_items_select" on public.quote_line_items;
drop policy if exists "customer_quote_line_items_select" on public.quote_line_items;

create policy "office_quote_line_items_all" on public.quote_line_items for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "crew_quote_line_items_select" on public.quote_line_items for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.quotes q
      join public.jobs j on j.id = q.job_id
      where q.id = quote_line_items.quote_id and auth.uid() = any(j.assigned_crew)
    )
  );

create policy "customer_quote_line_items_select" on public.quote_line_items for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.quotes q
      where q.id = quote_line_items.quote_id
        and q.customer_id in (select customer_id from public.profiles where id = auth.uid())
    )
  );

-- ── 17. invoices ────────────────────────────────────────────────────────────
drop policy if exists "office_invoices_all" on public.invoices;
drop policy if exists "customer_invoices_select" on public.invoices;

create policy "office_invoices_all" on public.invoices for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "customer_invoices_select" on public.invoices for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
  );

-- ── 18. invoice_line_items ─────────────────────────────────────────────────
drop policy if exists "office_invoice_line_items_all" on public.invoice_line_items;
drop policy if exists "customer_invoice_line_items_select" on public.invoice_line_items;

create policy "office_invoice_line_items_all" on public.invoice_line_items for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "customer_invoice_line_items_select" on public.invoice_line_items for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_line_items.invoice_id
        and i.customer_id in (select customer_id from public.profiles where id = auth.uid())
    )
  );

-- ── 19. estimates ───────────────────────────────────────────────────────────
drop policy if exists "office_estimates_all" on public.estimates;
drop policy if exists "crew_estimates_select" on public.estimates;

create policy "office_estimates_all" on public.estimates for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "crew_estimates_select" on public.estimates for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (select 1 from public.jobs j where j.id = estimates.job_id and auth.uid() = any(j.assigned_crew))
  );

-- ── 20. estimate_line_items ────────────────────────────────────────────────
drop policy if exists "office_estimate_items_all" on public.estimate_line_items;
drop policy if exists "crew_estimate_items_select" on public.estimate_line_items;

create policy "office_estimate_items_all" on public.estimate_line_items for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

create policy "crew_estimate_items_select" on public.estimate_line_items for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = estimate_line_items.estimate_id and auth.uid() = any(j.assigned_crew)
    )
  );

-- ============================================================================
-- 21. STORAGE helpers — extend with same_org (super_admin bypass)
-- ============================================================================
-- Path convention is <jobId>/<filename> for job-photos / receipts / blueprints,
-- and <subcontractorId>/<filename> for subcontractor-files. The helpers split
-- the id off the path and look up the parent's org, then require same_org.
-- create or replace preserves grants + avoids disturbing the storage policies
-- that already reference these (the policies are themselves rewritten below).
create or replace function public.storage_caller_assigned_to_job(p_name text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.jobs
    where id::text = split_part(p_name, '/', 1)
      and auth.uid() = any(assigned_crew)
      and public.same_org(auth.uid(), organization_id)
  );
$$;

create or replace function public.storage_caller_owns_job(p_name text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.jobs
    where id::text = split_part(p_name, '/', 1)
      and customer_id in (select customer_id from public.profiles where id = auth.uid())
      and public.same_org(auth.uid(), organization_id)
  );
$$;

-- Convenience: the org of the job encoded in a <jobId>/... storage path.
-- Returns null when the job isn't found (so tier_*(null) is false → rejected).
create or replace function public.storage_job_org(p_name text)
returns uuid
language sql security definer set search_path = public stable
as $$
  select organization_id from public.jobs where id::text = split_part(p_name, '/', 1);
$$;

create or replace function public.storage_sub_org(p_name text)
returns uuid
language sql security definer set search_path = public stable
as $$
  select organization_id from public.subcontractors where id::text = split_part(p_name, '/', 1);
$$;

-- ── 22. STORAGE policies — job-photos bucket ───────────────────────────────
drop policy if exists "Crew upload photos" on storage.objects;
create policy "Crew upload photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos' and public.storage_caller_assigned_to_job(name)
  );

drop policy if exists "Office upload photos" on storage.objects;
create policy "Office upload photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos' and public.tier_office(public.storage_job_org(name))
  );

drop policy if exists "Authenticated read job-photos" on storage.objects;
create policy "Authenticated read job-photos" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'job-photos' and (
      public.tier_office(public.storage_job_org(name))
      or public.storage_caller_assigned_to_job(name)
      or public.storage_caller_owns_job(name)
    )
  );

drop policy if exists "office_delete_job_photos" on storage.objects;
create policy "office_delete_job_photos" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'job-photos' and public.tier_office(public.storage_job_org(name))
  );

-- ── 23. STORAGE policies — blueprints bucket ───────────────────────────────
drop policy if exists "Office upload blueprints" on storage.objects;
create policy "Office upload blueprints" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'blueprints' and public.tier_office(public.storage_job_org(name))
  );

drop policy if exists "Authenticated read blueprints" on storage.objects;
create policy "Authenticated read blueprints" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'blueprints' and (
      public.tier_office(public.storage_job_org(name))
      or public.storage_caller_assigned_to_job(name)
      or public.storage_caller_owns_job(name)
    )
  );

drop policy if exists "Office delete blueprints" on storage.objects;
create policy "Office delete blueprints" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'blueprints' and public.tier_office(public.storage_job_org(name))
  );

-- ── 24. STORAGE policies — receipts bucket ─────────────────────────────────
drop policy if exists "Office all receipts storage" on storage.objects;
create policy "Office all receipts storage" on storage.objects for all
  to authenticated
  using (
    bucket_id = 'receipts' and public.tier_office(public.storage_job_org(name))
  )
  with check (
    bucket_id = 'receipts' and public.tier_office(public.storage_job_org(name))
  );

drop policy if exists "Crew read receipts storage" on storage.objects;
create policy "Crew read receipts storage" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'receipts' and (
      public.tier_office(public.storage_job_org(name))
      or public.storage_caller_assigned_to_job(name)
    )
  );

drop policy if exists "Crew upload receipts storage" on storage.objects;
create policy "Crew upload receipts storage" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'receipts' and public.storage_caller_assigned_to_job(name)
  );

drop policy if exists "Crew delete receipts storage" on storage.objects;
create policy "Crew delete receipts storage" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'receipts' and public.storage_caller_assigned_to_job(name)
  );

-- ── 25. STORAGE policies — subcontractor-files bucket ──────────────────────
-- Path is <subcontractorId>/<filename>; org comes from the subcontractor row.
drop policy if exists "Office all subcontractor-files storage" on storage.objects;
create policy "Office all subcontractor-files storage" on storage.objects for all
  to authenticated
  using (
    bucket_id = 'subcontractor-files' and public.tier_office_or_pm(public.storage_sub_org(name))
  )
  with check (
    bucket_id = 'subcontractor-files' and public.tier_office_or_pm(public.storage_sub_org(name))
  );

drop policy if exists "Management read subcontractor-files storage" on storage.objects;
create policy "Management read subcontractor-files storage" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'subcontractor-files'
      and public.is_management(auth.uid())
      and not public.is_office_or_pm(auth.uid())
      and not public.is_super_admin(auth.uid())
      and public.same_org(auth.uid(), public.storage_sub_org(name))
  );

-- Defensive: drop the old public-read policies if they somehow still exist.
drop policy if exists "Public read photos" on storage.objects;
drop policy if exists "Public read blueprints" on storage.objects;

-- ============================================================================
-- 26. RPC in-body org checks (SECURITY DEFINER → bypass RLS, so check inside)
-- ============================================================================
-- Each RPC already authorizes by role / customer ownership; we add a same_org
-- check so a caller in org A can't act on a job/quote/estimate in org B.
-- super_admin is admitted via same_org's bypass.

create or replace function public.assign_job_crew(p_job_id uuid, p_crew uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if not (public.is_office_or_pm(auth.uid()) or public.is_super_admin(auth.uid())) then
    raise exception 'Not authorized to assign crew';
  end if;

  select organization_id into v_org from public.jobs where id = p_job_id;
  if v_org is null then
    raise exception 'Job not found';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: job belongs to another organization';
  end if;

  update public.jobs set assigned_crew = p_crew where id = p_job_id;
end;
$$;
grant execute on function public.assign_job_crew(uuid, uuid[]) to authenticated;

create or replace function public.approve_quote(p_quote_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_customer_id uuid;
  v_job_id       uuid;
  v_org          uuid;
  v_invoice_id   uuid;
begin
  -- Resolve the quote (owner + org).
  select q.customer_id, q.job_id, q.organization_id
    into v_customer_id, v_job_id, v_org
  from public.quotes q
  where q.id = p_quote_id;

  if v_customer_id is null then
    raise exception 'Quote not found';
  end if;

  -- Caller must be the owning customer AND in the same org.
  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to approve this quote';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: quote belongs to another organization';
  end if;

  if not exists (select 1 from public.quotes where id = p_quote_id and status = 'sent') then
    raise exception 'Quote is not awaiting approval';
  end if;

  if exists (select 1 from public.invoices where quote_id = p_quote_id) then
    raise exception 'Quote already approved';
  end if;

  update public.quotes
  set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_quote_id;

  -- The invoice inherits the quote's org via the trg_invoices_org trigger
  -- (it copies from the job), and line items inherit from the invoice.
  insert into public.invoices (quote_id, job_id, customer_id, status)
  values (p_quote_id, v_job_id, v_customer_id, 'sent')
  returning id into v_invoice_id;

  insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
  select v_invoice_id, description, quantity, unit_price, position
  from public.quote_line_items
  where quote_id = p_quote_id
  order by position;

  return v_invoice_id;
end;
$$;
grant execute on function public.approve_quote(uuid) to authenticated;

create or replace function public.reject_quote(p_quote_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_customer_id uuid;
  v_org         uuid;
begin
  select q.customer_id, q.organization_id
    into v_customer_id, v_org
  from public.quotes q
  where q.id = p_quote_id;

  if v_customer_id is null then
    raise exception 'Quote not found';
  end if;

  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to reject this quote';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: quote belongs to another organization';
  end if;

  if not exists (select 1 from public.quotes where id = p_quote_id and status = 'sent') then
    raise exception 'Quote is not awaiting action';
  end if;

  update public.quotes
  set status = 'rejected', rejected_at = now(), updated_at = now()
  where id = p_quote_id;
end;
$$;
grant execute on function public.reject_quote(uuid) to authenticated;

create or replace function public.convert_estimate_to_quote(p_estimate_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_job_id      uuid;
  v_customer_id uuid;
  v_created_by  uuid;
  v_org         uuid;
  v_quote_id    uuid;
begin
  if not (public.is_office(auth.uid()) or public.is_super_admin(auth.uid())) then
    raise exception 'Not authorized: office only';
  end if;

  select e.job_id, e.created_by, j.customer_id, e.organization_id
    into v_job_id, v_created_by, v_customer_id, v_org
  from public.estimates e
  left join public.jobs j on j.id = e.job_id
  where e.id = p_estimate_id;

  if v_job_id is null then
    raise exception 'Estimate not found';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: estimate belongs to another organization';
  end if;

  -- trg_quotes_org copies org from the job; line items inherit from the quote.
  insert into public.quotes (job_id, customer_id, status, created_by)
  values (v_job_id, v_customer_id, 'draft', v_created_by)
  returning id into v_quote_id;

  insert into public.quote_line_items (quote_id, description, quantity, unit_price, cost_code_id, position)
  select
    v_quote_id,
    coalesce(e.description, cc.name, ''),
    e.quantity,
    e.unit_price,
    e.cost_code_id,
    row_number() over (order by e.created_at) - 1
  from public.estimate_line_items e
  left join public.cost_codes cc on cc.id = e.cost_code_id
  where e.estimate_id = p_estimate_id;

  update public.estimates set status = 'converted' where id = p_estimate_id;

  return v_quote_id;
end;
$$;
grant execute on function public.convert_estimate_to_quote(uuid) to authenticated;

-- ============================================================================
-- 27. NOT NULL on the 18 business tables + profiles CHECK
-- ============================================================================
-- profiles stays nullable (super_admin has null org); the CHECK ties super_admin
-- to a null org and every other role to a non-null org. NOT NULL on the 18
-- business tables — will fail if any row still has null org, which means a root
-- insert path skipped organization_id (fix the app before re-running).
alter table public.jobs                   alter column organization_id set not null;
alter table public.customers              alter column organization_id set not null;
alter table public.cost_codes             alter column organization_id set not null;
alter table public.subcontractors         alter column organization_id set not null;
alter table public.photos                 alter column organization_id set not null;
alter table public.rfis                   alter column organization_id set not null;
alter table public.blueprints             alter column organization_id set not null;
alter table public.job_views              alter column organization_id set not null;
alter table public.time_entries           alter column organization_id set not null;
alter table public.receipts               alter column organization_id set not null;
alter table public.quotes                 alter column organization_id set not null;
alter table public.quote_line_items       alter column organization_id set not null;
alter table public.invoices               alter column organization_id set not null;
alter table public.invoice_line_items     alter column organization_id set not null;
alter table public.estimates              alter column organization_id set not null;
alter table public.estimate_line_items    alter column organization_id set not null;
alter table public.job_subcontractors     alter column organization_id set not null;
alter table public.subcontractor_attachments alter column organization_id set not null;

alter table public.profiles drop constraint if exists profiles_org_check;
alter table public.profiles add constraint profiles_org_check check (
  (role = 'super_admin' and organization_id is null)
  or (role <> 'super_admin' and organization_id is not null)
);

-- ============================================================================
-- 28. Create the platform super_admin (RUN MANUALLY, ONCE — by the app owner)
-- ============================================================================
-- Uncomment & edit the email, then run JUST this statement in the SQL Editor.
-- This account has null organization_id → is_super_admin() returns true → it
-- bypasses same_org everywhere and sees ALL orgs in the platform view.
--
-- update public.profiles
--   set role = 'super_admin', organization_id = null
--   where email = '<app-owner-email>';
--
-- After this, set SAAS_OPEN=true in the app env so /api/signup stops returning
-- 503 and new businesses can self-serve sign up.

-- ============================================================================
-- 29. Verification queries (run in the SQL Editor after this file succeeds)
-- ============================================================================
-- Every business table should have at least one policy referencing same_org or
-- a tier_ helper. Any row below WITHOUT such a policy is a leak — fix it.
--
--   select tablename, policyname
--   from pg_policies
--   where schemaname = 'public'
--     and (qualifier ilike '%same_org%' or qualifier ilike '%tier_%'
--          or with_check ilike '%same_org%' or with_check ilike '%tier_%')
--   order by tablename;
--
-- Confirm no orphaned permissive dashboard policies remain (e.g. on jobs/rfis/
-- blueprints) that bypass org scoping:
--
--   select tablename, policyname, qualifier, with_check
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('jobs','rfis','blueprints')
--     and (qualifier is distinct from null and qualifier not ilike '%same_org%'
--         or with_check is distinct from null and with_check not ilike '%same_org%');
--
-- Confirm NOT NULL + the profiles CHECK landed:
--
--   select column_name, is_nullable from information_schema.columns
--   where table_schema='public' and column_name='organization_id'
--   order by table_name;
--   select conname from pg_constraint where conname='profiles_org_check';
-- ============================================================================