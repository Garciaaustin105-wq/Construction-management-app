-- §5.3 lead → estimate link + auto won/lost sync (feature-completeness audit).
-- Applied live 2026-08-26. Re-runnable (all IF NOT EXISTS / OR REPLACE).
--
-- Adds leads.estimate_id (FK to estimates) so the CRM board can show which
-- estimate a lead became, and a trigger that moves the lead to won/lost when
-- that estimate is approved/rejected — closing the loop the audit named
-- ("the board is hand-maintained → wrong within a month"). The trigger is
-- path-agnostic: it fires on any estimates status UPDATE, so it covers the
-- authed approve_estimate/reject_estimate SECURITY DEFINER RPCs AND the
-- public /api/estimates/by-token/[token]/decide route without touching either.
-- SECURITY DEFINER so it can write leads regardless of the caller's RLS. The
-- status-in-(new,contacted,quoted) guard means a lead already won (e.g. via
-- convertLeadToCustomer) is never flipped to lost by a later estimate reject.

alter table public.leads
  add column if not exists estimate_id uuid references public.estimates(id) on delete set null;

create index if not exists leads_estimate_id_idx
  on public.leads (estimate_id) where estimate_id is not null;

create or replace function public.sync_lead_from_estimate_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' then
    update public.leads
      set status = 'won'
      where estimate_id = new.id
        and status in ('new','contacted','quoted');
  elsif new.status = 'rejected' then
    update public.leads
      set status = 'lost'
      where estimate_id = new.id
        and status in ('new','contacted','quoted');
  end if;
  return new;
end $$;

grant execute on function public.sync_lead_from_estimate_decision() to authenticated;

drop trigger if exists trg_sync_lead_from_estimate on public.estimates;
create trigger trg_sync_lead_from_estimate
  after update of status on public.estimates
  for each row
  execute function public.sync_lead_from_estimate_decision();