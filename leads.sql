-- Terra Verde — CRM lead pipeline (lawn variant; schema variant-neutral).
-- ----------------------------------------------------------------------------
-- A lead is a PRE-customer prospect captured from a public form
-- (/lead/{lead_form_token}). The office manages them on a pipeline board
-- (/admin/leads): new -> contacted -> quoted -> won | lost. Converting a lead
-- inserts a row into public.customers (the existing guard_customer_create
-- trigger enforces the plan's customer cap — so a free org converting lead #26
-- hits the 25-customer wall, the upgrade nudge). Leads themselves are UNCAPPED
-- (convert-at-wall): the free tier's 25-customer cap gates CONVERSION, not lead
-- capture, so the free plan doubles as a lead-capture tool.
--
-- Variant scope: lawn-only for launch. lead_form_token is generated only for
-- lawn orgs (backfill here + /api/signup lawn branch), so construction orgs have
-- no token and the public form 404s for them. The table + RLS are
-- variant-neutral so construction opts in later by generating tokens — no
-- schema change.
--
-- Office CRUD is client-side via RLS (mirrors customers: no /api/leads/[id]
-- endpoints). The only server write is the PUBLIC capture at /api/leads
-- (service-role, bypasses RLS) + the follow-up cron (service-role).
--
-- Reuses the existing SECURITY DEFINER tier helpers (tier_office_or_pm /
-- tier_management) so policy subqueries never touch profiles directly → no RLS
-- recursion (see fix_jobs_recursion.sql / [[lowvoltage-rls-recursion]]).
-- Additive + idempotent only (no DROP). Safe to re-run. Run BEFORE deploy,
-- pasted from a text editor (the SQL Editor mangles pasted single quotes into
-- double quotes). Single-quoted literals only.
-- ============================================================================

-- 1) Per-org public lead-form token. Lawn orgs get one generated (backfill +
--    /api/signup); construction orgs stay null (no form) for launch. Unguessable
--    uuid text — the only credential a logged-out prospect presents, mirroring
--    lawn_visits.share_token / the /v portal pattern.
alter table public.organizations
  add column if not exists lead_form_token text unique;

-- 2) The lead table.
create table if not exists public.leads (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  name                    text not null,
  contact_name            text,
  email                   text,
  phone                   text,
  address                text,
  service_interest        text,
  source                  text not null default 'website',  -- website|referral|google|other|manual
  referral_detail         text,                              -- who/what referred (name/code/note)
  referred_by_customer_id uuid references public.customers(id) on delete set null,
  status                  text not null default 'new',       -- new|contacted|quoted|won|lost
  assigned_to             uuid references public.profiles(id) on delete set null,
  notes                   text,
  converted_customer_id  uuid references public.customers(id) on delete set null,
  converted_at            timestamptz,
  created_at              timestamptz not null default now(),
  created_by              uuid                              -- null when created by the public form
);

alter table public.leads
  add constraint leads_status_check check (status in ('new','contacted','quoted','won','lost'));
alter table public.leads
  add constraint leads_source_check check (source in ('website','referral','google','other','manual'));

create index if not exists idx_leads_org_status  on public.leads (organization_id, status);
create index if not exists idx_leads_org_created on public.leads (organization_id, created_at desc);

-- 3) RLS. Office/PM full CRUD (matches the page gate requireRole(OFFICE_OR_PM)
--    exactly — avoids the role-gate-mismatch pattern; extending to `sales`
--    would need a tier_pipeline helper, deferred). Management read-only. No
--    public/anon policy: the public form + cron insert via the service role
--    (bypasses RLS).
alter table public.leads enable row level security;

drop policy if exists "lead_office_all" on public.leads;
create policy "lead_office_all" on public.leads
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "lead_management_read" on public.leads;
create policy "lead_management_read" on public.leads
  for select to authenticated
  using (public.tier_management(organization_id));

-- 4) Backfill: every existing LAWN org gets a lead-form token so the board's
--    "copy lead form link" works the moment the feature ships. Construction
--    orgs are left null (no form for launch). Idempotent — re-running only
--    fills orgs still missing a token.
update public.organizations
  set lead_form_token = gen_random_uuid()::text
  where app_variant = 'lawn' and lead_form_token is null;

-- ============================================================================
-- Verify (run after applying):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='leads' order by ordinal_position;
--   select polname, polcmd from pg_policy where polrelid='public.leads'::regclass;
--   select id, app_variant, lead_form_token is not null as has_token
--     from organizations where app_variant='lawn';
-- ============================================================================