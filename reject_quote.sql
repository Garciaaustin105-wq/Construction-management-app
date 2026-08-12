-- M-2 fix: customer "Reject Quote" did a direct client UPDATE on quotes, but
-- only office has an UPDATE policy on quotes -> customers got a 403 and a
-- "Failed" toast. This SECURITY DEFINER RPC mirrors approve_quote: it verifies
-- the caller owns the quote, the quote is still 'sent', then marks it rejected.
-- Safer than a customer UPDATE policy (which could expose other columns).

create or replace function public.reject_quote(p_quote_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
begin
  -- Resolve the quote's owner
  select q.customer_id into v_customer_id
  from public.quotes q
  where q.id = p_quote_id;

  if v_customer_id is null then
    raise exception 'Quote not found';
  end if;

  -- Only the owning customer may reject
  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to reject this quote';
  end if;

  -- Only a quote awaiting the customer's decision can be rejected
  if not exists (
    select 1 from public.quotes
    where id = p_quote_id and status = 'sent'
  ) then
    raise exception 'Quote is not awaiting action';
  end if;

  update public.quotes
  set status = 'rejected', rejected_at = now(), updated_at = now()
  where id = p_quote_id;
end;
$$;

grant execute on function public.reject_quote(uuid) to authenticated;