-- ============================================================================
-- Terra Vista — Merge quotes → estimates (Phase B: cleanup, run AFTER the new
-- estimate-only app is deployed and verified). Drops the now-unused quote
-- surface. NOT re-runnable past the first success (the drops are idempotent,
-- but the tables are gone once it runs).
--
-- Run in the Supabase dashboard SQL Editor. Paste from a text editor.
-- ============================================================================

-- 1. Drop the quote RLS policies. -------------------------------------------
drop policy if exists "office_quotes_all" on public.quotes;
drop policy if exists "crew_quotes_select" on public.quotes;
drop policy if exists "customer_quotes_select" on public.quotes;
drop policy if exists "office_quote_line_items_all" on public.quote_line_items;
drop policy if exists "crew_quote_line_items_select" on public.quote_line_items;
drop policy if exists "customer_quote_line_items_select" on public.quote_line_items;

-- 2. Drop the quote org-stamping triggers. ----------------------------------
drop trigger if exists trg_quotes_org on public.quotes;
drop trigger if exists trg_quote_line_items_org on public.quote_line_items;

-- 3. Drop the quote RPCs + the now-unused set_org_from_quote helper. --------
drop function if exists public.convert_estimate_to_quote(uuid);
drop function if exists public.approve_quote(uuid);
drop function if exists public.reject_quote(uuid);
drop function if exists public.set_org_from_quote();

-- 4. Drop invoices.quote_id (the new app uses estimate_id). -----------------
-- Dropping the column drops its FK constraint + the partial unique index
-- automatically; the explicit drops are belt-and-suspenders.
drop index if exists invoices_quote_id_unique;
alter table public.invoices drop constraint if exists invoices_quote_id_fkey;
alter table public.invoices drop column if exists quote_id;

-- 5. Drop the quote tables. -------------------------------------------------
drop table if exists public.quote_line_items cascade;
drop table if exists public.quotes cascade;

-- 6. (Optional) tighten estimates.status to drop the legacy 'converted' value.
-- Only run once you're sure no estimate row still has status='converted'
-- (check: select count(*) from estimates where status='converted';). Left
-- commented out to avoid a backfill-data conflict.
-- alter table public.estimates drop constraint if exists estimates_status_check;
-- alter table public.estimates add constraint estimates_status_check
--   check (status in ('draft','sent','approved','rejected'));