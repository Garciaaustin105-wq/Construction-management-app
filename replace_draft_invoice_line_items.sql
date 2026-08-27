-- §1.2: race-safe atomic swap of a draft invoice's line items. The TS layer
-- can't do this safely: a delete-then-insert in two statements leaves a window
-- where a concurrent office "Send" (draft->sent) could land between the status
-- check and the delete, wiping a now-sent invoice's lines (a $0 sent invoice).
-- This function takes a FOR UPDATE lock on the invoice row (blocks the
-- concurrent status write until commit), re-checks status='draft' under the
-- lock, then deletes + re-inserts the lines in the same transaction.
--
-- SECURITY DEFINER: the route calls this with the service role; the org guard
-- (organization_id = p_org_id) is the auth boundary. The
-- trg_invoice_line_items_org BEFORE INSERT trigger stamps organization_id from
-- the invoice, so the insert doesn't set it. Execute revoked from anon AND
-- authenticated (function-EXECUTE hardening) — the RPC is SECURITY DEFINER and
-- only checks org + status='draft', NOT the caller's role, so only the
-- service-role route (which enforces isOfficeLike) may call it. A crew member
-- sharing the org otherwise could call the RPC directly to edit a draft,
-- bypassing the route's office gate. service_role retains execute.
--
-- Applied live 2026-08-26 (create + anon/public revoke, then authenticated
-- revoke). Verified: anon=false, authenticated=false, service_role=true.
-- FIXED 2026-08-26 e2e: unqualified `invoice_id` in the DELETE collided with
-- the RETURNS TABLE out-param (ambiguity error at runtime) -> qualified with
-- the `li` alias. Migration fix_replace_draft_line_items_ambiguity LIVE.

create or replace function public.replace_draft_invoice_line_items(
  p_invoice_id uuid,
  p_org_id uuid,
  p_items jsonb
) returns table(
  id uuid,
  invoice_id uuid,
  description text,
  quantity numeric,
  unit_price numeric,
  "position" integer
) as $$
declare
  v_status text;
begin
  -- Lock the invoice row so a concurrent Send (status update) blocks until this
  -- transaction commits. FOR UPDATE is the key race guard.
  select i.status into v_status
  from public.invoices i
  where i.id = p_invoice_id and i.organization_id = p_org_id
  for update;

  if not found then
    raise exception 'Invoice not found';
  end if;

  if v_status <> 'draft' then
    raise exception 'Invoice is % — only draft invoices can be edited.', v_status;
  end if;

  -- Atomic swap: wipe the existing lines, insert the new set. Array order is
  -- the source of truth -> positions are re-indexed 0-based server-side.
  delete from public.invoice_line_items li where li.invoice_id = p_invoice_id;

  if coalesce(jsonb_array_length(p_items), 0) > 0 then
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, "position")
    select
      p_invoice_id,
      coalesce(elem->>'description', ''),
      coalesce((elem->>'quantity')::numeric, 0),
      coalesce((elem->>'unit_price')::numeric, 0),
      (idx - 1)::integer
    from jsonb_array_elements(p_items) with ordinality as arr(elem, idx);
  end if;

  return query
    select li.id, li.invoice_id, li.description, li.quantity, li.unit_price, li."position"
    from public.invoice_line_items li
    where li.invoice_id = p_invoice_id
    order by li."position";
end;
$$ language plpgsql security definer;

revoke execute on function public.replace_draft_invoice_line_items(uuid, uuid, jsonb) from anon, public;
revoke execute on function public.replace_draft_invoice_line_items(uuid, uuid, jsonb) from authenticated;