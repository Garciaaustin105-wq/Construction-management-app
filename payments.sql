-- payments.sql
-- ----------------------------------------------------------------------------
-- Cash / check / other payments recorded against an invoice. Shared by BOTH
-- variants (lawn cycle billing + construction invoices both create invoices).
-- The platform never touches customer money (Stripe is SaaS subs ONLY — see
-- the payments-pivot decision); these rows record OFFLINE payments the office
-- received directly (cash, check, other) so the invoice's amount_paid /
-- balance / paid status stay accurate without a payment processor.
--
-- MIRRORS the LIVE invoices RLS (multi_tenancy_b.sql:502-515), NOT the stale
-- quotes_invoices.sql `is_office` policy. The live invoices write gate is
-- `tier_office_or_pm(organization_id)` (org-scoped: office / admin /
-- project_manager / super_admin, all same-org). Customers read their own
-- invoices' payments; accountants (read-only financials) read org payments.
--
-- `organization_id` is app-supplied (root-style, like lawn_services / invoices):
-- the recording API reads it from the invoice and stamps it on the payment
-- row. No trigger writes it. RLS `tier_office_or_pm(organization_id)` on the
-- INSERT enforces the caller is office-or-pm in that org.
--
-- amount_paid reconciliation (v1, insert-only): the API does NOT recompute
-- amount_paid = sum(payments) from scratch, because `invoices.amount_paid` is
-- seeded with the estimate deposit on approval (invoice_deposit_applied.sql)
-- — or 0 for deposit-owed invoices (approve_deposit_invoice.sql) — and the
-- deposit is NOT a payment row. A from-scratch sum would clobber the deposit
-- and UNDERSTATE what the customer paid. Instead the API ACCUMULATES:
--   new_amount_paid = invoices.amount_paid + payment.amount
-- which is money-correct for both deposit flows and never touches existing
-- rows. v1 is insert-only (no payment edit/delete UI); a future delete/edit
-- path must switch to a full recompute with a stored deposit baseline.
--
-- Run once in the Supabase SQL editor (paste via Notepad to preserve quotes).
-- Idempotent: `create table if not exists` + `drop policy if exists`.
-- ----------------------------------------------------------------------------

create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id      uuid not null references public.invoices(id) on delete cascade,
  amount          numeric(12,2) not null check (amount > 0),
  method          text not null check (method in ('cash','check','other')),
  reference       text,                                   -- check number, etc. (optional)
  paid_at         timestamptz not null default now(),      -- when the customer paid (defaults to now)
  recorded_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists payments_invoice_id_idx   on public.payments(invoice_id);
create index if not exists payments_org_paid_at_idx  on public.payments(organization_id, paid_at);

alter table public.payments enable row level security;

-- Office / admin / PM / super_admin (same-org) can do everything (insert the
-- recorded payment; select to list; future delete/edit). Mirrors
-- office_invoices_all (multi_tenancy_b.sql:505).
drop policy if exists "office_payments_all" on public.payments;
create policy "office_payments_all" on public.payments for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- A customer can read the payments on THEIR invoices (so a customer-facing /
-- public invoice view can show what's been paid). Mirrors customer_invoices
-- _select (multi_tenancy_b.sql:510) but resolves ownership through the invoice
-- (payments has no customer_id column).
drop policy if exists "customer_payments_select" on public.payments;
create policy "customer_payments_select" on public.payments for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.invoices i
      where i.id = payments.invoice_id
      and i.customer_id in (
        select customer_id from public.profiles where id = auth.uid()
      )
    )
  );

-- Accountant (read-only financials, same-org) can read payments — same
-- audience that reads invoices (roles_expand.sql:151 "Accountant read
-- invoices"). No write for accountants.
drop policy if exists "accountant_payments_select" on public.payments;
create policy "accountant_payments_select" on public.payments for select
  to authenticated
  using (public.tier_accountant(organization_id));

grant select, insert, update, delete on public.payments to authenticated;
-- No sequence grant: `id` is uuid default gen_random_uuid() (a function default,
-- NOT a serial/identity column), so no payments_id_seq exists. RLS gates all access.

-- ----------------------------------------------------------------------------
-- Verify:
--   select policyname, cmd, qual
--   from pg_policies
--   where schemaname = 'public' and tablename = 'payments'
--   order by cmd;
-- Expect: office_payments_all (ALL, tier_office_or_pm),
--         customer_payments_select (SELECT, same_org + invoice ownership),
--         accountant_payments_select (SELECT, tier_accountant).
-- ----------------------------------------------------------------------------