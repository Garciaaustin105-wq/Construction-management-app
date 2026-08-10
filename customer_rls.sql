-- Add customer_id to profiles so we can map customer logins to their customer record
alter table profiles add column customer_id uuid references customers(id) on delete set null;

-- Office can edit customer_id on profiles
drop policy if exists "Office edit customer_id on profiles" on profiles;
create policy "Office edit customer_id on profiles" on profiles for update using (
  public.is_office(auth.uid())
);

-- Backfill: link customer@test.com's profile to Acme Construction
update profiles
set customer_id = '11111111-1111-1111-1111-111111111111'
where email = 'customer@test.com';

-- Customers can see their own customer record
drop policy if exists "Customer see own record" on customers;
create policy "Customer see own record" on customers for select using (
  id in (select customer_id from profiles where id = auth.uid())
);

-- Customers can see their own jobs
drop policy if exists "Customer see own jobs" on jobs;
create policy "Customer see own jobs" on jobs for select using (
  customer_id in (select customer_id from profiles where id = auth.uid())
);

-- Customers can see photos for their own jobs
drop policy if exists "Customer see own photos" on photos;
create policy "Customer see own photos" on photos for select using (
  job_id in (
    select id from jobs where customer_id in (
      select customer_id from profiles where id = auth.uid()
    )
  )
);