-- ============================================================================
-- Terra Vista — Budget vs Actual (the "actuals" half of cost codes).
-- Run ONCE in the Supabase dashboard SQL Editor (paste from Notepad). Idempotent.
--
-- What this adds:
--   1. cost_code_id on receipts — so a shared expense can be tagged against a
--      cost code and roll up into the per-code actuals. Nullable; existing
--      receipts are unaffected (untagged receipts land in an "Uncoded" bucket).
--   2. labor_rate on jobs — office-configurable blended burdened labor rate
--      ($/hr) used to convert crew time-entry hours into a labor dollar cost
--      for budget-vs-actual. Nullable; if unset, hours are shown but not priced.
--
-- No new RLS needed: receipts RLS already allows office all + crew insert for
-- assigned jobs (the new column rides on the existing insert policy); jobs
-- UPDATE is already office-only (so the office client can set labor_rate).
-- ============================================================================

-- 1. Tag receipts against a cost code (optional). --------------------------
alter table public.receipts
  add column if not exists cost_code_id uuid
  references public.cost_codes(id) on delete set null;

create index if not exists receipts_cost_code_id_idx
  on public.receipts(cost_code_id);

-- 2. Per-job blended labor rate ($/hr) for converting time → dollars. -------
alter table public.jobs
  add column if not exists labor_rate numeric(10,2);