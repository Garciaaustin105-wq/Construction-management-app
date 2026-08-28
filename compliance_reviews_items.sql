-- compliance_reviews_items.sql
-- Handoff doc 04 items 5-17: chemical-compliance + reviews schema additions.
-- Items 8 (CSV export) and 15 (negative-review gate) were ALREADY SHIPPED in
-- the app (/api/lawn/applications/export, /r/[token] ReviewGate) — nothing
-- needed for them here except review_gate_threshold configurability (item 15).
--
-- New tables: rup_purchases (6), applicator_ceu_records (9),
--   noncertified_applicator_training (11), chemical_disposal_records (12),
--   review_platforms (14).
-- New columns: chemical_products.quantity_on_hand (7),
--   crew_members.applicator_license_category (9),
--   lawn_jobs.sensitive_site_tags (10),
--   chemical_applications.supervising_applicator_id + shared_at (11, 13),
--   notification_settings.review_gate_threshold (15),
--   photos.review_request_id (16).
-- RLS mirrors the live crew_time_off / chemical_products policy pattern.

-- ── 6/13. Restricted-use flag on products ────────────────────────────────
alter table public.chemical_products
  add column if not exists is_restricted_use boolean not null default false;

-- ── 6. RUP purchases ─────────────────────────────────────────────────────
create table if not exists public.rup_purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.chemical_products(id) on delete cascade,
  dealer_name text,
  purchase_date date not null default current_date,
  quantity numeric not null default 0,
  unit text,
  certificate_number text,
  supervisor_verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

-- ── 7. Inventory on hand + decrement trigger ─────────────────────────────
alter table public.chemical_products
  add column if not exists quantity_on_hand numeric not null default 0;

create or replace function public.decrement_product_inventory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_id is not null and new.quantity_used is not null
     and new.quantity_used > 0 then
    update public.chemical_products
       set quantity_on_hand = greatest(quantity_on_hand - new.quantity_used, 0)
     where id = new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_decrement_product_inventory on public.chemical_applications;
create trigger trg_decrement_product_inventory
  after insert on public.chemical_applications
  for each row execute function public.decrement_product_inventory();

-- ── 9. License category + CEU records ────────────────────────────────────
alter table public.crew_members
  add column if not exists applicator_license_category text;

create table if not exists public.applicator_ceu_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  crew_id uuid not null references public.crew_members(id) on delete cascade,
  course_name text not null,
  hours numeric not null default 0,
  completed_date date not null default current_date,
  category text,
  notes text,
  created_at timestamptz not null default now()
);

-- ── 10. Sensitive-site flags on lawn jobs ────────────────────────────────
alter table public.lawn_jobs
  add column if not exists sensitive_site_tags text[] not null default '{}';

-- ── 11. Noncertified-applicator supervision ──────────────────────────────
create table if not exists public.noncertified_applicator_training (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  crew_id uuid not null references public.crew_members(id) on delete cascade,
  supervising_applicator_id uuid references public.crew_members(id),
  training_completed_date date not null default current_date,
  training_provider text,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.chemical_applications
  add column if not exists supervising_applicator_id uuid references public.crew_members(id);

-- ── 12. Disposal records ─────────────────────────────────────────────────
create table if not exists public.chemical_disposal_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.chemical_products(id) on delete cascade,
  quantity numeric not null default 0,
  unit text,
  method text,
  disposal_date date not null default current_date,
  disposal_location text,
  disposed_by uuid references public.crew_members(id),
  notes text,
  created_at timestamptz not null default now()
);

-- ── 13. 30-day record-copy tracking ──────────────────────────────────────
alter table public.chemical_applications
  add column if not exists shared_at timestamptz;

-- ── 14. Review platforms ─────────────────────────────────────────────────
create table if not exists public.review_platforms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  platform text not null,
  review_url text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, platform)
);

-- Seed Google from the existing notification_settings column so nothing regresses.
insert into public.review_platforms (organization_id, platform, review_url)
select organization_id, 'google', google_review_url
from public.notification_settings
where google_review_url is not null and google_review_url <> ''
on conflict (organization_id, platform) do nothing;

-- ── 15. Configurable negative-review gate threshold ──────────────────────
alter table public.notification_settings
  add column if not exists review_gate_threshold integer not null default 4;

-- ── 16. Review photos ────────────────────────────────────────────────────
alter table public.photos
  add column if not exists review_request_id uuid references public.review_requests(id) on delete set null;

-- ── RLS: mirror the live crew_time_off org-subquery pattern (reads) + the
-- chemical_products tier_office_or_pm helper pattern (writes) ──────────────

alter table public.rup_purchases enable row level security;
create policy "rup_purchases org read" on public.rup_purchases for select
  using (organization_id in (select organization_id from public.profiles where id = auth.uid()));
create policy "rup_purchases office write" on public.rup_purchases for all
  using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

alter table public.applicator_ceu_records enable row level security;
create policy "ceu org read" on public.applicator_ceu_records for select
  using (organization_id in (select organization_id from public.profiles where id = auth.uid()));
create policy "ceu office write" on public.applicator_ceu_records for all
  using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

alter table public.noncertified_applicator_training enable row level security;
create policy "training org read" on public.noncertified_applicator_training for select
  using (organization_id in (select organization_id from public.profiles where id = auth.uid()));
create policy "training office write" on public.noncertified_applicator_training for all
  using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

alter table public.chemical_disposal_records enable row level security;
create policy "disposal org read" on public.chemical_disposal_records for select
  using (organization_id in (select organization_id from public.profiles where id = auth.uid()));
create policy "disposal office write" on public.chemical_disposal_records for all
  using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));

alter table public.review_platforms enable row level security;
create policy "review_platforms org read" on public.review_platforms for select
  using (organization_id in (select organization_id from public.profiles where id = auth.uid()));
create policy "review_platforms office write" on public.review_platforms for all
  using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));