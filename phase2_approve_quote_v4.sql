create or replace function public.approve_quote(p_quote_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_customer_id uuid; v_job_id uuid; v_invoice_id uuid;
begin
  select q.customer_id, q.job_id into v_customer_id, v_job_id
  from public.quotes q where q.id = p_quote_id;
  if v_customer_id is null then raise excep
tion 'Quote not found'; end if;
  if v_customer_id is distinct from (select customer_id from public.profiles where id = auth.uid()) then
    raise excep
tion 'Not authorized';
  end if;
  if not exists (select 1 from public.quotes where id = p_quote_id and status = 'sent') then
    raise excep
tion 'Quote not awaiting approval';
  end if;
  if exists (select 1 from public.invoices where quote_id = p_quote_id) then
    raise excep
tion 'Already approved';
  end if;
  update public.quotes set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_quote_id;
  insert into public.invoices (quote_id, job_id, customer_id, status)
  values (p_quote_id, v_job_id, v_customer_id, 'sent')
  returning id into v_invoice_id;
  insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
  select v_invoice_id, description, quantity, unit_price, position
  from public.quote_line_items where quote_id = p_quote_id order by position;
  return v_invoice_id;
end;
$$;

grant execute on function public.approve_quote(uuid) to authenticated;
