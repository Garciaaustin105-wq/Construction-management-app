-- lawn_services_price_per_sqft.sql
-- Per-service $/sqft rate, so a finished measurement area can price a real
-- line item (sqft x rate) instead of only reporting a square-footage total.
-- Nullable and additive: services without a rate keep working exactly as
-- before (flat default_price only); this is opt-in per service.

alter table public.lawn_services
  add column if not exists price_per_sqft numeric;
