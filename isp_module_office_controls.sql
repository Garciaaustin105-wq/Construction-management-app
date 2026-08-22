-- ISP installs module — office controls columns.
-- Adds the fields the office needs on an install that the original schema
-- (isp_module.sql) didn't carry: priority, a PO / reference number, and a
-- per-site contact (name + phone) that can default from the chosen customer.
--
-- Run in Supabase SQL Editor. Idempotent (add column if not exists).
-- No RLS change required: office writes already go through the
-- `office_manage_installs` policy (tier_office_or_pm, UPDATE any column), and
-- crew never UPDATE installs directly (their writes are the field RPCs). Crew
-- read policies carry the new columns along automatically. priority defaults
-- to 'normal' so existing rows are backfilled.
--
-- Verify live after running:
--   select column_name from information_schema.columns
--   where table_name='installs' and column_name in
--     ('priority','po_number','site_contact_name','site_contact_phone')
--   order by column_name;  -- expect 4 rows

alter table installs add column if not exists priority text default 'normal';
alter table installs add column if not exists po_number text;
alter table installs add column if not exists site_contact_name text;
alter table installs add column if not exists site_contact_phone text;