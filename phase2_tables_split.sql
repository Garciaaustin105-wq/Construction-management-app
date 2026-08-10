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
