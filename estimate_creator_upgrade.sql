-- estimate_creator_upgrade.sql — professional estimate creator upgrade
-- ============================================================================
-- Adds the 8 estimate-creator features (pricing summary, sections, templates,
-- exclusions/terms/payment schedule, internal cost vs customer price, estimate
-- numbering, customer "viewed" timestamp, itemized vs lump-sum toggle).
--
-- Additive + idempotent ONLY. No DROP TABLE / DROP COLUMN / TRUNCATE
-- (migration-guard clean). Run BEFORE deploy, paste via Notepad (the SQL
-- Editor mangles pasted single quotes into double quotes). Safe to re-run.
-- ============================================================================

-- 1. New columns on estimates ----------------------------------------------
alter table public.estimates add column if not exists markup_pct       numeric(5,2)  not null default 0;
alter table public.estimates add column if not exists contingency_pct  numeric(5,2)  not null default 0;
alter table public.estimates add column if not exists tax_pct          numeric(5,2)  not null default 0;
alter table public.estimates add column if not exists deposit_pct      numeric(5,2)  not null default 0;
alter table public.estimates add column if not exists deposit_amount   numeric(12,2) not null default 0;
alter table public.estimates add column if not exists exclusions       text;
alter table public.estimates add column if not exists terms            text;
alter table public.estimates add column if not exists payment_schedule text;
alter table public.estimates add column if not exists estimate_number  text;
alter table public.estimates add column if not exists viewed_at        timestamptz;
alter table public.estimates add column if not exists show_itemized    boolean not null default true;

-- Per-org uniqueness for estimate_number (partial — only enforced when set).
-- A UNIQUE constraint with a WHERE clause isn't allowed in plain SQL, so use a
-- partial unique index instead (same enforcement, idempotent).
create unique index if not exists estimates_estimate_number_unique_org
  on public.estimates (organization_id, estimate_number)
  where estimate_number is not null;

-- 2. New columns on estimate_line_items ------------------------------------
-- internal_cost is OFFICE-ONLY — never selected into customer-facing queries
-- (Postgres RLS is row-level only and cannot hide columns). section is a
-- customer-visible phase label ("Site work", "Electrical", ...).
alter table public.estimate_line_items add column if not exists internal_cost numeric(12,2);
alter table public.estimate_line_items add column if not exists section       text;

-- 3. Backfill estimate numbers for existing rows (per org, oldest first) ---
-- Re-runnable: only touches rows still missing a number.
with ranked as (
  select id, organization_id,
         row_number() over (partition by organization_id order by created_at) as rn
  from public.estimates
  where estimate_number is null
)
update public.estimates e
  set estimate_number = 'EST-' || lpad(r.rn::text, 4, '0')
from ranked r
where e.id = r.id;

-- 4. Saved templates / assemblies -----------------------------------------
-- estimate_templates is a root table (app supplies organization_id, same as
-- jobs/customers). estimate_template_items is a child stamped from the parent
-- via set_org_from_template() (SECURITY DEFINER), same pattern as the other
-- set_org_from_* triggers.
create table if not exists public.estimate_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  description     text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

create table if not exists public.estimate_template_items (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.estimate_templates(id) on delete cascade,
  cost_code_id    uuid references public.cost_codes(id) on delete set null,
  description     text,
  quantity        numeric(12,2) not null default 1,
  unit            text,
  unit_price      numeric(12,2) not null default 0,
  internal_cost   numeric(12,2),
  section         text,
  position        integer not null default 0,
  organization_id uuid,
  created_at      timestamptz not null default now()
);

alter table public.estimate_templates        enable row level security;
alter table public.estimate_template_items   enable row level security;

-- Office/admin (tier_office) can do everything with templates. Items use
-- same_org (org stamped by the trigger, so it always matches the parent).
drop policy if exists "office_templates_all" on public.estimate_templates;
create policy "office_templates_all" on public.estimate_templates for all to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

drop policy if exists "office_template_items_all" on public.estimate_template_items;
create policy "office_template_items_all" on public.estimate_template_items for all to authenticated
  using (public.same_org(auth.uid(), organization_id))
  with check (public.same_org(auth.uid(), organization_id));

