-- Receipts: extra accounting rows for cleaner tax records.
-- Run in the Supabase dashboard SQL Editor.
-- All optional; existing receipts simply have nulls here until re-edited.

alter table public.receipts
  add column if not exists category       text,            -- Materials / Fuel / Tools / Travel / Meals / Permits / Other
  add column if not exists tax             numeric(10,2),   -- sales tax, for accounting
  add column if not exists payment_method  text,            -- Cash / Personal Card / Company Card / Account
  add column if not exists receipt_no      text;            -- vendor receipt / reference number