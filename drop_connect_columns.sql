-- drop_connect_columns.sql  (2026-08-18, follow-up #4b)
--
-- Payments pivot cleanup. Stripe Connect (Pay Here) has been fully removed from
-- the app: the customer pay path, the Connect onboarding UI + routes, the
-- webhook's payment branch, and src/lib/invoicePay.ts are all gone. Stripe is
-- now SaaS-subscriptions ONLY — the platform never touches customer money.
-- Receivables sync one-way to the org's OWN bookkeeping provider
-- (QuickBooks / Xero / FreshBooks); the customer pays on that provider's page.
--
-- These four columns on `organizations` were the Stripe Connect onboarding
-- state. No application code references them anymore (verified by grep). This
-- is OPTIONAL cosmetic cleanup — leaving the columns is harmless (they just sit
-- empty). Dropping them is safe because the only DB object that ever gated on
-- them (connect_payouts_enabled.sql) was NEVER run and is deprecated — do NOT
-- run connect_payouts_enabled.sql; it belongs to the removed Pay Here path.
--
-- Run via Notepad paste into the Supabase SQL editor (NOT the web editor — it
-- mangles single quotes). `if exists` makes this idempotent: re-running after
-- the columns are gone is a no-op.

alter table organizations
  drop column if exists stripe_connect_account_id,
  drop column if exists connect_charges_enabled,
  drop column if exists connect_payouts_enabled,
  drop column if exists connect_details_submitted;