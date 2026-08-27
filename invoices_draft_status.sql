-- §1.2 (feature-completeness audit): invoices were write-once — created 'sent'
-- in 3 places, never editable, so an office typo was only fixable by void +
-- recreate (leaving the customer with two documents). Add a 'draft' status and
-- make it the default for new invoices. The office "Send" action flips draft→sent
-- via deliverInvoice (which already stamps sent_at); the auto-paths (estimate
-- approve + lawn cycle billing) auto-deliver and flip the same way. Existing
-- rows stay 'sent' (set default only affects future inserts; no backfill).
--
-- Applied live 2026-08-26. Verified before applying: live constraint was
-- `invoices_status_check` CHECK (status in ('sent','paid','void')), default
-- 'sent'. No INSERT omits status (the 3 insert sites all set it explicitly:
-- estimateInvoice.ts, lawnBilling.ts, NewInvoiceForm.tsx), so changing the
-- default cannot silently re-type an existing insert path.

alter table public.invoices
  drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status = any (array['draft'::text, 'sent'::text, 'paid'::text, 'void'::text]));
alter table public.invoices
  alter column status set default 'draft'::text;