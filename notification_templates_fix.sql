-- notification_templates_fix.sql — fix literal-\n bodies + add skipped template
-- ----------------------------------------------------------------------------
-- WHY: customer_notifications.sql seeded template bodies using '\n' inside plain
-- single-quoted SQL strings. Supabase runs standard_conforming_strings = ON, so
-- '\n' stored the LITERAL two characters backslash + n — NOT a newline. The email
-- envelope (renderCustomerEmailHtml) and SMS both split/format on REAL newlines,
-- so every seeded customer email rendered its whole body as one paragraph with
-- visible "\n\n" text ("dashes and random things"). The renderer now normalizes
-- literal \n → real newline (src/lib/customerNotifications.ts renderTemplate),
-- so customer-facing output is fixed by the code change. THIS migration cleans
-- the stored rows so the office editor textarea shows clean text (not "\n\n"),
-- fixes the seed function so FUTURE orgs get real newlines, and ensures the
-- service_skipped template exists for every org (ON CONFLICT DO NOTHING fills
-- gaps; it was already present for existing orgs from earlier work, so the
-- INSERT was a no-op there — wording below mirrors the live rows).
--
-- Safe: UPDATEs only convert \n→newline (wording preserved, office edits
-- preserved); INSERTs are ON CONFLICT DO NOTHING (fill gaps only). No DROP,
-- idempotent, re-runnable. Passes scripts/check-migrations.mjs.
--
-- ⚠️ Paste from a TEXT EDITOR, not the Supabase SQL Editor (it mangles pasted
-- single quotes). Run on project avmqteevisqxwmmxkrbg. Claude-direct owns this
-- file (SQL sign-off).
-- ============================================================================

begin;

-- 1) Fix literal "\n" (backslash+n) → real newline in EVERY existing row's body
--    and subject. replace(NULL, ...) returns NULL, so a null subject stays null.
--    Wording is otherwise unchanged — office edits are preserved.
update public.notification_templates
  set body    = replace(body,    chr(92) || 'n', chr(10)),
      subject = replace(subject, chr(92) || 'n', chr(10))
  where body    like '%' || chr(92) || 'n%'
     or subject like '%' || chr(92) || 'n%';

-- 2) Backfill any missing rows for existing orgs — including the NEW
--    service_skipped pair, which was never seeded. ON CONFLICT DO NOTHING means
--    orgs that already have a row for an event×channel (every org has the
--    original 4 events) are untouched; only gaps are filled. E'...' escape
--    strings make \n a REAL newline regardless of standard_conforming_strings.
do $$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select o.id, v.event, v.channel, v.subject, v.body, true
  from public.organizations o
  cross join (values
    ('visit_reminder','email',
     E'Lawn service scheduled today — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is scheduled for today ({{service_date}}).\n\nThank you,\n{{org_name}}'),
    ('visit_reminder','sms', null,
     E'{{org_name}}: Lawn service for {{job_name}} is scheduled for today ({{service_date}}).'),
    ('on_my_way','email',
     E'Your lawn crew is on the way — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn crew is heading to {{job_name}} and should arrive shortly.\n\n{{org_name}}'),
    ('on_my_way','sms', null,
     E'{{org_name}}: Your lawn crew is on the way to {{job_name}}.'),
    ('service_complete','email',
     E'Lawn service complete — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is complete. View before/after photos:\n{{photo_link}}\n\nThank you,\n{{org_name}}'),
    ('service_complete','sms', null,
     E'{{org_name}}: Lawn service for {{job_name}} is complete. Photos: {{photo_link}}'),
    ('service_skipped','email',
     E'Lawn service skipped — {{job_name}}',
     E'Hi {{customer_name}},\n\nReason: {{reason}}\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'),
    ('service_skipped','sms', null,
     E'{{org_name}}: Reason: {{reason}}. We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.'),
    ('review_request','email',
     E'How was your lawn service? — {{org_name}}',
     E'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     E'{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
end $$;

-- 3) Replace the seed function so NEW orgs (after-insert trigger) get REAL
--    newlines (E'...') and the service_skipped pair. Existing orgs are not
--    re-seeded (ON CONFLICT DO NOTHING inside the function).
create or replace function public.seed_notification_templates()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select new.id, v.event, v.channel, v.subject, v.body, true
  from (values
    ('visit_reminder','email',
     E'Lawn service scheduled today — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is scheduled for today ({{service_date}}).\n\nThank you,\n{{org_name}}'),
    ('visit_reminder','sms', null,
     E'{{org_name}}: Lawn service for {{job_name}} is scheduled for today ({{service_date}}).'),
    ('on_my_way','email',
     E'Your lawn crew is on the way — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn crew is heading to {{job_name}} and should arrive shortly.\n\n{{org_name}}'),
    ('on_my_way','sms', null,
     E'{{org_name}}: Your lawn crew is on the way to {{job_name}}.'),
    ('service_complete','email',
     E'Lawn service complete — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is complete. View before/after photos:\n{{photo_link}}\n\nThank you,\n{{org_name}}'),
    ('service_complete','sms', null,
     E'{{org_name}}: Lawn service for {{job_name}} is complete. Photos: {{photo_link}}'),
    ('service_skipped','email',
     E'Lawn service skipped — {{job_name}}',
     E'Hi {{customer_name}},\n\nReason: {{reason}}\n\nWe had to skip your lawn service for {{job_name}} ({{address}}) scheduled for {{service_date}}. We will reach out to reschedule.\n\n{{org_name}}'),
    ('service_skipped','sms', null,
     E'{{org_name}}: Reason: {{reason}}. We had to skip your lawn service for {{job_name}} ({{service_date}}). We will reach out to reschedule.'),
    ('review_request','email',
     E'How was your lawn service? — {{org_name}}',
     E'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     E'{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
  return new;
end $$;

-- Trigger already exists (trg_seed_notification_templates); no change needed.

-- ── Verify (run manually after) ──────────────────────────────────────────────
-- select event, channel,
--        (body like '%' || chr(92) || 'n%') as still_has_literal_backslash_n,
--        (body like '%' || chr(10) || '%') as has_real_newline
-- from public.notification_templates
-- order by event, channel;
-- -- still_has_literal_backslash_n should be false everywhere;
-- -- has_real_newline true for email bodies (sms bodies are single-line).

notify pgrst, 'reload schema';

commit;