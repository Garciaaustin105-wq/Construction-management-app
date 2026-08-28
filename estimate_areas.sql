-- estimate_areas.sql
-- Handoff doc docs/handoff-estimator-v2-2026-08-28.md, section 2: multi-area
-- lawn measurement (replaces the single-polygon click-to-draw model, which
-- was shipped in ff6d74f and then rejected by the user as confusing).
--
-- New table: estimate_areas — one row per named/colored drawn polygon.
-- Does NOT touch estimates.measured_sqft/map_lat/map_lng (added by
-- lawn_estimator_convert_on_invoice_paid, already live) — the app layer
-- (src/lib/estimateAreas.ts: syncEstimateTotals) keeps those legacy columns
-- rolled up from estimate_areas so the live convert_estimate_on_invoice_paid
-- trigger keeps working unmodified.
-- RLS mirrors the live rup_purchases pattern (compliance_reviews_items.sql):
-- org-scoped read via profiles, office/PM write via tier_office_or_pm.

create table if not exists public.estimate_areas (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  color text not null default '#22c55e',
  polygon jsonb not null,
  area_sqft numeric not null default 0,
  service_type text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists estimate_areas_estimate_id_idx
  on public.estimate_areas (estimate_id);

alter table public.estimate_areas enable row level security;

create policy "estimate_areas org read" on public.estimate_areas for select
  using (organization_id in (select organization_id from public.profiles where id = auth.uid()));

create policy "estimate_areas office write" on public.estimate_areas for all
  using (tier_office_or_pm(organization_id))
  with check (tier_office_or_pm(organization_id));
