-- Lawn review-request rating gate (Track 1 of the lawn competitive roadmap).
-- Idempotent — safe to re-run. Run live via the SQL Editor (or paste into a text
-- editor first if the Editor mangles quotes; the leads.sql backfill hit that).
--
-- WHAT: a `review_requests` row is minted when a PAID lawn org marks a visit
-- done (the status route gates on effectiveStatus().plan not in {free,expired}).
-- The row's unguessable uuid `token` is the sole credential for the public
-- /r/{token} intercept page + the public /api/review-feedback submit. Free /
-- expired orgs keep the existing direct-to-Google-Business-Profile behavior
-- (the gate is the Pro upsell). The intercept lets a happy customer (4-5★)
-- through to GBP and routes an unhappy one (1-3★) to internal feedback the
-- office sees — so a bad experience never becomes a public 1★ review.
--
-- RLS: office_or_pm full CRUD + management read. NO public/anon policy — the
-- public intercept page + submit API resolve by token using the SERVICE ROLE
-- (bypass RLS), exactly like leads / the /v photo portal. Reuses the existing
-- SECURITY DEFINER tier_office_or_pm / tier_management helpers (no recursion —
-- mirrors leads.sql).

create table if not exists public.review_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  visit_id uuid references public.lawn_visits(id) on delete set null,
  token uuid not null unique default gen_random_uuid(),
  channel text not null default 'email',         -- email|sms (which link the customer got)
  rating smallint,                                -- 1-5, null until the customer submits
  feedback text,                                  -- unhappy-path note (1-3★)
  status text not null default 'sent',            -- sent|opened|happy|unhappy
  created_at timestamptz not null default now(),
  opened_at timestamptz,                          -- set when /r/{token} first resolves
  completed_at timestamptz                        -- set when the customer submits a rating
);

alter table public.review_requests
  drop constraint if exists review_rating_check;
alter table public.review_requests
  add constraint review_rating_check check (rating is null or rating between 1 and 5);

create index if not exists idx_review_requests_org
  on public.review_requests (organization_id, created_at desc);
create index if not exists idx_review_requests_token
  on public.review_requests (token);

alter table public.review_requests enable row level security;

-- Office/PM: full CRUD on their own org's review requests.
drop policy if exists "review_office_all" on public.review_requests;
create policy "review_office_all" on public.review_requests
  for all to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

-- Management (admin/owner): read-only visibility.
drop policy if exists "review_management_read" on public.review_requests;
create policy "review_management_read" on public.review_requests
  for select to authenticated
  using (public.tier_management(organization_id));

-- NO public/anon policy: the /r/{token} page and /api/review-feedback use the
-- service-role client (bypass RLS); the token is the sole credential. This is
-- the same posture as leads.sql (public capture) and the /v photo portal.