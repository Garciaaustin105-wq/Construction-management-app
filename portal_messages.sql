-- ============================================================================
-- Terra Vista — Client Portal v1 schema: bidirectional portal_messages +
-- change-order customer-read RLS + decide_change_order() RPC.
-- ----------------------------------------------------------------------------
-- Run ONCE in the Supabase SQL Editor — paste from Notepad, NOT the terminal
-- (the Editor mangles pasted single quotes into double quotes); single-quoted
-- literals only.
--
-- Additive + idempotent only (no DROP TABLE/COLUMN/SCHEMA/DATABASE/TRUNCATE —
-- passes scripts/check-migrations.mjs). drop policy/trigger if exists +
-- create or replace function + alter table ... add column if not exists are
-- all safe and used below.
--
-- Reuses the SECURITY DEFINER helpers from multi_tenancy_a.sql / _b.sql:
--   tier_office_or_pm(org_id)   — office/admin/PM/super_admin AND same_org
--   same_org(uid, org_id)        — uid is in that org (or super_admin)
--   set_org_from_job()           — BEFORE INSERT trigger pattern (mirrored here
--                                  as set_org_from_customer for portal_messages)
--
-- Run BEFORE deploying the app code that queries these (the new UI would get
-- PostgREST errors if the table/functions did not exist yet). Until then the
-- app degrades gracefully (supabase-js returns {error} not throw → ?? []).
-- ============================================================================

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. set_org_from_customer() — sibling of set_org_from_job. The browser client
--    (a logged-in customer) does NOT know its organization_id, so client-side
--    portal_messages inserts supply customer_id only; this trigger stamps
--    organization_id from the customer row so RLS (same_org) works. Office
--    inserts also supply customer_id and get the same stamp.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.set_org_from_customer()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.customers where id = new.customer_id;
  if v_org is null then
    raise exception 'Cannot insert portal_messages: customer % missing or no org', new.customer_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. portal_messages — bidirectional thread between a customer and the office.
--    One row per message; sender 'client' | 'office'. org stamped from the
--    customer. read_at is office-side unread tracking (office marks a client
--    message read after reading it).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.portal_messages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  sender          text not null check (sender in ('client','office')),
  body            text not null,
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);

create index if not exists idx_portal_messages_customer on public.portal_messages(customer_id, created_at desc);
create index if not exists idx_portal_messages_org_unread on public.portal_messages(organization_id, read_at) where read_at is null;

alter table public.portal_messages enable row level security;

drop trigger if exists trg_portal_messages_org on public.portal_messages;
create trigger trg_portal_messages_org before insert on public.portal_messages
  for each row execute function public.set_org_from_customer();

-- Office/PM manage (read all org messages; reply sender='office'; mark read).
drop policy if exists "Office manage portal messages" on public.portal_messages;
create policy "Office manage portal messages" on public.portal_messages
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id) and sender = 'office');

-- Customer reads their own thread.
drop policy if exists "Customer read own portal messages" on public.portal_messages;
create policy "Customer read own portal messages" on public.portal_messages
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
  );

-- Customer posts to their own thread (sender pinned to 'client'; WITH CHECK
-- blocks a client spoofing an 'office' message or posting under another customer).
drop policy if exists "Customer insert own portal messages" on public.portal_messages;
create policy "Customer insert own portal messages" on public.portal_messages
  for insert to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
    and sender = 'client'
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. change_orders — add a customer-read SELECT policy. gc_pro_features.sql
--    intentionally gave change_orders NO customer tier (the /co/{token} portal
--    uses the service role). The authed Client Portal needs the logged-in
--    customer to READ their own COs via RLS, so add the owning-customer select
--    (mirrors "Customer read own punch items" / submittals — via the job's
--    customer_id). Only 'sent'/'approved'/'rejected' are customer-visible so
--    internal drafts never leak (mirrors customer_estimates_select's status guard).
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists "Customer read own change orders" on public.change_orders;
create policy "Customer read own change orders" on public.change_orders
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and status in ('sent','approved','rejected')
    and exists (
      select 1 from public.jobs j
      where j.id = change_orders.job_id
        and j.customer_id in (select customer_id from public.profiles where id = auth.uid())
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 4. decide_change_order() — the authed-customer equivalent of the public
--    /co/{token} decide route. SECURITY DEFINER so the guard lives in the DB
--    (not the route): caller must be a customer whose profiles.customer_id
--    equals the CO's job's customer_id, same_org, and status='sent'. Flips
--    status + stamps approved_at/rejected_at and records the office feed
--    notification (best-effort, deduped by the unique (type, entity_id) index).
--    Mirrors approve_estimate() / reject_estimate() in estimates_merge_a.sql.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.decide_change_order(p_co_id uuid, p_decision text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_co        public.change_orders%rowtype;
  v_customer  uuid;
  v_job_cust  uuid;
  v_cust_name text;
  v_job_name  text;
  v_type      text;
  v_title     text;
begin
  select * into v_co from public.change_orders where id = p_co_id;
  if not found then
    raise exception 'Change order not found';
  end if;
  if v_co.status <> 'sent' then
    raise exception 'This change order is not awaiting action';
  end if;
  if p_decision not in ('approve','reject') then
    raise exception 'decision must be ''approve'' or ''reject''';
  end if;

  select customer_id into v_customer from public.profiles where id = auth.uid();
  if v_customer is null then
    raise exception 'Only customer accounts may decide change orders';
  end if;

  -- change_orders has no customer_id column; resolve via the job.
  select customer_id into v_job_cust from public.jobs where id = v_co.job_id;
  if v_job_cust is null or v_job_cust is distinct from v_customer then
    raise exception 'Not authorized to decide this change order';
  end if;
  if not public.same_org(auth.uid(), v_co.organization_id) then
    raise exception 'Not authorized: change order belongs to another organization';
  end if;

  if p_decision = 'approve' then
    update public.change_orders
      set status = 'approved', approved_at = now(), updated_at = now()
      where id = p_co_id;
  else
    update public.change_orders
      set status = 'rejected', rejected_at = now(), updated_at = now()
      where id = p_co_id;
  end if;

  -- Best-effort office feed notification (matches the /co/{token} decide route).
  select name into v_cust_name from public.customers where id = v_customer;
  select name into v_job_name  from public.jobs     where id = v_co.job_id;
  v_type  := case when p_decision = 'approve' then 'change_order_approved' else 'change_order_rejected' end;
  v_title := case when p_decision = 'approve' then 'Change order approved'  else 'Change order rejected'  end;
  insert into public.notifications (organization_id, type, title, body, href, entity_id)
  values (v_co.organization_id, v_type, v_title,
          concat_ws(' · ', v_cust_name, v_job_name),
          '/change-orders/' || p_co_id::text, p_co_id)
  on conflict (type, entity_id) do nothing;
end;
$$;

grant execute on function public.decide_change_order(uuid, text) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Reload PostgREST schema so the new table/columns/policies/functions are
--    immediately visible to the auto-gen API without a restart.
-- ════════════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verification (run manually in the SQL Editor after this file succeeds):
--   select count(*) from public.portal_messages;            -- 0 ok
--   select sender from public.portal_messages limit 0;       -- column ok
--   select proname from pg_proc where proname = 'decide_change_order';  -- 1 row
--   select polname from pg_policy where polrelid = 'public.change_orders'::regclass;
--     -- includes "Customer read own change orders"
-- ════════════════════════════════════════════════════════════════════════════