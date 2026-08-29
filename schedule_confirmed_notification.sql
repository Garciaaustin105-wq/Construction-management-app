-- schedule_confirmed_notification.sql
-- Adds the "schedule_confirmed" customer notification: sent once, the moment
-- a paid estimate creates a recurring_schedules row, describing the service
-- cadence (NOT dated visits -- those come later from the nightly generate
-- cron and aren't crew/zone-assigned yet). Sent from app code
-- (src/lib/customerNotifications.ts: sendScheduleConfirmation), called from
-- both payment paths (Stripe webhook via invoicePay.ts, and the manual
-- office-recorded-payment route) right after an invoice crosses into "paid".
--
-- Same shape as the other 5 notification_templates events (customer_
-- notifications.sql): redefines seed_notification_templates() to include it
-- (so new orgs get it automatically) and backfills existing orgs. Additive +
-- idempotent (on conflict do nothing) -- safe to re-run.

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
     'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is complete. View before/after photos:\n{{photo_link}}\n\n{{re_entry_notice}}\n\nThank you,\n{{org_name}}'),
    ('service_complete','sms', null,
     '{{org_name}}: Lawn service for {{job_name}} is complete. Photos: {{photo_link}}\n{{re_entry_notice}}'),
    ('review_request','email',
     'How was your lawn service? — {{org_name}}',
     'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     '{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}'),
    ('schedule_confirmed','email',
     'Your service schedule is confirmed — {{job_name}}',
     'Hi {{customer_name}},\n\nThanks for your business! Here is your service schedule for {{job_name}}:\n\n{{schedule_summary}}\n\nWe will be in touch before each visit.\n\nThank you,\n{{org_name}}'),
    ('schedule_confirmed','sms', null,
     '{{org_name}}: Your service schedule for {{job_name}} is confirmed: {{schedule_summary}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
  return new;
end $$;

-- Backfill existing orgs (re-runnable). Only the new event -- the other 5
-- are already seeded by customer_notifications.sql.
do $$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select o.id, v.event, v.channel, v.subject, v.body, true
  from public.organizations o
  cross join (values
    ('schedule_confirmed','email',
     'Your service schedule is confirmed — {{job_name}}',
     'Hi {{customer_name}},\n\nThanks for your business! Here is your service schedule for {{job_name}}:\n\n{{schedule_summary}}\n\nWe will be in touch before each visit.\n\nThank you,\n{{org_name}}'),
    ('schedule_confirmed','sms', null,
     '{{org_name}}: Your service schedule for {{job_name}} is confirmed: {{schedule_summary}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
end $$;

notify pgrst, 'reload schema';
