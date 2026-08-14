-- Terra Vista — Standalone (job-less) estimates.
-- Lets the office create/send an estimate to a customer that has no job profile
-- yet (prospect -> estimate -> approval -> job). Run BEFORE deploying the app
-- changes. Idempotent (IF NOT EXISTS / create or replace / drop trigger if
-- exists), additive only (1 "drop not null" + 2 new trigger functions + 2
-- trigger repoints). No RLS / RPC changes — the customer-facing estimates RLS
-- already keys on customer_id + same_org (not job), and approve_estimate /
-- the public decide route already insert the invoice with the estimate's
-- job_id (now possibly null) and rely on the invoice trigger.
--
-- Run in the Supabase dashboard SQL Editor. Paste from a text editor (e.g.
-- Notepad) — the terminal mangles multi-line SQL.
-- ============================================================================

-- 1. Allow estimates with no job (standalone / prospect estimates).
--    Existing rows keep their job_id; only new standalone rows insert NULL.
alter table public.estimates alter column job_id drop not null;

-- 2. Estimate org-stamping: from the job when linked, else the app-supplied
--    organization_id (the creator always passes it for standalone estimates).
--    set_org_from_job() is LEFT UNTOUCHED — it's shared by ~10 other
--    job-anchored tables (photos, rfis, blueprints, receipts, time_entries,
--    job_subcontractors, job_views, ...) which still require a job.
create or replace function public.set_org_from_job_or_org()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select organization_id into v_org from public.jobs where id = new.job_id;
  else
    v_org := new.organization_id;
  end if;
  if v_org is null then
    raise exception 'Cannot insert %: no job and no organization_id supplied',
      TG_TABLE_NAME;
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;
drop trigger if exists trg_estimates_org on public.estimates;
create trigger trg_estimates_org before insert on public.estimates
  for each row execute function public.set_org_from_job_or_org();

-- 3. Invoice org-stamping: from the job when linked, else from the parent
--    estimate (every invoice insert carries estimate_id — both
--    approve_estimate and the public decide route pass it). Existing
--    job-linked invoices behave identically (the job branch is unchanged).
--    invoices.job_id was already nullable (quotes_invoices.sql); this only
--    adds the fallback for new job-less invoices created on approval.
create or replace function public.set_org_from_job_or_estimate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select organization_id into v_org from public.jobs where id = new.job_id;
  elsif new.estimate_id is not null then
    select organization_id into v_org from public.estimates where id = new.estimate_id;
  end if;
  if v_org is null then
    raise exception 'Cannot insert invoices: no job and no parent estimate organization';
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;
drop trigger if exists trg_invoices_org on public.invoices;
create trigger trg_invoices_org before insert on public.invoices
  for each row execute function public.set_org_from_job_or_estimate();