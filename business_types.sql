-- business_types.sql
-- ----------------------------------------------------------------------------
-- Feature 0 — what kind of business is this org?
--
-- THE PROBLEM THIS SOLVES
-- The platform already has TWO gating mechanisms and neither can express
-- "a construction company that also runs fiber":
--
--   * `organizations.app_variant` ∈ {construction, lawn} — BUILD-TIME, per
--     deploy. It answers "which app did they sign up through", is read by the
--     proxy to block cross-variant routes, and is single-valued by nature. It
--     is NOT a description of the business.
--   * `organizations.isp_module_enabled` — a per-ORG boolean for one module.
--
-- Terra Vista is a construction org that also does fiber, so business type
-- cannot be a third value of app_variant without breaking the deploy split.
-- This adds an additive, multi-valued, runtime attribute instead.
--
-- ARRAY COLUMN, NOT A JOIN TABLE — and the reason matters:
-- the alternative design was an `organization_business_types` join table. It's
-- more normalized, but business type is read on essentially every page load
-- (nav composition), and the org row is ALREADY fetched there by
-- `get_my_tenant()`. A column rides that existing read for free; a join table
-- adds a query to the single hottest path in the app. Values are a closed set
-- of three, so the normalization buys nothing we'd use.
--
-- NOTE FOR WHOEVER WIRES NAV TO THIS: `get_my_tenant()` has a fixed
-- `returns table(...)` signature and does NOT yet return business_types.
-- Adding it there requires DROP + CREATE of that function (a return-type change
-- can't use CREATE OR REPLACE), which is surgery on the login path. It was
-- deliberately left alone here because nothing in Feature 0/1 needs it yet —
-- read business types with the helper in src/lib/businessTypes.ts instead. Do
-- the RPC change as its own migration, when nav actually branches on this.
--
-- Idempotent + additive. Safe to re-run. Run in the Supabase SQL editor —
-- paste from a text editor (Notepad), NOT the web editor.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. The column
-- ============================================================================
-- Default '{}' rather than a guessed value: the backfill in section 3 assigns
-- real values from evidence, and a default that silently looked correct would
-- make it impossible to tell a backfilled org from an unclassified one.

alter table public.organizations
  add column if not exists business_types text[] not null default '{}';


-- ============================================================================
-- 2. Constrain the contents
-- ============================================================================
-- A text[] with no constraint accepts 'consrtuction' forever and you find out
-- when the nav silently drops a tab. `<@` asserts every element is drawn from
-- the allowed set; the cardinality check rejects the empty array so an org
-- always declares something.
--
-- Adding a business type later = extend the ARRAY[...] literal here and re-run.

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_business_types_ck'
  ) then
    alter table public.organizations
      add constraint organizations_business_types_ck
      check (
        business_types <@ array['construction','lawn','isp']::text[]
        and cardinality(business_types) >= 1
      )
      not valid;   -- see section 3: existing rows are '{}' until backfilled
  end if;
end
$do$;


-- ============================================================================
-- 3. Backfill existing orgs, then validate
-- ============================================================================
-- The constraint above is created NOT VALID on purpose: at this moment every
-- existing row holds '{}', which violates the cardinality check. NOT VALID
-- enforces the rule on new/updated rows immediately while tolerating the
-- existing ones, so this file can create the constraint and fix the data in one
-- pass without a window where writes are rejected.
--
-- Evidence used, in order:
--   * app_variant — the variant they signed up through is their primary trade.
--   * isp_module_enabled — an org with the fiber module also does ISP. This is
--     what gives Terra Vista {construction, isp} without naming it here; no
--     hardcoded org id, so it stays correct if the module is enabled elsewhere.

update public.organizations
   set business_types =
         (case when app_variant = 'lawn' then array['lawn'] else array['construction'] end)
         || (case when isp_module_enabled then array['isp'] else array[]::text[] end)
 where cardinality(business_types) = 0;

-- Now that every row conforms, promote the constraint to fully enforced. This
-- re-scans the table once and will ERROR if any row still fails — which is the
-- point: it is the proof that the backfill actually covered everything, rather
-- than a silent partial migration.
alter table public.organizations
  validate constraint organizations_business_types_ck;


-- ============================================================================
-- 4. Index
-- ============================================================================
-- GIN so `business_types @> array['isp']` (find every ISP org) is indexed
-- rather than a sequential scan. Small table today; cheap insurance.

create index if not exists idx_organizations_business_types
  on public.organizations using gin (business_types);


-- ============================================================================
-- NO RLS CHANGES
-- ============================================================================
-- business_types lives on `organizations`, which already has its policies:
-- "Org members read org" (same_org) and "Org admin update org" (role='admin').
-- Members can therefore read their own org's types, and only an org admin can
-- change them — which is the intended permission for this field. Signup writes
-- it with the service role, which bypasses RLS entirely.


-- ============================================================================
-- VERIFY (run after)
-- ============================================================================
-- select column_name, data_type from information_schema.columns
--   where table_name='organizations' and column_name='business_types';   -- 1 row
-- select name, app_variant, isp_module_enabled, business_types
--   from organizations order by name;   -- every row non-empty, ISP org has 'isp'
-- select convalidated from pg_constraint
--   where conname='organizations_business_types_ck';                     -- expect t
