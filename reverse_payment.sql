-- reverse_payment.sql
-- ----------------------------------------------------------------------------
-- §1.5 Payment reversal (soft-reverse). A recorded offline payment (cash /
-- check / other) can be reversed by the office when it was recorded in error
-- (e.g. a bounced check, a duplicate, a wrong amount). The reversal is a
-- CORRECTING record, NOT a hard delete — the original payment row stays in the
-- ledger for audit; we stamp reversed_at / reversed_by / reversal_reason on it
-- and adjust invoices.amount_paid back down.
--
-- Why mark-in-place (not a separate reversal row): the original row IS the
-- record. One row = one reversal, no self-FK join, trivial list query
-- (`reversed_at is null` = active). This mirrors how real ledgers void a
-- journal entry (mark, don't delete) and keeps `sum(payments.amount) where
-- reversed_at is null` == invoices.amount_paid after the adjustment.
--
-- Why a SECURITY DEFINER RPC (not a client delete-then-update): the payment-row
-- marking and the invoices.amount_paid adjustment MUST be atomic. Doing them as
-- two separate client writes races under two concurrent reversals of the SAME
-- payment — the optimistic-concurrency loop on invoices.amount_paid would
-- re-subtract on retry (double-reversal). FOR UPDATE locks on both rows inside
-- one transaction make exactly one reversal win; the second raises
-- 'Payment already reversed'. (Same atomicity argument as
-- replace_draft_invoice_line_items.)
--
-- Security: SECURITY DEFINER + org re-check (WHERE organization_id = p_org_id)
— the function bypasses RLS, so it must enforce org itself. Execute is revoked
-- from anon AND authenticated so only the service-role route (office-gated)
-- can call it — a same-org crew member cannot bypass the route's office gate.
-- ----------------------------------------------------------------------------

alter table public.payments
  add column if not exists reversed_at    timestamptz,
  add column if not exists reversed_by    uuid references public.profiles(id) on delete set null,
  add column if not exists reversal_reason text;

-- Index active (non-reversed) payments per invoice — the common list query.
create index if not exists payments_invoice_active_idx
  on public.payments(invoice_id) where reversed_at is null;

-- ----------------------------------------------------------------------------
-- reverse_payment(p_payment_id, p_org_id, p_reason, p_reversed_by)
--   Marks the payment reversed + adjusts invoices.amount_paid DOWN by the
--   payment's amount. If the reversal drops the balance below the invoice
--   total, a `paid` invoice is re-opened to `sent` (paid_at cleared). A `void`
--   invoice's payments can't be reversed (void is terminal). amount_paid is
--   never driven below 0.
--   Returns (new_amount_paid, new_status, new_balance_due).
-- ----------------------------------------------------------------------------
create or replace function public.reverse_payment(
  p_payment_id  uuid,
  p_org_id      uuid,
  p_reason      text,
  p_reversed_by uuid
) returns table(
  new_amount_paid  numeric(12,2),
  new_status       text,
  new_balance_due  numeric(12,2)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id  uuid;
  v_amount      numeric(12,2);
  v_reversed_at timestamptz;
  v_status      text;
  v_amount_paid numeric(12,2);
  v_paid_at     timestamptz;
  v_total       numeric(12,2) := 0;
  v_new_paid    numeric(12,2);
  v_still_paid  boolean;
  v_new_status  text;
begin
  -- Lock the payment row (same-org). FOR UPDATE prevents a concurrent
  -- reversal from racing us; the second caller finds reversed_at set and
  -- raises below.
  select p.invoice_id, p.amount, p.reversed_at
    into v_invoice_id, v_amount, v_reversed_at
    from public.payments p
    where p.id = p_payment_id and p.organization_id = p_org_id
    for update;

  if not found then
    raise exception 'Payment not found';
  end if;
  if v_reversed_at is not null then
    raise exception 'Payment already reversed';
  end if;

  -- Lock the invoice row. amount_paid is adjusted here.
  select i.status, i.amount_paid, i.paid_at
    into v_status, v_amount_paid, v_paid_at
    from public.invoices i
    where i.id = v_invoice_id
    for update;

  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_status = 'void' then
    raise exception 'Cannot reverse a payment on a void invoice';
  end if;

  -- Recompute the invoice total from line items (never trust a stored copy).
  select coalesce(sum(li.quantity * li.unit_price), 0)
    into v_total
    from public.invoice_line_items li
    where li.invoice_id = v_invoice_id;

  v_new_paid   := greatest(0, coalesce(v_amount_paid, 0) - v_amount);
  v_still_paid := (v_total > 0 and v_new_paid >= v_total);
  v_new_status := case when v_still_paid then 'paid' else 'sent' end;

  -- Adjust the invoice summary. paid_at is cleared when re-opening to sent;
  -- left untouched when still paid (a partial reversal of an overpaid invoice
  -- stays paid). updated_at bumped for cache invalidation.
  update public.invoices
    set amount_paid = v_new_paid,
        status      = v_new_status,
        paid_at     = case when v_still_paid then paid_at else null end,
        updated_at  = now()
    where id = v_invoice_id;

  -- Mark the payment reversed (the source-of-truth flag). Same transaction as
  -- the invoice adjustment, so they can never diverge.
  update public.payments
    set reversed_at    = now(),
        reversed_by    = p_reversed_by,
        reversal_reason = p_reason
    where id = p_payment_id;

  return query
    select v_new_paid::numeric(12,2),
           v_new_status::text,
           greatest(0, v_total - v_new_paid)::numeric(12,2);
end;
$$;

-- Harden: only the service role (the office-gated route) can call this. anon
-- and authenticated (PUBLIC default grant) revoked.
revoke execute on function public.reverse_payment(uuid, uuid, text, uuid) from anon, public;
revoke execute on function public.reverse_payment(uuid, uuid, text, uuid) from authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   select p.rolname, has_function_privilege(p.oid, 'public.reverse_payment(uuid,uuid,text,uuid)', 'EXECUTE')
--   from pg_roles p
--   where p.rolname in ('anon','authenticated','service_role');
--   Expect: anon=false, authenticated=false, service_role=true.
--
--   select column_name, data_type from information_schema.columns
--   where table_schema='public' and table_name='payments'
--   and column_name in ('reversed_at','reversed_by','reversal_reason');
-- ----------------------------------------------------------------------------