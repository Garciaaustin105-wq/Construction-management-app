-- §1.3 estimate expiry (feature-completeness audit). Applied live 2026-08-26.
-- Reversible (drop + re-add the constraint).
--
-- Adds 'expired' to estimates_status_check so the daily cron
-- /api/estimates/cron/expire can flip a sent estimate to 'expired' once
-- valid_until has passed. Once expired, neither the public /decide route nor
-- the authed approve_estimate RPC can act (both guard on status='sent'). The
-- decide route ALSO checks valid_until directly (410) to close the race on
-- expiry day before the cron runs.

alter table public.estimates drop constraint if exists estimates_status_check;
alter table public.estimates
  add constraint estimates_status_check
  check (status = any (array['draft'::text, 'sent'::text, 'approved'::text, 'converted'::text, 'rejected'::text, 'expired'::text]));