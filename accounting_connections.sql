-- Terra Vista / Terra Verde — per-org accounting integration connections.
-- ----------------------------------------------------------------------------
-- The payments/bookkeeping pivot (2026-08-17): the platform stops touching
-- customer money. Each org connects its OWN bookkeeping provider (QuickBooks
-- Online first, then Xero / FreshBooks / Wave / Stripe-BYO) via OAuth2. The
-- platform syncs customers / estimates / invoices / payments TO the provider
-- and reads payment status BACK. Tokens are stored ENCRYPTED at rest
-- (encryption/decryption happens in app code with ACCOUNTING_TOKEN_ENCRYPTION_KEY);
-- this table holds only the ciphertext + expiry + provider metadata.
--
-- One row per (org, provider). The service role inserts from the OAuth
-- callback (no INSERT policy for authenticated roles — same model as
-- notifications). office/admin/super_admin (tier_office) read / update (refresh
-- status) / delete (disconnect). PM is intentionally NOT given accounting
-- connect/disconnect — it's an org-owner financial integration.
--
-- Additive + idempotent. Run in the Supabase SQL editor (single-quoted
-- literals; paste from a text editor, not the web editor).
-- ============================================================================
-- Run BEFORE deploying the accounting adapter / QBO OAuth routes.

create table if not exists public.accounting_connections (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null references public.organizations(id) on delete cascade,
  provider                   text not null,  -- 'quickbooks' | 'xero' | 'freshbooks' | 'wave' | 'stripe_byo'
  status                     text not null default 'active',  -- 'active' | 'disconnected' | 'expired'
  realm_id                   text,           -- QBO company realm_id (nullable for non-QBO)
  access_token_encrypted     text,           -- AES-encrypted short-lived access token
  refresh_token_encrypted    text,           -- AES-encrypted long-lived refresh token
  access_expires_at          timestamptz,    -- access token expiry (~60min for QBO)
  refresh_expires_at         timestamptz,    -- refresh token expiry (100-day rolling, 5yr hard for QBO)
  metadata                   jsonb,          -- provider-specific: company_name, connected_user_email, scopes, etc.
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (organization_id, provider)         -- one connection per provider per org
);

create index if not exists idx_accounting_connections_org
  on public.accounting_connections(organization_id);

alter table public.accounting_connections enable row level security;

-- office/admin/super_admin can read, update (status refresh), delete (disconnect).
-- No INSERT policy for authenticated roles — the service role inserts from the
-- OAuth callback (bypasses RLS), mirroring the notifications model.
drop policy if exists "office read accounting connections" on public.accounting_connections;
create policy "office read accounting connections" on public.accounting_connections
  for select to authenticated
  using (public.tier_office(organization_id));

drop policy if exists "office update accounting connections" on public.accounting_connections;
create policy "office update accounting connections" on public.accounting_connections
  for update to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

drop policy if exists "office delete accounting connections" on public.accounting_connections;
create policy "office delete accounting connections" on public.accounting_connections
  for delete to authenticated
  using (public.tier_office(organization_id));

-- updated_at maintenance trigger (reuse the app's set_updated_at if present;
-- guarded so re-run is safe). Keeps refresh/status timestamps honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_accounting_connections_touch on public.accounting_connections;
create trigger trg_accounting_connections_touch
  before update on public.accounting_connections
  for each row execute function public.touch_updated_at();