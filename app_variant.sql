-- app_variant.sql — Terra Verde split: org-level variant marker + DB guard.
--
-- Adds an additive organizations.app_variant column ('construction' | 'lawn',
-- default 'construction') so a lawn org is marked as such at signup, plus a
-- SECURITY DEFINER trigger that refuses to let a lawn org create a
-- type='construction' job. This is the server-side backstop BEHIND the UI
-- hiding + middleware: even if a lawn user reaches a construction job creator,
-- the DB rejects the insert. One-directional: construction orgs may still
-- create lawn jobs.
--
-- Idempotent — safe to re-run. Existing orgs default to 'construction' (they
-- were created on the construction app; no backfill needed). RLS on
-- organizations keys only on same_org(auth.uid(), id) + admin role and never
-- selects column lists, so adding this defaulted column changes no policy.
--
-- ⚠️ RUN THIS in the Supabase SQL Editor (paste via Notepad — the web editor
-- mangles pasted single quotes) BEFORE / AT the lawn deploy. The deployed
-- /api/signup writes app_variant the moment the lawn build ships, and the
-- trigger reads it.
--
-- Verified patterns: additive column + check (saas_billing.sql), SECURITY
-- DEFINER trigger (fix_jobs_recursion.sql).

-- 1. Column -------------------------------------------------------------
alter table public.organizations
  add column if not exists app_variant text not null default 'construction';

-- 2. Check constraint (idempotent via DO block — ADD CONSTRAINT has no IF NOT
--    EXISTS in standard PG) --------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'organizations_app_variant_check'
      and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_app_variant_check
      check (app_variant in ('construction', 'lawn'));
  end if;
end
$$;

-- 3. Guard function + trigger (SECURITY DEFINER so it can read the org row
--    regardless of the caller's RLS context) ---------------------------
create or replace function public.guard_jobs_variant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_variant text;
begin
  -- Look up the owning org's variant. SECURITY DEFINER runs as the owner
  -- (postgres), bypassing RLS so this read always succeeds.
  select app_variant
    into v_org_variant
  from public.organizations
  where id = new.organization_id;

  -- If the org doesn't exist yet, let the foreign-key / other constraints
  -- handle it rather than failing here.
  if not found then
    return new;
  end if;

  -- Lawn orgs cannot create or switch to a construction job. Construction
  -- orgs may still create lawn jobs (one-directional by design).
  if v_org_variant = 'lawn' and new.type = 'construction' then
    raise exception 'Lawn organizations cannot create construction jobs'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_jobs_variant_guard on public.jobs;
create trigger trg_jobs_variant_guard
  before insert or update on public.jobs
  for each row
  execute function public.guard_jobs_variant();

-- 4. Quick sanity check (safe to run; returns the column def) -----------
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'organizations'
--    and column_name = 'app_variant';