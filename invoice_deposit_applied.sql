-- Terra Vista — Auto-apply the estimate deposit as a payment on the invoice.
-- Today an invoice is binary (sent / paid). When a customer approves an
-- estimate that has a deposit, the deposit was only shown on the estimate
-- ("Deposit due" / "Balance due") and was NOT reflected on the generated
-- invoice — so the invoice appeared to demand the full grand total even
-- though a deposit was already collected. The office had to remember to
-- record it manually, which was easy to miss.
--
-- This adds an `amount_paid` column to invoices (a running partial-payment
-- total) and seeds it with the deposit on approval (both approve_estimate RPC
-- and the public /api/estimates/by-token/[token]/decide route). The invoice
-- stays status='sent' (not fully paid); the detail page shows
-- "Paid so far / Balance due = grand total − amount_paid". Marking the
-- invoice fully paid later (the existing Mark Paid button) flips status='paid'.
--
-- Run BEFORE deploy (additive; idempotent). Paste from a text editor (Notepad)
-- — the terminal mangles multi-line SQL. Single-quoted literals only.
-- ============================================================================

-- 1. Running partial-payment total on an invoice. 0 = nothing paid yet; seeded
--    with the deposit on approval. Stays 0 for estimates with no deposit.
alter table public.invoices add column if not exists amount_paid numeric(12,2) not null default 0;

-- 2. Rewrite approve_estimate to also seed amount_paid with the deposit.
--    Deposit = explicit dollar amount when > 0, else % of the grand total
--    (subtotal + markup + contingency + tax) — same math as the estimate doc.
--    The base + pricing-summary invoice line items are unchanged; only the
--    invoice INSERT now carries amount_paid. (Deposit is never an invoice
--    LINE — it's a payment against the full grand-total invoice.)
create or replace function public.approve_estimate(p_estimate_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer_id    uuid;
  v_job_id         uuid;
  v_org            uuid;
  v_invoice_id     uuid;
  v_subtotal       numeric(12,2) := 0;
  v_markup_pct     numeric(5,2)  := 0;
  v_cont_pct       numeric(5,2)  := 0;
  v_tax_pct        numeric(5,2)  := 0;
  v_markup_amt     numeric(12,2) := 0;
  v_cont_amt       numeric(12,2) := 0;
  v_pretax         numeric(12,2) := 0;
  v_tax_amt        numeric(12,2) := 0;
  v_grand_total    numeric(12,2) := 0;
  v_deposit_pct    numeric(5,2)  := 0;
  v_deposit_amt    numeric(12,2) := 0;
  v_deposit        numeric(12,2) := 0;
  v_pos            integer       := 0;
begin
  select e.customer_id, e.job_id, e.organization_id,
         coalesce(e.markup_pct, 0), coalesce(e.contingency_pct, 0), coalesce(e.tax_pct, 0),
         coalesce(e.deposit_pct, 0), coalesce(e.deposit_amount, 0)
    into v_customer_id, v_job_id, v_org, v_markup_pct, v_cont_pct, v_tax_pct,
         v_deposit_pct, v_deposit_amt
  from public.estimates e
  where e.id = p_estimate_id;

  if v_customer_id is null then
    raise exception 'Estimate not found';
  end if;

  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to approve this estimate';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: estimate belongs to another organization';
  end if;

  if not exists (select 1 from public.estimates where id = p_estimate_id and status = 'sent') then
    raise exception 'Estimate is not awaiting approval';
  end if;

  if exists (select 1 from public.invoices where estimate_id = p_estimate_id) then
    raise exception 'Estimate already approved';
  end if;

  update public.estimates
  set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_estimate_id;

  -- Deposit = explicit $ when > 0, else % of the grand total. Computed here
  -- (before the invoice insert) so the generated invoice carries amount_paid.
  select coalesce(sum(e.quantity * e.unit_price), 0) into v_subtotal
  from public.estimate_line_items e
  where e.estimate_id = p_estimate_id;

  if v_markup_pct > 0 then
    v_markup_amt := round(v_subtotal * v_markup_pct / 100.0, 2);
  end if;
  if v_cont_pct > 0 then
    v_cont_amt := round(v_subtotal * v_cont_pct / 100.0, 2);
  end if;
  v_pretax := v_subtotal + v_markup_amt + v_cont_amt;
  if v_tax_pct > 0 then
    v_tax_amt := round(v_pretax * v_tax_pct / 100.0, 2);
  end if;
  v_grand_total := v_pretax + v_tax_amt;

  if v_deposit_amt > 0 then
    v_deposit := round(v_deposit_amt, 2);
  elsif v_deposit_pct > 0 then
    v_deposit := round(v_grand_total * v_deposit_pct / 100.0, 2);
  end if;

  -- trg_invoices_org stamps organization_id from the job (or the parent
  -- estimate for standalone, job-less estimates). amount_paid seeds the
  -- deposit so the invoice balance reflects it without a manual step.
  insert into public.invoices (estimate_id, job_id, customer_id, status, amount_paid)
  values (p_estimate_id, v_job_id, v_customer_id, 'sent', v_deposit)
  returning id into v_invoice_id;

  -- Base line items (explicit 4-column snapshot — new columns don't leak).
  insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
  select
    v_invoice_id,
    coalesce(e.description, cc.name, ''),
    e.quantity,
    e.unit_price,
    e.position
  from public.estimate_line_items e
  left join public.cost_codes cc on cc.id = e.cost_code_id
  where e.estimate_id = p_estimate_id
  order by e.position;

  -- Pricing-summary lines so invoice total == estimate grand total.
  select coalesce(max(position), 0) into v_pos
  from public.invoice_line_items
  where invoice_id = v_invoice_id;

  if v_markup_pct > 0 then
    v_pos := v_pos + 1;
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Overhead & Profit (' || v_markup_pct || '%)', 1, v_markup_amt, v_pos);
  end if;

  if v_cont_pct > 0 then
    v_pos := v_pos + 1;
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Contingency (' || v_cont_pct || '%)', 1, v_cont_amt, v_pos);
  end if;

  if v_tax_pct > 0 then
    v_pos := v_pos + 1;
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Sales Tax (' || v_tax_pct || '%)', 1, v_tax_amt, v_pos);
  end if;

  return v_invoice_id;
end;
$$;
grant execute on function public.approve_estimate(uuid) to authenticated;