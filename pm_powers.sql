-- Project Manager operational powers (plus management field-team visibility).
-- Idempotent. Run via Supabase SQL Editor (paste from Notepad, not the terminal).
-- Depends on: subcontractors.sql (defines is_office_or_pm). Run that first.
--
-- Grants:
--   1. assign_job_crew() RPC — office + PM can assign crew AND superintendents
--      to a job (updates only assigned_crew; no other job fields).
--   2. Management (office / superintendent / PM) can READ crew / superintendent
--      / PM profiles (the field-team directory) so PMs can see + assign the
--      people they oversee. Office already reads all profiles.
--   3. PM can CREATE / manage invoices + invoice line items (office + PM).

-- ── 1. assign_job_crew RPC ─────────────────────────────────────────────────
drop function if exists public.assign_job_crew(uuid, uuid[]);

create or replace function public.assign_job_crew(p_job_id uuid, p_crew uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only office or project_manager may assign crew/supers.
  if not public.is_office_or_pm(auth.uid()) then
    raise exception 'Not authorized to assign crew';
  end if;

  update public.jobs
  set assigned_crew = p_crew
  where id = p_job_id;
end;
$$;

grant execute on function public.assign_job_crew(uuid, uuid[]) to authenticated;

-- ── 2. management read field-team profiles ─────────────────────────────────
-- Management can read crew / superintendent / project_manager profiles.
-- Customer and office profiles are NOT exposed here (office has its own
-- full-read policy; customer-self has its own).
drop policy if exists "Management read field-team profiles" on profiles;
create policy "Management read field-team profiles" on profiles
  for select to authenticated
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('office', 'superintendent', 'project_manager')
    )
    and role in ('crew', 'superintendent', 'project_manager')
  );

-- ── 3. invoices + invoice_line_items: office + project_manager ─────────────
drop policy if exists office_invoices_all on public.invoices;
create policy office_invoices_all on public.invoices for all to authenticated
using (public.is_office_or_pm(auth.uid()))
with check (public.is_office_or_pm(auth.uid()));

drop policy if exists office_invoice_line_items_all on public.invoice_line_items;
create policy office_invoice_line_items_all on public.invoice_line_items for all to authenticated
using (public.is_office_or_pm(auth.uid()))
with check (public.is_office_or_pm(auth.uid()));