-- Customer card-on-file columns for Stripe Connect DIRECT charges.
-- Run on Supabase project avmqteevisqxwmmxkrbg (paste from a TEXT EDITOR, not
-- the Supabase SQL Editor — the editor mangles pasted single quotes).
--
-- The per-customer Stripe Customer + saved PaymentMethod live ON the org's
-- connected account (direct charges: the org is merchant of record, the
-- platform is never liable and takes no cut). So stripe_customer_id /
-- stripe_payment_method_id here are connected-account-scoped ids, NOT platform
-- account ids. brand/last4/exp are display-only (so the office UI can show
-- "Visa ····4242 · 12/27" without a Stripe call).
--
-- Idempotent + additive (no RLS change — the Connect webhook writes these via
-- the service role, bypassing RLS; office reads via the session client are
-- already org-scoped by the existing customers RLS).
alter table customers add column if not exists stripe_customer_id text;
alter table customers add column if not exists stripe_payment_method_id text;
alter table customers add column if not exists stripe_card_brand text;
alter table customers add column if not exists stripe_card_last4 text;
alter table customers add column if not exists stripe_card_exp_month smallint;
alter table customers add column if not exists stripe_card_exp_year smallint;