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
