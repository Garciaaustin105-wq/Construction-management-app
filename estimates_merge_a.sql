-- ============================================================================
-- Terra Vista — Merge quotes → estimates (Phase A: add + backfill).
-- Run BEFORE deploying the new estimate-only app. Idempotent: IF NOT EXISTS /
-- ON CONFLICT DO NOTHING / WHERE ... IS NULL, so it can be re-run safely — and
-- SHOULD be re-run right before AND right after deploy to capture any quotes
-- created/approved in the deploy window.
--
-- Goal: estimates absorbs the customer-facing fields that used to live only on
-- quotes (customer_id, share_token, valid_until, rejected_at, updated_at,
-- customer_notes). Existing quotes are copied into estimates PRESERVING THEIR
-- IDS, so invoices.quote_id still resolves and already-emailed /q/{token}
-- links keep working (the token moves onto the estimate row with the same id).
--
-- quotes + quote_line_items + the old approve_quote/reject_quote/
-- convert_estimate_to_quote RPCs are LEFT IN PLACE so the current (pre-deploy)
-- app keeps working. They are dropped in estimates_merge_b.sql AFTER the new
-- app is deployed and verified.
--
-- Run in the Supabase dashboard SQL Editor. Paste from a text editor — the
-- terminal mangles multi-line SQL.
-- ============================================================================

-- 1. Add the quote-only columns to estimates. -------------------------------
-- `note` stays as the INTERNAL note (office-only); `customer_notes` is the
-- customer-visible note (was quotes.notes). The estimates.status check already
-- allows draft/sent/approved/converted/rejected — 'converted' is left allowed
-- for legacy rows; new code never sets it.
alter table public.estimates add column if not exists customer_id   uuid references public.customers(id) on delete set null;
alter table public.estimates add column if not exists share_token   uuid;
alter table public.estimates add column if not exists valid_until   date;
alter table public.estimates add column if not exists rejected_at   timestamptz;
alter table public.estimates add column if not exists updated_at    timestamptz not null default now();
alter table public.estimates add column if not exists customer_notes text;

-- Postgres allows multiple NULLs in a unique index, so drafts (no token) coexist.
create unique index if not exists estimates_share_token_key
  on public.estimates(share_token);

-- 2. Backfill customer_id on pre-existing internal estimates from the job. --
-- So old internal estimates can be sent to the customer post-merge.
update public.estimates e
  set customer_id = j.customer_id
  from public.jobs j
  where e.job_id = j.id
    and e.customer_id is null;

-- 3. Migrate quotes → estimates, preserving ids. ----------------------------
-- Preserving the id means invoices.quote_id (and the public /q/{token} link,
-- keyed on share_token) still resolve to the same row, now in estimates.
-- trg_estimates_org stamps organization_id from the job (overriding the value
-- supplied, which is the same org anyway).
insert into public.estimates
  (id, job_id, created_by, status, note, created_at, sent_at, approved_at,
   organization_id, customer_id, share_token, valid_until, rejected_at,
   updated_at, customer_notes)
select
  q.id, q.job_id, q.created_by, q.status, null, q.created_at, q.sent_at,
  q.approved_at, q.organization_id, q.customer_id, q.share_token, q.valid_until,
  q.rejected_at, q.updated_at, q.notes
from public.quotes q
on conflict (id) do nothing;

-- 4. Migrate quote_line_items → estimate_line_items, preserving ids. --------
-- estimate_id = the old quote_id, which is now an estimate id (step 3). unit
-- is null because quote_line_items had no unit column. trg_estimate_line_items
-- _org stamps organization_id from the parent estimate.
insert into public.estimate_line_items
  (id, estimate_id, cost_code_id, description, quantity, unit, unit_price,
   position, created_at, organization_id)
select
  li.id, li.quote_id, li.cost_code_id, li.description, li.quantity, null,
  li.unit_price, li.position, li.created_at, li.organization_id
from public.quote_line_items li
on conflict (id) do nothing;

-- 5. Repoint invoices onto estimates (add estimate_id; KEEP quote_id). ------
-- estimate_id is nullable (manual invoices have no source document). We copy
-- the old quote_id into estimate_id — because migrated quote ids == estimate
-- ids, the value already points at the right row. quote_id + its index/FK are
-- dropped in Phase B after the new app is live and no longer references them.
alter table public.invoices
  add column if not exists estimate_id uuid
  references public.estimates(id) on delete cascade;

update public.invoices
  set estimate_id = quote_id
  where quote_id is not null
    and estimate_id is null;

create unique index if not exists invoices_estimate_id_unique
  on public.invoices(estimate_id) where estimate_id is not null;

-- 6. Customer-read RLS on estimates + estimate_line_items. ------------------
-- Customers see only the sent/approved/rejected estimates they own (never
-- drafts) — mirrors the old customer_quotes_select with a status guard so
-- internal drafts can't leak. Postgres RLS is row-level only, so cost_code_id
-- cannot be hidden here; customer-facing queries select only customer-safe
-- columns (description, quantity, unit, unit_price) in the app layer.
drop policy if exists "customer_estimates_select" on public.estimates;
create policy "customer_estimates_select" on public.estimates
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
    and status in ('sent','approved','rejected')
  );

drop policy if exists "customer_estimate_items_select" on public.estimate_line_items;
create policy "customer_estimate_items_select" on public.estimate_line_items
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.estimates e
      where e.id = estimate_line_items.estimate_id
        and e.customer_id in (select customer_id from public.profiles where id = auth.uid())
        and e.status in ('sent','approved','rejected')
    )
  );

-- 7. approve_estimate() + reject_estimate() — clones of the live approve_quote/
-- reject_quote but operating on estimates and creating the invoice with
-- estimate_id. Customer-only (owning customer + same_org). The invoice line-
-- item snapshot coalesces a blank estimate description down to the cost-code
-- name — estimate_line_items.description is nullable but invoice_line_items.
-- description is NOT NULL, so the coalesce is required.
create or replace function public.approve_estimate(p_estimate_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_customer_id uuid;
  v_job_id       uuid;
  v_org          uuid;
  v_invoice_id   uuid;
begin
  select e.customer_id, e.job_id, e.organization_id
    into v_customer_id, v_job_id, v_org
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

  -- trg_invoices_org stamps organization_id from the job.
  insert into public.invoices (estimate_id, job_id, customer_id, status)
  values (p_estimate_id, v_job_id, v_customer_id, 'sent')
  returning id into v_invoice_id;

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

  return v_invoice_id;
end;
$$;
grant execute on function public.approve_estimate(uuid) to authenticated;

create or replace function public.reject_estimate(p_estimate_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_customer_id uuid;
  v_org         uuid;
begin
  select e.customer_id, e.organization_id
    into v_customer_id, v_org
  from public.estimates e
  where e.id = p_estimate_id;

  if v_customer_id is null then
    raise exception 'Estimate not found';
  end if;

  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to reject this estimate';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: estimate belongs to another organization';
  end if;

  if not exists (select 1 from public.estimates where id = p_estimate_id and status = 'sent') then
    raise exception 'Estimate is not awaiting action';
  end if;

  update public.estimates
  set status = 'rejected', rejected_at = now(), updated_at = now()
  where id = p_estimate_id;
end;
$$;
grant execute on function public.reject_estimate(uuid) to authenticated;

-- 8. Nothing is dropped in Phase A. -----------------------------------------
-- quotes, quote_line_items, approve_quote, reject_quote, convert_estimate_to
-- _quote all stay so the current app keeps working until the new app deploys.
-- Drop them in estimates_merge_b.sql after deploy verifies.