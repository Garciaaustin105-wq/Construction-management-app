-- Terra Verde — Customer notification suite (lawn variant).
-- ----------------------------------------------------------------------------
-- Templated, opt-in customer SMS/email at visit milestones:
--   visit_reminder (morning-of cron) · on_my_way · service_complete (w/ photo
--   link) · review_request. Adds: notification_templates (office-managed,
--   one row per event×channel, {{token}} bodies), notification_settings (per-org
--   global enable + Google review URL), notification_log (every send attempt,
--   office-readable), customer SMS/email opt-in flags, and lawn_visits.share_token
--   for the public before/after photo portal (/v/{token}).
--
-- Reuses the existing SECURITY DEFINER tier helpers (tier_office /
-- tier_office_or_pm). No policy subqueries into profiles directly → no RLS
-- recursion (see fix_jobs_recursion.sql). Additive + idempotent only (no DROP);
-- safe to re-run. Run BEFORE deploy, pasted from a text editor (the SQL Editor
-- mangles pasted single quotes). Single-quoted literals only.
-- ============================================================================

-- 1) Templates — org-scoped ROOT table (app supplies organization_id; no
--    set_org_from_job trigger). Office manages subject/body/active per
--    event×channel. {{tokens}} substituted by src/lib/customerNotifications.ts.
create table if not exists public.notification_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event           text not null,   -- visit_reminder | on_my_way | service_complete | review_request
  channel         text not null,   -- email | sms
  subject         text,            -- email only (null for sms)
  body            text not null,   -- {{customer_name}} {{job_name}} {{address}} {{service_date}} {{org_name}} {{photo_link}} {{review_link}}
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, event, channel)
);

alter table public.notification_templates enable row level security;
drop policy if exists "office manage notification templates" on public.notification_templates;
create policy "office manage notification templates" on public.notification_templates
  for all to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

-- 2) Settings — one row per org. Office/PM manage the global enable + the
--    Google review URL the review_request template links to. Separate from
--    `organizations` so office/PM (not just admin) can manage it without
--    widening organizations RLS.
create table if not exists public.notification_settings (
  organization_id  uuid primary key references public.organizations(id) on delete cascade,
  enabled          boolean not null default false,
  google_review_url text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.notification_settings enable row level security;
drop policy if exists "office manage notification settings" on public.notification_settings;
create policy "office manage notification settings" on public.notification_settings
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- 3) Log — one row per send attempt (per channel). Office-readable; written by
--    office/PM (session client) from the status/on-my-way routes AND by the
--    service role from the cron (bypasses RLS). status: sent | failed | skipped.
create table if not exists public.notification_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event           text not null,
  channel         text not null,    -- email | sms
  to_contact      text,             -- recipient email or E.164 phone (nullable when skipped)
  entity_type     text not null,    -- visit
  entity_id       uuid,             -- lawn_visits.id
  status          text not null,    -- sent | failed | skipped
  error           text,
  created_at      timestamptz not null default now()
);

create index if not exists notification_log_org_created_idx
  on public.notification_log (organization_id, created_at desc);

alter table public.notification_log enable row level security;
drop policy if exists "office read notification log" on public.notification_log;
create policy "office read notification log" on public.notification_log
  for select to authenticated using (public.tier_office(organization_id));
-- Office/PM insert (session-client path from the status/on-my-way routes).
-- The cron's service-role inserts bypass RLS entirely.
drop policy if exists "office insert notification log" on public.notification_log;
create policy "office insert notification log" on public.notification_log
  for insert to authenticated with check (public.tier_office_or_pm(organization_id));

-- 4) Customer opt-in flags. Email defaults ON (transactional service notices);
--    SMS defaults OFF (TCPA — office must confirm consent per customer).
alter table public.customers
  add column if not exists sms_opt_in boolean not null default false;
alter table public.customers
  add column if not exists email_opt_in boolean not null default true;

-- 5) Public photo-portal token on every visit (unguessable uuid; portal looks
--    it up via the service role). Backfills existing visits.
alter table public.lawn_visits
  add column if not exists share_token uuid default gen_random_uuid();
create index if not exists idx_lawn_visits_share_token
  on public.lawn_visits(share_token);

-- 6) Seed default templates for every existing org (idempotent). New orgs get
--    the same defaults via the after-insert trigger below.
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
    ('review_request','email',
     'How was your lawn service? — {{org_name}}',
     'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     '{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
  return new;
end $$;

drop trigger if exists trg_seed_notification_templates on public.organizations;
create trigger trg_seed_notification_templates after insert on public.organizations
  for each row execute function public.seed_notification_templates();

-- Backfill existing orgs (re-runnable).
do $$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select o.id, v.event, v.channel, v.subject, v.body, true
  from public.organizations o
  cross join (values
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
    ('review_request','email',
     'How was your lawn service? — {{org_name}}',
     'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     '{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
end $$;

notify pgrst, 'reload schema';