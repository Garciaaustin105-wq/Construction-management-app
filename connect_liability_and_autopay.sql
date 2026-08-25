-- connect_liability_and_autopay.sql  (idempotent / additive — safe to re-run)
-- ----------------------------------------------------------------------------
-- Two columns that together let lawn autopay ship SAFELY. See
-- docs/handoff-lawn-autopay.md for the full reasoning.
--
-- 1. organizations.connect_losses_owner
--    The platform runs DIRECT charges on connected accounts. Who absorbs an
--    unrecoverable loss (chargeback, refund past balance, fraud) is decided by
--    the account's `controller.losses.payments`, and that property is IMMUTABLE
--    after account creation.
--
--    src/lib/connectAccount.ts creates accounts correctly
--    (losses.payments = "stripe" → Stripe absorbs, platform is not liable).
--    But BOTH existing live accounts predate that code and were created under
--    the older Express integration with losses.payments = "application", which
--    puts the PLATFORM on the hook for those orgs' chargebacks:
--
--      Peanutz L&L (lawn)         acct_1U5HAM…  fully onboarded, charges live
--      Terra Vista (construction) acct_1U585OF… abandoned stub, charges off
--
--    Peanutz is not re-creating their account right now (owner, 2026-08-23), so
--    the app must be safe to run while a live platform-liable account exists.
--    Caching the loss owner here lets both the UI and chargeInvoiceOffSession
--    refuse to expose or run payments for such an org — failing CLOSED (null =
--    never refreshed = treated as liable). refreshConnectAccount() already
--    retrieves the Stripe account object and writes connect_charges_enabled /
--    connect_details_submitted, so populating this costs no extra API call.
--
--    Text, not boolean, so it stores Stripe's own value ("stripe" |
--    "application") rather than our interpretation of it — the raw value is
--    what makes a future audit legible.
--
-- 2. customers.autopay_enabled
--    src/lib/lawnBilling.ts already calls chargeInvoiceOffSession() on EVERY
--    cycle-billed invoice. It is inert today only because no customer has a
--    saved card (nothing in the app links to /api/invoices/save-card/[token]).
--    The moment a card exists, that customer would be auto-charged on every
--    future cycle with no opt-out for them or the office.
--
--    DEFAULT FALSE is the whole point: saving a card must never silently enrol
--    anyone in recurring auto-charging. Consent is explicit and revocable.
--    NOT NULL + DEFAULT is a metadata-only change on PG11+ (no table rewrite).
--
-- Additive + idempotent only (no DROP/TRUNCATE) so it passes
-- scripts/check-migrations.mjs and is safe to re-run. No RLS changes — new
-- columns inherit each table's existing policies, the same way
-- connect_charges_enabled and the stripe_card_* columns were added.
--
-- Ownership: drafted by Opus, signed off + run by the owner 2026-08-23.
-- ----------------------------------------------------------------------------

begin;

alter table public.organizations
  add column if not exists connect_losses_owner text;

alter table public.customers
  add column if not exists autopay_enabled boolean not null default false;

commit;

-- Verification (run after this file succeeds) — expect 2 rows:
--   customers.autopay_enabled            boolean  NO   false
--   organizations.connect_losses_owner   text     YES  null
--
-- select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and (   (table_name = 'organizations' and column_name = 'connect_losses_owner')
--         or (table_name = 'customers'     and column_name = 'autopay_enabled'))
--  order by table_name;
