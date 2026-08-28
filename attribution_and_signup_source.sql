-- Signup source attribution: which channel a new org's signup came from
-- (Google Ads, organic blog link, a Facebook mention, etc). Populated by
-- src/app/api/signup/route.ts from utm_* params + referrer captured client-
-- side at src/lib/attribution.ts. All nullable — a direct/no-campaign signup
-- has none of these set, which is itself meaningful (organic/direct traffic).
alter table public.organizations
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_term text,
  add column if not exists utm_content text,
  add column if not exists signup_referrer text;
