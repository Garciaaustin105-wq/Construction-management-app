-- Lawn Phase 2: crew "My Route" — row-level access for field crew.
--
-- The existing crew policies on lawn_visits / photos / the job-photos storage
-- bucket all key off jobs.assigned_crew (the array on the job). But /lawn/my-route
-- lists visits assigned directly to a crew member via lawn_visits.crew_id, and
-- that crew member may NOT be in the job's assigned_crew array. Without these
-- policies they could not read/update their own visit, nor upload or view the
-- visit's before/after photos.
--
-- All policies are tight: they admit exactly the crew member's OWN visits
-- (crew_id = auth.uid(), same org) and, for photos, only photos whose visit_id
-- is one of their visits — not the whole job. Additive + idempotent. No CHECKs,
-- no RPCs, no DROP COLUMN/TABLE. Re-runnable.

-- ── 1. lawn_visits: crew read + update their own assigned visits ─────────────

-- Crew can READ their own assigned visits (crew_id = me, same org).
drop policy if exists "Crew read my route lawn visits" on public.lawn_visits;
create policy "Crew read my route lawn visits" on public.lawn_visits
  for select to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and crew_id = auth.uid()
  );

-- Crew can UPDATE their own assigned visits (field-status changes only in the
-- app: status / completed_at / notes). WITH CHECK keeps crew_id pinned to them
-- so they cannot drop/reassign a visit. Due-date MOVES stay office-only — the
-- /api/lawn/visits/[id]/status route checks OFFICE_OR_PM and no app surface
-- offers crew a move.
drop policy if exists "Crew update my route lawn visits" on public.lawn_visits;
create policy "Crew update my route lawn visits" on public.lawn_visits
  for update to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and crew_id = auth.uid()
  )
  with check (
    public.same_org(auth.uid(), organization_id)
    and crew_id = auth.uid()
  );

-- Crew can READ a job they're assigned to via a lawn visit (crew_id = me), even
-- if not in jobs.assigned_crew — so /lawn/my-route cards + the visit page show
-- the property name/address. Same org. (Customer name embed may still be null
-- for crew — intentional privacy; the address is what routing needs.)
drop policy if exists "Crew read jobs via lawn visit" on public.jobs;
create policy "Crew read jobs via lawn visit" on public.jobs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.lawn_visits lv
      where lv.job_id = jobs.id and lv.crew_id = auth.uid()
    )
  );

-- Crew can READ the lawn_jobs property profile (gate code / pets / access notes
-- / obstacles) for a job they're assigned to via a visit (crew_id = me), so a
-- field crew can enter the property safely. Same org. lawn_jobs.id IS the job_id
-- (1:1 profile). Office/PM already have tier_office_or_pm manage.
drop policy if exists "Crew read lawn_jobs via visit" on public.lawn_jobs;
create policy "Crew read lawn_jobs via visit" on public.lawn_jobs for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.lawn_visits lv
      where lv.job_id = lawn_jobs.id and lv.crew_id = auth.uid()
    )
  );

-- ── 2. photos table: crew read + insert rows for their own visits ────────────
-- Tight: visit_id must be one of the caller's own visits (crew_id = me). This
-- admits only the crew's own visit photos, not every photo on the job.

drop policy if exists "Crew read lawn-visit photos rows" on public.photos;
create policy "Crew read lawn-visit photos rows" on public.photos for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and visit_id in (
      select id from public.lawn_visits where crew_id = auth.uid()
    )
  );

drop policy if exists "Crew insert lawn-visit photos" on public.photos;
create policy "Crew insert lawn-visit photos" on public.photos for insert
  to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and visit_id in (
      select id from public.lawn_visits where crew_id = auth.uid()
    )
  );

-- ── 3. job-photos storage bucket: crew read + upload for their own visits ───
-- The storage path is "<jobId>/<visitId>/<file>". Pin on segment 2 (the visitId)
-- so a crew member only touches their own visit's folder.

drop policy if exists "Crew read lawn-visit photos" on storage.objects;
create policy "Crew read lawn-visit photos" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'job-photos'
    and exists (
      select 1 from public.lawn_visits lv
      where lv.id::text = split_part(name, '/', 2)
        and lv.crew_id = auth.uid()
    )
  );

drop policy if exists "Crew upload lawn-visit photos" on storage.objects;
create policy "Crew upload lawn-visit photos" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and exists (
      select 1 from public.lawn_visits lv
      where lv.id::text = split_part(name, '/', 2)
        and lv.crew_id = auth.uid()
    )
  );

-- ── 4. BEFORE UPDATE guard: crew may only change status/completed_at/notes ──
-- The "Crew update my route lawn visits" RLS policy admits the ROW (crew_id =
-- me) and its WITH CHECK pins crew_id, but RLS cannot restrict WHICH columns a
-- crew member changes — and the office /status route runs as the AUTHENTICATED
-- user (not service role) and needs to update due_date, so a blanket column
-- REVOKE would break office moves. Instead this trigger blocks non-office users
-- from changing due_date / job_id / recurring_schedule_id / crew_id /
-- organization_id. Office-like users (tier_office_or_pm) pass through unchanged.
-- (raise-in-trigger matches the existing set_org_from_* pattern.)

create or replace function public.guard_lawn_visit_crew_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_is_office boolean;
begin
  -- tier_office_or_pm(organization_id) checks the CALLER's role in this org,
  -- exactly like the "Office manage lawn visits" WITH CHECK.
  select public.tier_office_or_pm(NEW.organization_id) into v_is_office;
  if not v_is_office then
    if NEW.due_date is distinct from OLD.due_date
       or NEW.job_id is distinct from OLD.job_id
       or NEW.recurring_schedule_id is distinct from OLD.recurring_schedule_id
       or NEW.crew_id is distinct from OLD.crew_id
       or NEW.organization_id is distinct from OLD.organization_id then
      raise exception 'Crew may only update status/completed_at/notes on lawn_visits'
        using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_lawn_visit_crew_guard on public.lawn_visits;
create trigger trg_lawn_visit_crew_guard before update on public.lawn_visits
  for each row execute function public.guard_lawn_visit_crew_update();