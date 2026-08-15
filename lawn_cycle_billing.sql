-- Lawn Phase 2: monthly cycle billing. Marks each lawn visit with the invoice
-- it was billed on so a completed visit is never double-invoiced. The billing
-- run (on-demand office route + nightly cron) gathers status='done' visits with
-- invoice_id IS NULL, creates ONE invoice per customer per run with one line
-- per visit, then sets invoice_id on the claimed visits (claim-then-line, so
-- concurrent runs can't double-bill).
--
-- Additive + idempotent. No CHECKs, no RPCs, no DROP COLUMN/TABLE. Re-runnable.

alter table public.lawn_visits
  add column if not exists invoice_id uuid references public.invoices(id) on delete set null;

-- Speeds the "done but unbilled" query the billing run + preview page use.
create index if not exists idx_lawn_visits_unbilled
  on public.lawn_visits(organization_id)
  where status = 'done' and invoice_id is null;