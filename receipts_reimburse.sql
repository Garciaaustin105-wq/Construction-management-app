-- Receipts enhancements: record the uploader's name + a paid-back (reimbursed) flag.
-- Run this in the Supabase dashboard SQL Editor (idempotent).
--
-- Why denormalize uploaded_by_name: profiles RLS only lets a user read their
-- OWN profile (office can read all). Crew can't resolve a coworker's name via
-- a join, so we store the uploader's name on the receipt row at share time.
-- Existing rows are backfilled below.

-- 1. New columns
alter table public.receipts
  add column if not exists uploaded_by_name text,
  add column if not exists reimbursed boolean not null default false,
  add column if not exists reimbursed_at timestamptz;

-- 2. Backfill uploader names for receipts already shared before this change
update public.receipts r
set uploaded_by_name = p.full_name
from public.profiles p
where r.uploaded_by = p.id
  and r.uploaded_by_name is null;

-- 3. RLS note (no new policies needed):
--    - Office can update receipts (incl. reimbursed) via the existing
--      "office_receipts_all" policy (for all).
--    - Crew has select/insert/delete-own but NO update policy, so crew
--      cannot toggle reimbursed — only office can.
--    - Crew can read uploaded_by_name and reimbursed (select returns all cols).