-- Stamp template_items.organization_id from the parent template (SECURITY
-- DEFINER so the office user inserting items doesn't need select on every
-- template row; raises if the parent is missing).
create or replace function public.set_org_from_template()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.estimate_templates where id = new.template_id;
  if v_org is null then
    raise exception 'Cannot insert estimate_template_items: parent template % missing or has no organization',
      new.template_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

drop trigger if exists trg_estimate_template_items_org on public.estimate_template_items;
create trigger trg_estimate_template_items_org before insert on public.estimate_template_items
  for each row execute function public.set_org_from_template();

-- 5. Rewrite approve_estimate to add pricing-summary invoice lines -----------
-- On approval the invoice must total the estimate GRAND TOTAL (subtotal +
-- markup + contingency + tax). The base line items are snapshotted exactly as
-- before (4-column explicit list — new line-item columns never leak), then
-- summary invoice_line_items are appended for Overhead & Profit, Contingency,
-- and Sales Tax — only when that pct > 0. Deposit is estimate-only and never
-- becomes an invoice line (the invoice is for the full grand total; the deposit
-- is applied as a partial payment later). Signature + guards unchanged from
-- estimates_merge_a.sql (returns the new invoice uuid).
create or replace function public.approve_estimate(p_estimate_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_customer_id   uuid;
  v_job_id        uuid;
  v_org           uuid;
  v_invoice_id    uuid;
  v_subtotal      numeric(12,2) := 0;
  v_markup_pct    numeric(5,2)  := 0;
  v_cont_pct      numeric(5,2)  := 0;
  v_tax_pct       numeric(5,2)  := 0;
  v_markup_amt    numeric(12,2) := 0;
  v_cont_amt      numeric(12,2) := 0;
  v_pretax        numeric(12,2) := 0;
  v_tax_amt       numeric(12,2) := 0;
  v_pos           integer       := 0;
begin
  select e.customer_id, e.job_id, e.organization_id, coalesce(e.markup_pct, 0), coalesce(e.contingency_pct, 0), coalesce(e.tax_pct, 0)
    into v_customer_id, v_job_id, v_org, v_markup_pct, v_cont_pct, v_tax_pct
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

  -- Base line items (explicit 4-column snapshot — new columns don't leak).
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

  -- Pricing-summary lines so invoice total == estimate grand total.
  select coalesce(sum(e.quantity * e.unit_price), 0) into v_subtotal
  from public.estimate_line_items e
  where e.estimate_id = p_estimate_id;

  select coalesce(max(position), 0) into v_pos
  from public.invoice_line_items
  where invoice_id = v_invoice_id;

  if v_markup_pct > 0 then
    v_markup_amt := round(v_subtotal * v_markup_pct / 100.0, 2);
    v_pos := v_pos + 1;
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Overhead & Profit (' || v_markup_pct || '%)', 1, v_markup_amt, v_pos);
  end if;

  if v_cont_pct > 0 then
    v_cont_amt := round(v_subtotal * v_cont_pct / 100.0, 2);
    v_pos := v_pos + 1;
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Contingency (' || v_cont_pct || '%)', 1, v_cont_amt, v_pos);
  end if;

  if v_tax_pct > 0 then
    v_pretax := v_subtotal + v_markup_amt + v_cont_amt;
    v_tax_amt := round(v_pretax * v_tax_pct / 100.0, 2);
    v_pos := v_pos + 1;
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Sales Tax (' || v_tax_pct || '%)', 1, v_tax_amt, v_pos);
  end if;

  return v_invoice_id;
end;
$$;
grant execute on function public.approve_estimate(uuid) to authenticated;

-- reject_estimate is unchanged from estimates_merge_a.sql.
-- Done. Verify with:
--   \d public.estimates                       (10 new columns)
--   \d public.estimate_line_items             (internal_cost, section)
--   select estimate_number from public.estimates order by created_at;
--   \d+ public.estimate_templates             (table + RLS)
--   \df+ public.approve_estimate              (summary lines in the body)