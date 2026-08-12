-- ============================================================================
-- Terra Vista — Cost-code Estimates.
-- Run ONCE in the Supabase dashboard SQL Editor (terminal mangles multi-line
-- SQL — paste from Notepad). Idempotent: IF NOT EXISTS / drop-policy-if-exists
-- / on-conflict-do-nothing, so re-running is safe.
--
-- What this adds:
--   1. A starter set of GC cost codes (CSI MasterFormat divisions, tailored for
--      a general + low-voltage contractor) seeded into the empty cost_codes
--      table — so the crew time-page "cost code" dropdown is no longer empty.
--   2. cost_code_id on quote_line_items so a converted quote keeps its
--      cost-code linkage (nullable; existing quotes are unaffected).
--   3. estimates + estimate_line_items tables (an estimate is an office-built,
--      per-job, cost-code-structured price that can be converted to a quote).
--   4. RLS: office full; crew read for their assigned jobs; customers do NOT
--      see estimates (they see the converted quote instead).
--   5. convert_estimate_to_quote() RPC: office-only SECURITY DEFINER that
--      copies an estimate + its line items into a draft quote (preserving
--      cost_code_id) and marks the estimate 'converted'. The customer then
--      approves the quote through the existing approve_quote() flow, which
--      creates the invoice. Reuses the whole Phase-2 invoicing pipeline.
-- ============================================================================

