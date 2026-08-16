-- Terra Vista — in-app notifications feed (estimate accepted / declined / paid).
-- ----------------------------------------------------------------------------
-- Today the only "notification" is a DERIVED unread badge on Home = new photos /
-- RFIs / status changes on jobs since job_views.last_seen_at (see
-- /api/notifications/unread). There is no notifications table and nothing in-app
-- when a customer approves/declines an estimate (only an office email) or pays
-- an invoice (nothing). This adds a real, org-scoped feed so office staff see
-- those customer actions on the dashboard without checking email.
--
-- Model: org-scoped SHARED inbox. One row per customer action; read_at is
-- org-level (one office user visiting Home clears the badge for all office
-- users of that org). Inserted by the service role from the public estimate
-- decision route + the Stripe webhook's applyInvoicePayment — never by an auth
-- user, so no INSERT policy for authenticated roles. Office-like
-- (office/admin/super_admin) same-org can SELECT + UPDATE (mark read). Crew /
-- superintendent / PM never see office notifications.
--
-- Reuses the existing SECURITY DEFINER tier helpers (public.tier_office) so the
-- policy subquery does NOT touch profiles directly → no RLS recursion (see
-- fix_jobs_recursion.sql / [[lowvoltage-rls-recursion]]).
--
-- Additive + idempotent only (no DROP). Safe to re-run.
-- Run BEFORE deploy (paste from a text editor — SQL Editor mangles pasted
-- single quotes into double quotes). Single-quoted literals only.
-- ============================================================================

create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type            text not null,            -- estimate_approved | estimate_rejected | invoice_paid
  title           text not null,
  body            text,
  href            text,                     -- /estimates/{id} | /invoices/{id}
  entity_id       uuid,                     -- estimate_id | invoice_id (dedup key)
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);

-- One notification per (type, entity): a double-click approve / a redelivered
-- webhook can't create a second row. (service-role inserts use
-- onConflict ignoreDuplicates to honor this.)
create unique index if not exists notifications_type_entity_key
  on public.notifications (type, entity_id);

-- Unread badge + recent feed lookups (org-scoped, unread first).
create index if not exists notifications_org_unread_idx
  on public.notifications (organization_id, created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;

-- Office-like members of the org can read the feed. tier_office already
-- encodes (is_office OR is_super_admin) AND same_org, so crew/PM/superintendents
-- outside that set are excluded, and a super_admin (org_id null) is admitted to
-- their platform scope. SECURITY DEFINER → no direct profiles subquery here.
drop policy if exists "office read notifications" on public.notifications;
create policy "office read notifications" on public.notifications
  for select using (public.tier_office(organization_id));

-- Same set may mark notifications read (visiting Home clears the org badge).
drop policy if exists "office mark notifications read" on public.notifications;
create policy "office mark notifications read" on public.notifications
  for update using (public.tier_office(organization_id));

-- No INSERT / DELETE policy for authenticated roles: the service role inserts
-- (decide route + applyInvoicePayment) and bypasses RLS by design.