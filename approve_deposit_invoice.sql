-- Terra Vista — deposit-only invoice on construction approval; lawn approves only.
-- ----------------------------------------------------------------------------
-- Redefines public.approve_estimate (the logged-in customer Approve RPC) to
-- match the new auto-send-on-approval model:
--   • Construction job  → a DEPOSIT-ONLY invoice: one line "Deposit to start
--     work" for the deposit amount, status 'sent', amount_paid 0 (the deposit
--     is now OWED to start, not pre-paid). When there's no deposit split
--     (deposit_pct/deposit_amount both 0), fall back to a full-total invoice
--     (all line items + markup/contingency/tax summary lines) so everything is
--     owed to start.
--   • Lawn job (jobs.type = 'lawn') → APPROVE ONLY, return null. Lawn is billed
--     by monthly cycle billing (runCycleBilling), so creating an invoice here
--     would double-bill. The estimate still flips to 'approved'.
--
-- GUARDS are preserved VERBATIM from invoice_deposit_applied.sql (the last live
-- version): owning-customer via profiles.customer_id, same_org, status must be
-- 'sent', no existing invoice. Only the invoice-shape logic changes. The public
-- /api/estimates/by-token/[token]/decide route mirrors this same branching.
--
-- NOTE on amount_paid: the previous version seeded amount_paid = deposit on a
-- FULL-total invoice (deposit shown as a pre-payment). The new deposit-only
-- invoice instead makes the deposit the invoice total itself, so amount_paid is
-- always 0 — the customer owes the deposit, nothing is pre-paid. Existing
-- already-approved estimates keep whatever invoice they already have.
--
-- `create or replace function` — no DROP, passes scripts/check-migrations.mjs.
-- Run AFTER invoice_send.sql (not strictly required — this RPC doesn't touch
-- share_token/sent_at, but run order is columns-first by convention). Paste via
-- Notepad; single-quoted literals only.
-- ============================================================================

create or replace function public.approve_estimate(p_estimate_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer_id    uuid;
  v_job_id         uuid;
  v_org            uuid;
  v_job_type       text;
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
  -- jobs.type via left join (standalone, job-less estimates → null → treated
  -- as construction, which is correct: lawn jobs always have a job_id).
  select e.customer_id, e.job_id, e.organization_id, j.type,
         coalesce(e.markup_pct, 0), coalesce(e.contingency_pct, 0), coalesce(e.tax_pct, 0),
         coalesce(e.deposit_pct, 0), coalesce(e.deposit_amount, 0)
    into v_customer_id, v_job_id, v_org, v_job_type, v_markup_pct, v_cont_pct, v_tax_pct,
         v_deposit_pct, v_deposit_amt
  from public.estimates e
  left join public.jobs j on j.id = e.job_id
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

  -- Flip the estimate to approved regardless of job type.
  update public.estimates
  set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_estimate_id;

  -- Lawn jobs are billed by monthly cycle billing — approving creates NO
  -- invoice (return null) so the customer isn't double-billed.
  if coalesce(v_job_type, 'construction') = 'lawn' then
    return null;
  end if;

  -- Construction: compute the deposit (explicit $ when > 0, else % of grand
  -- total) — same math as the estimate doc + the decide route.
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

  -- Deposit-only invoice: amount_paid 0 (the deposit is owed, not pre-paid).
  -- trg_invoices_org stamps organization_id from the job (or the parent
  -- estimate for standalone, job-less estimates).
  insert into public.invoices (estimate_id, job_id, customer_id, status, amount_paid)
  values (p_estimate_id, v_job_id, v_customer_id, 'sent', 0)
  returning id into v_invoice_id;

  if v_deposit > 0 then
    -- Single deposit line — the invoice total IS the deposit to start work.
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Deposit to start work', 1, v_deposit, 0);
  else
    -- No deposit split → full-total invoice: snapshot the line items + the
    -- pricing-summary lines so the invoice total == estimate grand total.
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
  end if;

  return v_invoice_id;
end;
$$;
grant execute on function public.approve_estimate(uuid) to authenticated;