-- 1. Seed GC cost codes (only inserts codes that don't already exist). -------
insert into public.cost_codes (code, name, category) values
  ('01000','General Conditions & Requirements','Other'),
  ('01100','Project Management / Supervision','Labor'),
  ('01500','Permits & Fees','Other'),
  ('01700','Cleanup & Closeout','Labor'),
  ('02000','Existing Conditions / Demo','Other'),
  ('03000','Concrete','Material'),
  ('03100','Concrete Formwork','Labor'),
  ('03200','Concrete Reinforcement','Material'),
  ('03300','Cast-in-Place Concrete','Material'),
  ('04000','Masonry','Material'),
  ('05000','Metals','Material'),
  ('05100','Structural Steel','Subcontract'),
  ('06000','Wood, Plastics & Composites','Material'),
  ('06100','Rough Carpentry','Labor'),
  ('06200','Finish Carpentry','Labor'),
  ('07000','Thermal & Moisture Protection','Material'),
  ('07100','Insulation','Material'),
  ('07200','Roofing','Subcontract'),
  ('08000','Openings (Doors & Windows)','Material'),
  ('09000','Finishes','Material'),
  ('09100','Drywall','Subcontract'),
  ('09200','Painting','Subcontract'),
  ('09300','Flooring','Subcontract'),
  ('21000','Fire Suppression','Subcontract'),
  ('22000','Plumbing','Subcontract'),
  ('23000','HVAC','Subcontract'),
  ('26000','Electrical','Subcontract'),
  ('26100','Rough-in Electrical','Labor'),
  ('26200','Electrical Fixtures','Material'),
  ('27000','Communications / Low-Voltage','Subcontract'),
  ('27100','Data Cabling (Cat6 / Fiber)','Material'),
  ('27200','Low-Voltage Devices','Material'),
  ('28000','Electronic Safety & Security','Subcontract'),
  ('28100','Access Control / CCTV','Subcontract'),
  ('31000','Earthwork / Site Prep','Equipment'),
  ('32000','Exterior Improvements','Material'),
  ('33000','Site Utilities','Subcontract'),
  ('50000','Equipment Rental','Equipment')
on conflict (code) do nothing;

-- 2. cost_code_id on quote_line_items (nullable; preserves link after convert).-
alter table public.quote_line_items
  add column if not exists cost_code_id uuid
  references public.cost_codes(id) on delete set null;

-- 3. estimates ---------------------------------------------------------------
create table if not exists public.estimates (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  created_by  uuid references public.profiles(id),
  title       text,
  status      text not null default 'draft'
              check (status in ('draft','sent','approved','converted','rejected')),
  note        text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  approved_at timestamptz
);

create index if not exists estimates_job_id_idx on public.estimates(job_id);
create index if not exists estimates_status_idx on public.estimates(status);

alter table public.estimates enable row level security;

-- Office: full CRUD.
drop policy if exists "office_estimates_all" on public.estimates;
create policy "office_estimates_all" on public.estimates
  for all to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

-- Crew: read estimates for jobs they're assigned to.
drop policy if exists "crew_estimates_select" on public.estimates;
create policy "crew_estimates_select" on public.estimates
  for select to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = estimates.job_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

-- (Customers do NOT read estimates — they see the converted quote.)

-- 4. estimate_line_items -----------------------------------------------------
create table if not exists public.estimate_line_items (
  id           uuid primary key default gen_random_uuid(),
  estimate_id  uuid not null references public.estimates(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  description  text,
  quantity     numeric(12,2) not null default 1,
  unit         text,                         -- EA / LF / SF / CF / HR / DAY / LOT / GAL / TON
  unit_price   numeric(12,2) not null default 0,
  position     integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists estimate_line_items_estimate_id_idx
  on public.estimate_line_items(estimate_id);

alter table public.estimate_line_items enable row level security;

-- Office: full CRUD.
drop policy if exists "office_estimate_items_all" on public.estimate_line_items;
create policy "office_estimate_items_all" on public.estimate_line_items
  for all to authenticated
  using (public.is_office(auth.uid()))
  with check (public.is_office(auth.uid()));

-- Crew: read line items for estimates on jobs they're assigned to.
drop policy if exists "crew_estimate_items_select" on public.estimate_line_items;
create policy "crew_estimate_items_select" on public.estimate_line_items
  for select to authenticated
  using (
    exists (
      select 1 from public.estimates e
      join public.jobs j on j.id = e.job_id
      where e.id = estimate_line_items.estimate_id
        and auth.uid() = any(j.assigned_crew)
    )
  );

-- 5. convert_estimate_to_quote() --------------------------------------------
-- Office-only SECURITY DEFINER: copies an estimate + its cost-coded line items
-- into a draft quote (reusing the existing quotes pipeline), then marks the
-- estimate 'converted'. The customer then approves via approve_quote() which
-- creates the invoice. Returns the new quote id.
create or replace function public.convert_estimate_to_quote(p_estimate_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id      uuid;
  v_customer_id uuid;
  v_created_by  uuid;
  v_quote_id    uuid;
begin
  if not public.is_office(auth.uid()) then
    raise exception 'Not authorized: office only';
  end if;

  select e.job_id, e.created_by, j.customer_id
    into v_job_id, v_created_by, v_customer_id
  from public.estimates e
  left join public.jobs j on j.id = e.job_id
  where e.id = p_estimate_id;

  if v_job_id is null then
    raise exception 'Estimate not found';
  end if;

  -- Create the quote as a draft (office can review, then send to the customer).
  insert into public.quotes (job_id, customer_id, status, created_by)
  values (v_job_id, v_customer_id, 'draft', v_created_by)
  returning id into v_quote_id;

  -- Snapshot line items; fall back to the cost-code name when description is blank.
  insert into public.quote_line_items (quote_id, description, quantity, unit_price, cost_code_id, position)
  select
    v_quote_id,
    coalesce(e.description, cc.name, ''),
    e.quantity,
    e.unit_price,
    e.cost_code_id,
    row_number() over (order by e.created_at) - 1
  from public.estimate_line_items e
  left join public.cost_codes cc on cc.id = e.cost_code_id
  where e.estimate_id = p_estimate_id;

  -- Mark the estimate converted (kept for history; not deleted).
  update public.estimates set status = 'converted' where id = p_estimate_id;

  return v_quote_id;
end;
$$;

grant execute on function public.convert_estimate_to_quote(uuid) to authenticated;