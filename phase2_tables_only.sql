create table if not exists schema_caps.quotes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid,
  customer_id uuid,
  status text default 'draft' check (status in ('draft','sent','approved','rejected')),
  notes text,
  sent_at timestamp with time zone,
  approved_at timestamp with time zone,
  rejected_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists schema_caps.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid,
  description text,
  quantity numeric(10,2) default 1,
  unit_price numeric(10,2) default 0,
  position integer default 0,
  created_at timestamp with time zone default now()
);

create table if not exists schema_caps.invoices (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid,
  job_id uuid,
  customer_id uuid,
  status text default 'sent' check (status in ('sent','paid','void')),
  paid_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists schema_caps.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid,
  description text,
  quantity numeric(10,2) default 1,
  unit_price numeric(10,2) default 0,
  position integer default 0,
  created_at timestamp with time zone default now()
);

create index if not exists quotes_job_id_idx on schema_caps.quotes(job_id);
create index if not exists quotes_customer_id_idx on schema_caps.quotes(customer_id);
create index if not exists quote_line_items_quote_id_idx on schema_caps.quote_line_items(quote_id);
create index if not exists invoices_job_id_idx on schema_caps.invoices(job_id);
create index if not exists invoices_customer_id_idx on schema_caps.invoices(customer_id);
create index if not exists invoices_status_idx on schema_caps.invoices(status);
create index if not exists invoice_line_items_invoice_id_idx on schema_caps.invoice_line_items(invoice_id);

create unique index if not exists invoices_quote_id_unique on schema_caps.invoices(quote_id) where quote_id is not null;
