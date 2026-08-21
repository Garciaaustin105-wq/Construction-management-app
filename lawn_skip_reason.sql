-- lawn_skip_reason.sql
-- ----------------------------------------------------------------------------
-- Skip-visit polish: lets office/PM/crew record WHY a visit was skipped
-- (weather, no access, customer request, equipment, other + optional note)
-- and surfaces it to the customer in the service_skipped notice. Depends on
-- lawn_skip_notification.sql (notified_skipped_at + service_skipped templates
-- already live) — run AFTER it. Confirmed live before writing this: all 4 orgs
-- still carry the untouched default service_skipped body/sms (no
-- customization yet), so the guarded update below is a no-op risk-wise today,
-- but is written to be safe for whenever an office DOES customize it.
--
-- 1) skip_reason column on lawn_visits — plain text, no enum (the picker sends
--    "preset" or "preset: note"; DB stays schema-agnostic about presets so the
--    UI can add options without a migration).
--
-- 2) Update seed_notification_templates() so FUTURE orgs get the
--    reason-leading service_skipped bodies (full function replace, same
--    pattern as lawn_skip_notification.sql — only the two service_skipped
--    value rows changed, everything else copied verbatim).
--
-- 3) For EXISTING orgs: an INSERT ... ON CONFLICT (organization_id, event,
--    channel) DO UPDATE ... WHERE notification_templates.body = '<old
--    literal>' — conditional upsert. The WHERE is evaluated against the
--    EXISTING row: if an office already customized the body (no longer equals
--    the old literal), the WHERE is false and Postgres leaves that row
--    untouched (no error, no silent overwrite of their edit); only orgs still
--    on the untouched default get the new reason-leading body.
--
-- Additive + idempotent only (no DROP). Run in the Supabase SQL Editor (paste
-- via Notepad — the editor mangles pasted single quotes). Single-quoted
-- literals only; no apostrophes in body copy.
-- ============================================================================

-- 1) skip_reason column.
alter table public.lawn_visits
  add column if not exists skip_reason text;

-- 2) Replace the seed function — only the service_skipped rows changed vs
--    lawn_skip_notification.sql (now lead with {{reason}}).
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
     'Hi {{customer_name}},\n\nReason: {{reason}}\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'),
    ('service_skipped','sms', null,
     '{{org_name}}: Reason: {{reason}}. We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.'),
    ('review_request','email',
     'How was your lawn service? — {{org_name}}',
     'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     '{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
  return new;
end $$;

-- 3) Backfill EXISTING orgs — only if still on the untouched default.
insert into public.notification_templates (organization_id, event, channel, subject, body, active)
select o.id, v.event, v.channel, v.subject, v.body, true
from public.organizations o
cross join (values
  ('service_skipped','email',
   'Lawn service skipped — {{job_name}}',
   'Hi {{customer_name}},\n\nReason: {{reason}}\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'),
  ('service_skipped','sms', null,
   '{{org_name}}: Reason: {{reason}}. We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.')
) as v(event, channel, subject, body)
on conflict (organization_id, event, channel) do update
  -- NOTE: an ON CONFLICT DO UPDATE ... WHERE clause can only see the
  -- conflicting target row and `excluded` (the proposed insert row) — the
  -- source query's alias (`v` here) is out of scope by this point. Use
  -- excluded.channel (== v.channel, since excluded is v's row shape) instead.
  set body = excluded.body
  where notification_templates.body =
    case excluded.channel
      when 'email' then 'Hi {{customer_name}},\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'
      when 'sms' then '{{org_name}}: We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.'
    end;

notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- Verify:
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='lawn_visits' and column_name='skip_reason';
--
--   select organization_id, channel, body from public.notification_templates
--   where event='service_skipped' order by organization_id, channel;
--   -- Expect every row's body to contain 'Reason: {{reason}}' (email) or lead
--   -- with 'Reason: {{reason}}' right after the org prefix (sms) UNLESS an
--   -- office had already customized it away from the old default (those are
--   -- correctly left untouched).
-- ----------------------------------------------------------------------------
