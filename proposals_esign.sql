-- ============================================================================
-- Terra Vista — Proposals / e-sign (construction NOW-tier #2) schema:
--   • estimates proposal-layer columns (requires_signature, proposal_intro,
--     proposal_accent, signed_proposal_url)
--   • portal_approvals table (signature artifacts: typed text, drawn PNG,
--     signed PDF path, signer name + IP) + RLS
--   • sign_proposal() SECURITY DEFINER RPC (authed-customer e-sign → status
--     'approved' + signature row; mirrors decide_change_order)
--   • proposal-docs private storage bucket (service-role writes + signed-URL
--     reads only)
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
--
-- Run BEFORE deploying the app code that queries these (the new UI would get
-- PostgREST errors if the table/columns/functions did not exist yet). Until
-- then the app degrades gracefully (supabase-js returns {error} not throw).
-- ============================================================================

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. estimates — the proposal layer. A proposal is an estimate with
--    requires_signature = true: the customer must e-sign (typed name + drawn
--    signature) instead of the one-click approve. proposal_intro = cover
--    letter shown above the document; proposal_accent = hex accent (nullable
--    → brand fallback); signed_proposal_url = denormalized pointer to the
--    generated signed PDF (also stored on portal_approvals.signed_pdf_path).
--    The 'approved' status already exists (no enum change).
-- ════════════════════════════════════════════════════════════════════════════
alter table public.estimates
  add column if not exists requires_signature boolean not null default false,
  add column if not exists proposal_intro text,
  add column if not exists proposal_accent text,
  add column if not exists signed_proposal_url text;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. portal_approvals — the e-signature audit record. Generic (document_type +
--    document_id) so CO / invoice e-sign can reuse it later; v1 restricts
--    document_type to 'estimate'. Holds the signature artifacts a pure status
--    flip can't: typed text, drawn-PNG storage path, signed-PDF storage path,
--    signer name + IP. Only the SECURITY DEFINER sign_proposal() RPC writes
--    (no INSERT/UPDATE policy for authenticated — signatures are never
--    client-authored directly).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.portal_approvals (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  job_id              uuid references public.jobs(id) on delete set null,
  document_type       text not null check (document_type in ('estimate')),
  document_id         uuid not null,
  customer_id         uuid not null references public.customers(id) on delete cascade,
  signer_name         text not null,
  signature_text      text not null,
  signature_image_path text,
  signed_pdf_path     text,
  signer_ip           inet,
  action              text not null check (action in ('approved','declined')) default 'approved',
  signed_at           timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index if not exists idx_portal_approvals_doc
  on public.portal_approvals(document_type, document_id);

alter table public.portal_approvals enable row level security;

-- Office / PM read all signatures in their org.
drop policy if exists "Office read portal approvals" on public.portal_approvals;
create policy "Office read portal approvals" on public.portal_approvals
  for select to authenticated
  using (public.tier_office_or_pm(organization_id));

-- Customer reads their own signatures (the proposals they signed).
drop policy if exists "Customer read own portal approvals" on public.portal_approvals;
create policy "Customer read own portal approvals" on public.portal_approvals
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and customer_id in (select customer_id from public.profiles where id = auth.uid())
  );

-- NOTE: no INSERT/UPDATE/DELETE policy for authenticated — sign_proposal()
-- (SECURITY DEFINER) is the only writer. This blocks a client from forging a
-- signature row directly; the RPC's ownership guard is the authority.

-- ════════════════════════════════════════════════════════════════════════════
-- 3. sign_proposal() — the authed-customer e-sign. SECURITY DEFINER so the
--    guard lives in the DB (not the route), mirroring decide_change_order().
--    Caller must be a customer whose profiles.customer_id equals the
--    estimate's customer_id, same_org, status='sent', requires_signature=true.
--    Inserts the portal_approvals row (signature text + image path + signer
--    name + IP) and flips estimates.status='approved' + approved_at. Does NOT
--    create the invoice or the signed PDF — those stay in the TS route
--    (invoice logic is shared via createInvoiceFromEstimate; the PDF needs
--    jspdf, which can't run in SQL). Returns the portal_approvals.id.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.sign_proposal(
  p_estimate_id uuid,
  p_signature_text text,
  p_signature_image_path text,
  p_signer_name text,
  p_signer_ip inet
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_est        public.estimates%rowtype;
  v_customer   uuid;
  v_approval   uuid;
  v_cust_name  text;
  v_job_name   text;
begin
  select * into v_est from public.estimates where id = p_estimate_id;
  if not found then
    raise exception 'Proposal not found';
  end if;
  if v_est.status <> 'sent' then
    raise exception 'This proposal is not awaiting action';
  end if;
  if v_est.requires_signature is not true then
    raise exception 'This estimate is not configured for e-signature';
  end if;

  select customer_id into v_customer from public.profiles where id = auth.uid();
  if v_customer is null then
    raise exception 'Only customer accounts may sign proposals';
  end if;
  if v_est.customer_id is null or v_est.customer_id is distinct from v_customer then
    raise exception 'Not authorized to sign this proposal';
  end if;
  if not public.same_org(auth.uid(), v_est.organization_id) then
    raise exception 'Not authorized: proposal belongs to another organization';
  end if;
  if coalesce(p_signature_text, '') = '' then
    raise exception 'A typed signature is required';
  end if;

  insert into public.portal_approvals (
    organization_id, job_id, document_type, document_id, customer_id,
    signer_name, signature_text, signature_image_path, signer_ip, action
  ) values (
    v_est.organization_id, v_est.job_id, 'estimate', v_est.id, v_customer,
    p_signer_name, p_signature_text, p_signature_image_path, p_signer_ip, 'approved'
  )
  returning id into v_approval;

  update public.estimates
    set status = 'approved',
        approved_at = now(),
        updated_at = now()
    where id = p_estimate_id;

  -- Best-effort office feed notification (reuses the estimate_approved type so
  -- the unique (type, entity_id) index dedups a one-click + e-sign on the same
  -- estimate; the title distinguishes a signed proposal).
  select name into v_cust_name from public.customers where id = v_customer;
  select name into v_job_name  from public.jobs     where id = v_est.job_id;
  insert into public.notifications (organization_id, type, title, body, href, entity_id)
  values (
    v_est.organization_id, 'estimate_approved', 'Proposal signed',
    concat_ws(' · ', v_cust_name, v_job_name),
    '/estimates/' || p_estimate_id::text, p_estimate_id
  )
  on conflict (type, entity_id) do nothing;

  return v_approval;
end;
$$;

grant execute on function public.sign_proposal(uuid, text, text, text, inet) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. proposal-docs storage bucket — PRIVATE. All writes happen server-side in
--    the sign route via the service role (bypasses storage RLS), so NO
--    authenticated storage policies are added: a client can neither upload nor
--    read directly. Reads are via signed URLs minted by the service role
--    (signed URLs bypass storage RLS for GET), served to the office
--    (View signed proposal) and the just-signed customer. This is the most
--    restrictive posture for a legal-signature artifact bucket.
-- ════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('proposal-docs', 'proposal-docs', false)
on conflict (id) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Reload PostgREST schema so the new table/columns/policies/functions are
--    immediately visible to the auto-gen API without a restart.
-- ════════════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verification (run manually in the SQL Editor after this file succeeds):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='estimates'
--     and column_name in ('requires_signature','proposal_intro','proposal_accent','signed_proposal_url');
--     -- 4 rows
--   select count(*) from public.portal_approvals;            -- 0 ok
--   select proname from pg_proc where proname = 'sign_proposal';  -- 1 row
--   select id, public from storage.buckets where id = 'proposal-docs';  -- proposal-docs | false
-- ════════════════════════════════════════════════════════════════════════════