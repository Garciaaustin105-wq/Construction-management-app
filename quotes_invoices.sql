-- Quotes & Invoicing schema for Phase 2.
-- Reuses public.is_office(uid) helper from fix_recursion_v2.sql.

-- ============================================================================
-- TABLES
-- ============================================================================

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','sent','approved','rejected')),
  notes text,
  sent_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(10,2) not null default 0,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null unique references public.quotes(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'sent' check (status in ('sent','paid','void')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(10,2) not null default 0,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists quotes_job_id_idx on public.quotes(job_id);
create index if not exists quotes_customer_id_idx on public.quotes(customer_id);
create index if not exists quote_line_items_quote_id_idx on public.quote_line_items(quote_id);
create index if not exists invoices_job_id_idx on public.invoices(job_id);
create index if not exists invoices_customer_id_idx on public.invoices(customer_id);
create index if not exists invoices_status_idx on public.invoices(status);
create index if not exists invoice_line_items_invoice_id_idx on public.invoice_line_items(invoice_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.quotes enable row level security;
alter table public.quote_line_items enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_line_items enable row level security;

-- ---- quotes ----

drop policy if exists office_quotes_all on public.quotes;
create policy office_quotes_all on public.quotes for all to authenticated
using (public.is_office(auth.uid()))
with check (public.is_office(auth.uid()));

drop policy if exists crew_quotes_select on public.quotes;
create policy crew_quotes_select on public.quotes for select to authenticated
using (
  exists (
    select 1 from public.jobs j
    where j.id = quotes.job_id
    and auth.uid() = any(j.assigned_crew)
  )
);

drop policy if exists customer_quotes_select on public.quotes;
create policy customer_quotes_select on public.quotes for select to authenticated
using (
  customer_id in (
    select customer_id from public.profiles where id = auth.uid()
  )
);

-- ---- quote_line_items ----

drop policy if exists office_quote_line_items_all on public.quote_line_items;
create policy office_quote_line_items_all on public.quote_line_items for all to authenticated
using (public.is_office(auth.uid()))
with check (public.is_office(auth.uid()));

drop policy if exists crew_quote_line_items_select on public.quote_line_items;
create policy crew_quote_line_items_select on public.quote_line_items for select to authenticated
using (
  exists (
    select 1 from public.quotes q
    join public.jobs j on j.id = q.job_id
    where q.id = quote_line_items.quote_id
    and auth.uid() = any(j.assigned_crew)
  )
);

drop policy if exists customer_quote_line_items_select on public.quote_line_items;
create policy customer_quote_line_items_select on public.quote_line_items for select to authenticated
using (
  exists (
    select 1 from public.quotes q
    where q.id = quote_line_items.quote_id
    and q.customer_id in (
      select customer_id from public.profiles where id = auth.uid()
    )
  )
);

-- ---- invoices ----

drop policy if exists office_invoices_all on public.invoices;
create policy office_invoices_all on public.invoices for all to authenticated
using (public.is_office(auth.uid()))
with check (public.is_office(auth.uid()));

drop policy if exists customer_invoices_select on public.invoices;
create policy customer_invoices_select on public.invoices for select to authenticated
using (
  customer_id in (
    select customer_id from public.profiles where id = auth.uid()
  )
);

-- ---- invoice_line_items ----

drop policy if exists office_invoice_line_items_all on public.invoice_line_items;
create policy office_invoice_line_items_all on public.invoice_line_items for all to authenticated
using (public.is_office(auth.uid()))
with check (public.is_office(auth.uid()));

drop policy if exists customer_invoice_line_items_select on public.invoice_line_items;
create policy customer_invoice_line_items_select on public.invoice_line_items for select to authenticated
using (
  exists (
    select 1 from public.invoices i
    where i.id = invoice_line_items.invoice_id
    and i.customer_id in (
      select customer_id from public.profiles where id = auth.uid()
    )
  )
);

-- ============================================================================
-- CUSTOMER APPROVAL RPC
-- ============================================================================

create or replace function public.approve_quote(p_quote_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_job_id uuid;
  v_invoice_id uuid;
begin
  -- Verify the caller is the customer that owns this quote
  select q.customer_id, q.job_id into v_customer_id, v_job_id
  from public.quotes q
  where q.id = p_quote_id;

  if v_customer_id is null then
    raise exception 'Quote not found';
  end if;

  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to approve this quote';
  end if;

  -- Verify quote is in a state that can be approved
  if not exists (
    select 1 from public.quotes
    where id = p_quote_id and status = 'sent'
  ) then
    raise exception 'Quote is not awaiting approval';
  end if;

  -- Check no invoice already exists for this quote
  if exists (select 1 from public.invoices where quote_id = p_quote_id) then
    raise exception 'Quote already approved';
  end if;

  -- Mark quote approved
  update public.quotes
  set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_quote_id;

  -- Create invoice (default status = 'sent')
  insert into public.invoices (quote_id, job_id, customer_id, status)
  values (p_quote_id, v_job_id, v_customer_id, 'sent')
  returning id into v_invoice_id;

  -- Snapshot line items from quote to invoice
  insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
  select v_invoice_id, description, quantity, unit_price, position
  from public.quote_line_items
  where quote_id = p_quote_id
  order by position;

  return v_invoice_id;
end;
$$;

grant execute on function public.approve_quote(uuid) to authenticated;
