-- Terra Vista / Terra Verde — accounting provider external ids.
-- ----------------------------------------------------------------------------
-- Stores the bookkeeping provider's stable id for a synced customer / invoice /
-- estimate so re-syncs UPDATE instead of creating duplicates, and read-back
-- (payment status) can find the provider doc. One column per table: an org
-- connects ONE provider at a time (the org admin picks from the shared menu),
-- so a single external-id column is sufficient. Switching providers resets these
-- (the new provider has different ids) — handled by the sync layer on reconnect.
--
-- Additive only (nullable columns, no new constraints). Inherits the table's
-- existing RLS policies — no policy changes. Idempotent. Run in the Supabase
-- SQL editor (paste from a text editor, not the web editor).

alter table public.customers
  add column if not exists accounting_external_id text;
alter table public.invoices
  add column if not exists accounting_external_id text;
alter table public.estimates
  add column if not exists accounting_external_id text;

-- Helpful for "find the QBO doc for this invoice" lookups from the sync layer.
create index if not exists idx_invoices_accounting_ext
  on public.invoices(accounting_external_id)
  where accounting_external_id is not null;
create index if not exists idx_customers_accounting_ext
  on public.customers(accounting_external_id)
  where accounting_external_id is not null;