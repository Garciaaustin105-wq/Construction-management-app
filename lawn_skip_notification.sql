-- Terra Verde — Skipped-visit customer notification.
-- ----------------------------------------------------------------------------
-- Closes the Jobber-parity gap: when a lawn visit is skipped (weather, no
-- access, crew rerouted), the customer was never told. The status route
-- (src/app/api/lawn/visits/[id]/status/route.ts) only fired a customer notice
-- on `done`. This adds a `service_skipped` notification event so the customer
-- gets an email (and SMS once Twilio is configured) when their visit is
-- skipped — by office OR crew (crew can already set status='skipped').
--
-- Adds a parallel one-shot flag `notified_skipped_at` so skip-notices and
-- done-notices dedup INDEPENDENTLY: `done` stamps `notified_at`, `skipped`
-- stamps `notified_skipped_at`. Without this, the single `notified_at` gate
-- would make a done-notice suppress a later skip-notice on the same visit
-- (and vice versa). Once-per-visit-lifetime per event, matching `done` semantics
-- (reopen does not re-notify).
--
-- Also seeds the `service_skipped` email + SMS templates for every existing
-- org and updates seed_notification_templates() so future orgs get them too.
--
-- Additive + idempotent only (no DROP). Run in the Supabase SQL Editor (paste
-- via Notepad — the editor mangles pasted single quotes). Single-quoted
-- literals only; no apostrophes in body copy. Re-runnable. Depends on
-- customer_notifications.sql (templates table + seed trigger) already run.
-- ============================================================================

-- 1) Parallel one-shot flag for the skip notice (mirrors notified_at).
alter table public.lawn_visits
  add column if not exists notified_skipped_at timestamptz;

-- Partial index so the "has this visit been skip-notified?" gate is cheap
-- (same form as idx_lawn_visits_notified on notified_at).
create index if not exists idx_lawn_visits_notified_skipped
  on public.lawn_visits(notified_skipped_at)
  where notified_skipped_at is not null;

-- 2) Replace the seed function to include service_skipped for FUTURE orgs.
--    (The after-insert trigger trg_seed_notification_templates already exists
--    from customer_notifications.sql and calls this function; replacing the
--    function body is all that's needed — the trigger is unchanged.)
create or replace function public.seed_notification_templates()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select new.id, v.event, v.channel, v.subject, v.body, true
  from (values
    ('visit_reminder','email',
     'Lawn service scheduled today — {{job_name}}',
     'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is scheduled for today ({{service_date}}).\n\nThank you,\n{{org_name}}'),
    ('visit_reminder','sms', null,
     '{{org_name}}: Lawn service for {{job_name}} is scheduled for today ({{service_date}}).'),
    ('on_my_way','email',
     'Your lawn crew is on the way — {{job_name}}',
     'Hi {{customer_name}},\n\nYour lawn crew is heading to {{job_name}} and should arrive shortly.\n\n{{org_name}}'),
    ('on_my_way','sms', null,
     '{{org_name}}: Your lawn crew is on the way to {{job_name}}.'),
    ('service_complete','email',
     'Lawn service complete — {{job_name}}',
     'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is complete. View before/after photos:\n{{photo_link}}\n\nThank you,\n{{org_name}}'),
    ('service_complete','sms', null,
     '{{org_name}}: Lawn service for {{job_name}} is complete. Photos: {{photo_link}}'),
    ('service_skipped','email',
     'Lawn service skipped — {{job_name}}',
     'Hi {{customer_name}},\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'),
    ('service_skipped','sms', null,
     '{{org_name}}: We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.'),
    ('review_request','email',
     'How was your lawn service? — {{org_name}}',
     'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     '{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
  return new;
end $$;

-- 3) Backfill the service_skipped templates for EXISTING orgs (idempotent).
do $$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select o.id, v.event, v.channel, v.subject, v.body, true
  from public.organizations o
  cross join (values
    ('service_skipped','email',
     'Lawn service skipped — {{job_name}}',
     'Hi {{customer_name}},\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'),
    ('service_skipped','sms', null,
     '{{org_name}}: We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
end $$;

notify pgrst, 'reload schema';