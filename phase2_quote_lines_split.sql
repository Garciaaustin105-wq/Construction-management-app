create table if not exists schema_caps.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid,
  description text,
  quantity numeric(10,2) default 1,
  unit_price numeric(10,2) default 0,
  position integer default 0,
  created_at timestamp with time zone default now()
);
