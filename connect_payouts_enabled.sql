-- Track Stripe Connect payouts_enabled on each org, alongside the existing
-- connect_charges_enabled / connect_details_submitted flags. "Fully verified"
-- for accepting online (Pay Here) payments = charges_enabled AND
-- payouts_enabled; gating on payouts too prevents funds from landing in a
-- connected account whose bank/identity isn't finished (money stuck in the
-- Stripe balance with no payout). Idempotent + additive (no DROP).
alter table organizations
  add column if not exists connect_payouts_enabled boolean not null default false;