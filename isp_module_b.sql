-- isp_module_b.sql
-- ----------------------------------------------------------------------------
-- ISP / fiber module — phase 1b: the CREW FIELD LAYER on installs.
--
-- ⚠️ RUN isp_module.sql FIRST. This file guards on that and stops with a clear
-- message rather than half-applying if you run it out of order.
--
-- WHAT THIS ADDS (Austin's spec: "I want them tapping done ... interactive ...
-- show time on installs, problems with install, install complete, photos" plus
-- "lets also add more crew feedback"):
--   * TIME — crew tap Start / Stop; actual on-site time is recorded per crew
--     member, alongside the office's scheduled window (Austin chose BOTH, so
--     scheduled_at stays and actual time is tracked separately and comparably).
--   * PROBLEMS — crew report a problem from the field. It FLAGS the install for
--     the office; it does NOT block completion (Austin: "flag it, office
--     decides"). Crew are never stranded on site by a minor issue.
--   * COMPLETE — crew tap Done, and pick an OUTCOME: completed / partial /
--     could_not_complete. Anything other than a clean completion routes the
--     install into a follow-up queue instead of silently reading "done".
--   * FIELD NOTES — timestamped free-text notes crew can drop any time.
--     Deliberately separate from problems so a routine observation ("gate code
--     is 4412", "ran line along the east fence") doesn't raise a red flag.
--   * MATERIALS — what got installed or consumed: cable footage, ONT/router
--     serials. Shaped to feed the equipment/inventory phase later.
--   * PHOTOS — crew attach photos to an install, reusing the existing shared
--     `photos` table rather than inventing a second photo system.
--
-- ── HOW CREW WRITE, GIVEN "crews cannot change anything on a job" ──
-- Both rules hold at once: crew never edit the install's DEFINITION (price,
-- address, schedule, customer, type, crew assignment — all office-only), but
-- they do record FIELD ACTIVITY. That's the same split the app already makes:
-- crew have no write policy on `jobs` or `job_tasks`, yet they DO insert photos
-- ("Crew insert photos") and complete lawn visits ("Crew update my route lawn
-- visits").
--
-- Mechanically, crew get NO UPDATE policy on `installs`. Every crew write goes
-- through a SECURITY DEFINER RPC that touches only the columns for that action
-- and re-checks `auth.uid() = any (assigned_crew)` internally — same shape as
-- approve_estimate / assign_job_crew / decide_change_order. A crew UPDATE
-- policy was deliberately NOT used: Postgres row policies cannot restrict WHICH
-- COLUMNS are written, so any policy permissive enough to let crew set `status`
-- would also let them rewrite `price`, `address`, and `assigned_crew`. Column
-- GRANTs can't fix it either, because office and crew are the same database
-- role (`authenticated`). Hence RPCs. Do NOT "simplify" this later by adding a
-- crew UPDATE policy — it silently reopens price editing.
--
-- Idempotent: `if not exists` / `create or replace` / `drop policy if exists`.
-- Run in the Supabase SQL editor — paste from a text editor (Notepad), NOT the
-- web editor (it mangles single quotes).
-- ----------------------------------------------------------------------------


-- ── 0. Ordering guard ──────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.installs') is null then
    raise exception
      'installs table not found — run isp_module.sql first, then re-run this file';
  end if;
end $$;


-- ── 1. Install columns for the field layer ─────────────────────────────────
-- started_at: first time anyone tapped Start (completed_at already exists from
-- isp_module.sql). With scheduled_at these give the office scheduled-vs-actual
-- at a glance with no join.
alter table public.installs
  add column if not exists started_at timestamptz;

-- Denormalised flag so install LISTS can show/sort a problem badge without a
-- correlated subquery per row. Trigger-maintained — never written by the app.
alter table public.installs
  add column if not exists has_open_problem boolean not null default false;

-- How the visit actually ended, as reported by crew on Done.
alter table public.installs
  add column if not exists completion_outcome text;

alter table public.installs
  drop constraint if exists installs_completion_outcome_check;
alter table public.installs
  add constraint installs_completion_outcome_check
  check (completion_outcome is null
         or completion_outcome in ('completed','partial','could_not_complete'));

-- Status gains 'needs_followup'. A partial or could-not-complete visit is NOT
-- "completed" — it lands in its own bucket so the office has a real follow-up
-- queue instead of digging through completed installs looking for the bad ones.
alter table public.installs drop constraint if exists installs_status_check;
alter table public.installs
  add constraint installs_status_check
  check (status in ('scheduled','in_progress','completed','needs_followup','cancelled'));

comment on column public.installs.started_at is
  'First time crew tapped Start. Actual on-site start; compare with scheduled_at.';
comment on column public.installs.has_open_problem is
  'Trigger-maintained: true while any install_issues row for this install is open. Do not write directly.';
comment on column public.installs.completion_outcome is
  'Crew-reported result on Done: completed | partial | could_not_complete. Drives status (completed vs needs_followup).';


-- ── 2. Time entries ────────────────────────────────────────────────────────
-- One row per crew member per on-site session. Multiple rows per install is
-- normal and intended: two techs on one install, or one tech returning after a
-- parts run. Total labour = sum(ended_at - started_at).
create table if not exists public.install_time_entries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  install_id      uuid not null references public.installs(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  created_at      timestamptz not null default now(),
  constraint install_time_entries_range_ck
    check (ended_at is null or ended_at >= started_at)
);

create index if not exists install_time_entries_install_idx
  on public.install_time_entries (install_id, started_at);
create index if not exists install_time_entries_user_idx
  on public.install_time_entries (user_id, started_at);

-- At most ONE open (un-ended) entry per user per install. Stops a double-tap on
-- Start from opening two overlapping sessions and double-counting labour.
create unique index if not exists install_time_entries_one_open_idx
  on public.install_time_entries (install_id, user_id)
  where ended_at is null;

alter table public.install_time_entries enable row level security;

drop policy if exists "office_manage_install_time" on public.install_time_entries;
create policy "office_manage_install_time" on public.install_time_entries for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "management_read_install_time" on public.install_time_entries;
create policy "management_read_install_time" on public.install_time_entries for select
  to authenticated
  using (public.tier_management(organization_id));

-- Crew READ their own entries (field UI shows "clocked in 42 min"). No crew
-- INSERT/UPDATE policy — the RPCs below write these rows as definer.
drop policy if exists "crew_read_own_install_time" on public.install_time_entries;
create policy "crew_read_own_install_time" on public.install_time_entries for select
  to authenticated
  using (public.same_org(auth.uid(), organization_id) and user_id = auth.uid());

grant select, insert, update, delete on public.install_time_entries to authenticated;


-- ── 3. Problems ────────────────────────────────────────────────────────────
create table if not exists public.install_issues (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  install_id      uuid not null references public.installs(id) on delete cascade,
  reported_by     uuid references public.profiles(id) on delete set null,
  description     text not null check (length(btrim(description)) > 0),
  severity        text not null default 'normal'
                  check (severity in ('low','normal','high')),
  status          text not null default 'open'
                  check (status in ('open','resolved')),
  resolved_at     timestamptz,
  resolved_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists install_issues_install_idx
  on public.install_issues (install_id, created_at);
create index if not exists install_issues_open_idx
  on public.install_issues (organization_id, status) where status = 'open';

alter table public.install_issues enable row level security;

-- Office/PM: full control, including resolving. Resolving is a plain RLS UPDATE
-- (status → 'resolved') — no RPC needed, the office already owns the whole row.
drop policy if exists "office_manage_install_issues" on public.install_issues;
create policy "office_manage_install_issues" on public.install_issues for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "management_read_install_issues" on public.install_issues;
create policy "management_read_install_issues" on public.install_issues for select
  to authenticated
  using (public.tier_management(organization_id));

-- Crew READ problems on installs they're assigned to, so the field UI can show
-- what's already reported and they don't file the same thing twice.
drop policy if exists "crew_read_assigned_install_issues" on public.install_issues;
create policy "crew_read_assigned_install_issues" on public.install_issues for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.installs i
      where i.id = install_issues.install_id
        and auth.uid() = any (i.assigned_crew)
    )
  );

grant select, insert, update, delete on public.install_issues to authenticated;

-- Keep installs.has_open_problem in sync. AFTER on every operation, so the
-- office resolving an issue clears the badge too.
create or replace function public.sync_install_open_problem()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install uuid := coalesce(new.install_id, old.install_id);
begin
  update public.installs i
     set has_open_problem = exists (
           select 1 from public.install_issues x
           where x.install_id = v_install and x.status = 'open'
         )
   where i.id = v_install;
  return null;
end;
$$;

revoke execute on function public.sync_install_open_problem() from public, anon, authenticated;

drop trigger if exists trg_sync_install_open_problem on public.install_issues;
create trigger trg_sync_install_open_problem
  after insert or update or delete on public.install_issues
  for each row execute function public.sync_install_open_problem();


-- ── 4. Field notes ─────────────────────────────────────────────────────────
-- Routine observations, kept SEPARATE from install_issues on purpose: a note
-- never sets has_open_problem, so "gate code is 4412" doesn't show the office a
-- red flag. Append-only from the crew's side (no crew UPDATE/DELETE policy) so
-- the field record can't be quietly rewritten after the fact.
create table if not exists public.install_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  install_id      uuid not null references public.installs(id) on delete cascade,
  author_id       uuid references public.profiles(id) on delete set null,
  body            text not null check (length(btrim(body)) > 0),
  created_at      timestamptz not null default now()
);

create index if not exists install_notes_install_idx
  on public.install_notes (install_id, created_at);

alter table public.install_notes enable row level security;

drop policy if exists "office_manage_install_notes" on public.install_notes;
create policy "office_manage_install_notes" on public.install_notes for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "management_read_install_notes" on public.install_notes;
create policy "management_read_install_notes" on public.install_notes for select
  to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "crew_read_assigned_install_notes" on public.install_notes;
create policy "crew_read_assigned_install_notes" on public.install_notes for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.installs i
      where i.id = install_notes.install_id
        and auth.uid() = any (i.assigned_crew)
    )
  );

grant select, insert, update, delete on public.install_notes to authenticated;


-- ── 5. Materials / equipment used ──────────────────────────────────────────
-- What went in or got consumed on this install. Free-text `name` for now rather
-- than an FK to an inventory catalogue, because the equipment/inventory phase
-- isn't designed yet — when it is, add `equipment_id uuid references ...` here
-- and backfill by matching on name. `serial_number` is already carried so ONT /
-- router units are traceable from day one.
create table if not exists public.install_materials (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  install_id      uuid not null references public.installs(id) on delete cascade,
  name            text not null check (length(btrim(name)) > 0),
  quantity        numeric(12,2) check (quantity is null or quantity >= 0),
  unit            text,                       -- 'ft', 'ea', 'roll', ...
  serial_number   text,                       -- ONT / router / modem serial
  added_by        uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists install_materials_install_idx
  on public.install_materials (install_id, created_at);
create index if not exists install_materials_serial_idx
  on public.install_materials (organization_id, serial_number)
  where serial_number is not null;

alter table public.install_materials enable row level security;

drop policy if exists "office_manage_install_materials" on public.install_materials;
create policy "office_manage_install_materials" on public.install_materials for all
  to authenticated
  using (public.tier_office_or_pm(organization_id))
  with check (public.tier_office_or_pm(organization_id));

drop policy if exists "management_read_install_materials" on public.install_materials;
create policy "management_read_install_materials" on public.install_materials for select
  to authenticated
  using (public.tier_management(organization_id));

drop policy if exists "crew_read_assigned_install_materials" on public.install_materials;
create policy "crew_read_assigned_install_materials" on public.install_materials for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.installs i
      where i.id = install_materials.install_id
        and auth.uid() = any (i.assigned_crew)
    )
  );

grant select, insert, update, delete on public.install_materials to authenticated;


-- ── 6. Photos on installs ──────────────────────────────────────────────────
-- Reuses the EXISTING shared `photos` table, already polymorphic (job_id /
-- visit_id / daily_log_id / punch_item_id, all nullable). install_id is simply
-- the next parent column — no second photo system, no second bucket, no
-- duplicate upload code.
alter table public.photos
  add column if not exists install_id uuid references public.installs(id) on delete cascade;

create index if not exists photos_install_id_idx on public.photos (install_id);

-- ⚠️ REQUIRED FIX, not optional polish.
-- photos' BEFORE INSERT trigger `trg_photos_org` currently runs
-- set_org_from_job(), which does:
--     select organization_id into v_org from public.jobs where id = new.job_id;
--     if v_org is null then raise exception '... parent job % not found ...'
-- i.e. it RAISES on any photo whose job_id is null. Installs may legitimately
-- have NO job (a standalone service call), so install photos would fail hard on
-- insert with a confusing "parent job not found" error.
--
-- Replacing the trigger fn with a parent-fallback chain. Verified safe against
-- live data before writing this: all 16 existing photo rows have job_id set and
-- zero rows use visit_id / daily_log_id / punch_item_id — so the job_id branch
-- is byte-identical behaviour for everything that exists today, and the new
-- branches only cover cases that currently just error out. Strictly more
-- permissive; cannot regress an existing flow.
create or replace function public.set_org_from_photo_parent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select organization_id into v_org from public.jobs where id = new.job_id;
  elsif new.install_id is not null then
    select organization_id into v_org from public.installs where id = new.install_id;
  elsif new.visit_id is not null then
    select organization_id into v_org from public.lawn_visits where id = new.visit_id;
  elsif new.daily_log_id is not null then
    select organization_id into v_org from public.daily_logs where id = new.daily_log_id;
  elsif new.punch_item_id is not null then
    select organization_id into v_org from public.punch_items where id = new.punch_item_id;
  end if;

  if v_org is null then
    raise exception
      'Cannot insert photo: no resolvable parent (job, install, lawn visit, daily log, or punch item)'
      using errcode = '23503';
  end if;

  new.organization_id := v_org;
  return new;
end;
$$;

revoke execute on function public.set_org_from_photo_parent() from public, anon, authenticated;

drop trigger if exists trg_photos_org on public.photos;
create trigger trg_photos_org
  before insert on public.photos
  for each row execute function public.set_org_from_photo_parent();

-- Crew may attach photos to installs they're assigned to, and read them back.
-- Mirrors the existing "Crew insert photos" / "Crew photos assigned" pair,
-- resolving through installs.assigned_crew instead of jobs.assigned_crew.
-- Office is already covered: "Office insert photos" / "Office photos select"
-- key off tier_office(organization_id) and never reference job_id.
drop policy if exists "Crew insert install photos" on public.photos;
create policy "Crew insert install photos" on public.photos for insert
  to authenticated
  with check (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.installs i
      where i.id = photos.install_id
        and auth.uid() = any (i.assigned_crew)
    )
  );

drop policy if exists "Crew read install photos" on public.photos;
create policy "Crew read install photos" on public.photos for select
  to authenticated
  using (
    public.same_org(auth.uid(), organization_id)
    and exists (
      select 1 from public.installs i
      where i.id = photos.install_id
        and auth.uid() = any (i.assigned_crew)
    )
  );

-- NOTE: customers currently CANNOT see install photos. The existing "Customer
-- see own photos" policy resolves ownership through job_id only, so a photo on
-- an install (job_id null) is invisible to the customer. Safe default, and it
-- matches "customer portal visibility is still an open question". If install
-- photos should ever be customer-visible, add a policy resolving through
-- installs.customer_id — don't loosen the job one.


-- ── 7. Crew field RPCs ─────────────────────────────────────────────────────
-- Shared authorisation: the caller must be assigned crew on the install, OR
-- office/PM in that org (so the office can correct a mis-tap from the desk).
-- Every function is SECURITY DEFINER with a pinned search_path, touches only
-- the columns its action needs, and is revoked from public + anon per
-- harden_function_execute.sql.

create or replace function public.install_authorize(p_install_id uuid)
returns public.installs
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_install public.installs;
begin
  select * into v_install from public.installs where id = p_install_id;
  if not found then
    raise exception 'Install not found' using errcode = '42704';
  end if;
  if not (
    auth.uid() = any (v_install.assigned_crew)
    or public.tier_office_or_pm(v_install.organization_id)
  ) then
    raise exception 'Not authorized for this install' using errcode = '42501';
  end if;
  return v_install;
end;
$$;

revoke execute on function public.install_authorize(uuid) from public, anon, authenticated;


-- Start / resume: opens a time entry for the caller and moves a scheduled
-- install to in_progress. Idempotent — tapping Start twice does not open a
-- second entry (also enforced by the partial unique index above).
create or replace function public.install_start(p_install_id uuid)
returns public.installs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install public.installs := public.install_authorize(p_install_id);
begin
  if v_install.status = 'cancelled' then
    raise exception 'This install was cancelled' using errcode = '22023';
  end if;
  if v_install.status = 'completed' then
    raise exception 'This install is already complete' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.install_time_entries
    where install_id = p_install_id and user_id = auth.uid() and ended_at is null
  ) then
    insert into public.install_time_entries (organization_id, install_id, user_id)
    values (v_install.organization_id, p_install_id, auth.uid());
  end if;

  update public.installs
     set status     = case when status in ('scheduled','needs_followup')
                           then 'in_progress' else status end,
         started_at = coalesce(started_at, now())
   where id = p_install_id
  returning * into v_install;

  return v_install;
end;
$$;


-- Stop: closes the caller's open time entry WITHOUT completing the install.
-- For a parts run, a lunch break, or a second-visit install.
create or replace function public.install_stop(p_install_id uuid)
returns public.installs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install public.installs := public.install_authorize(p_install_id);
begin
  update public.install_time_entries
     set ended_at = now()
   where install_id = p_install_id
     and user_id = auth.uid()
     and ended_at is null;

  return v_install;
end;
$$;


-- Done. Closes EVERY open time entry on the install (the work is finished for
-- everyone, not just the caller) and records the outcome.
--   'completed'          → status 'completed'
--   'partial' /
--   'could_not_complete' → status 'needs_followup'  (office follow-up queue)
-- Deliberately does NOT check for open problems: a problem flags the install
-- for the office but never strands crew in the field.
-- p_note is optional; when given it's filed as a field note, so the crew's
-- explanation lives next to the outcome instead of in someone's head.
create or replace function public.install_complete(
  p_install_id uuid,
  p_outcome    text default 'completed',
  p_note       text default null
)
returns public.installs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install public.installs := public.install_authorize(p_install_id);
  v_outcome text := lower(coalesce(nullif(btrim(p_outcome), ''), 'completed'));
begin
  if v_install.status = 'cancelled' then
    raise exception 'This install was cancelled' using errcode = '22023';
  end if;
  if v_outcome not in ('completed','partial','could_not_complete') then
    raise exception 'Outcome must be completed, partial, or could_not_complete'
      using errcode = '22023';
  end if;

  update public.install_time_entries
     set ended_at = now()
   where install_id = p_install_id and ended_at is null;

  if length(btrim(coalesce(p_note, ''))) > 0 then
    insert into public.install_notes (organization_id, install_id, author_id, body)
    values (v_install.organization_id, p_install_id, auth.uid(), btrim(p_note));
  end if;

  update public.installs
     set completion_outcome = v_outcome,
         status = case when v_outcome = 'completed'
                       then 'completed' else 'needs_followup' end,
         completed_at = case when v_outcome = 'completed'
                             then coalesce(completed_at, now()) else null end,
         started_at = coalesce(started_at, now())
   where id = p_install_id
  returning * into v_install;

  return v_install;
end;
$$;


-- Report a problem. Flags the install; never blocks completion.
create or replace function public.install_report_problem(
  p_install_id  uuid,
  p_description text,
  p_severity    text default 'normal'
)
returns public.install_issues
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install public.installs := public.install_authorize(p_install_id);
  v_issue   public.install_issues;
  v_sev     text := lower(coalesce(nullif(btrim(p_severity), ''), 'normal'));
begin
  if length(btrim(coalesce(p_description, ''))) = 0 then
    raise exception 'Describe the problem before submitting' using errcode = '22023';
  end if;
  if v_sev not in ('low','normal','high') then
    raise exception 'Severity must be low, normal, or high' using errcode = '22023';
  end if;

  insert into public.install_issues
    (organization_id, install_id, reported_by, description, severity)
  values
    (v_install.organization_id, p_install_id, auth.uid(), btrim(p_description), v_sev)
  returning * into v_issue;

  -- has_open_problem is set by trg_sync_install_open_problem.
  return v_issue;
end;
$$;


-- A timestamped field note. Never flags the install.
create or replace function public.install_add_note(
  p_install_id uuid,
  p_body       text
)
returns public.install_notes
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install public.installs := public.install_authorize(p_install_id);
  v_note    public.install_notes;
begin
  if length(btrim(coalesce(p_body, ''))) = 0 then
    raise exception 'Note cannot be empty' using errcode = '22023';
  end if;

  insert into public.install_notes (organization_id, install_id, author_id, body)
  values (v_install.organization_id, p_install_id, auth.uid(), btrim(p_body))
  returning * into v_note;

  return v_note;
end;
$$;


-- Log a material / piece of equipment used on this install.
create or replace function public.install_log_material(
  p_install_id    uuid,
  p_name          text,
  p_quantity      numeric default null,
  p_unit          text    default null,
  p_serial_number text    default null
)
returns public.install_materials
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_install  public.installs := public.install_authorize(p_install_id);
  v_material public.install_materials;
begin
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Material name is required' using errcode = '22023';
  end if;
  if p_quantity is not null and p_quantity < 0 then
    raise exception 'Quantity cannot be negative' using errcode = '22023';
  end if;

  insert into public.install_materials
    (organization_id, install_id, name, quantity, unit, serial_number, added_by)
  values
    (v_install.organization_id, p_install_id, btrim(p_name), p_quantity,
     nullif(btrim(coalesce(p_unit, '')), ''),
     nullif(btrim(coalesce(p_serial_number, '')), ''),
     auth.uid())
  returning * into v_material;

  return v_material;
end;
$$;


-- The app calls these with the authenticated session client. anon + public get
-- nothing (they'd fail the auth.uid() check anyway — defense in depth, same
-- reasoning as harden_function_execute.sql).
revoke execute on function public.install_start(uuid)                     from public, anon;
revoke execute on function public.install_stop(uuid)                      from public, anon;
revoke execute on function public.install_complete(uuid, text, text)      from public, anon;
revoke execute on function public.install_report_problem(uuid, text, text) from public, anon;
revoke execute on function public.install_add_note(uuid, text)            from public, anon;
revoke execute on function public.install_log_material(uuid, text, numeric, text, text)
  from public, anon;

grant execute on function public.install_start(uuid)                      to authenticated;
grant execute on function public.install_stop(uuid)                       to authenticated;
grant execute on function public.install_complete(uuid, text, text)       to authenticated;
grant execute on function public.install_report_problem(uuid, text, text) to authenticated;
grant execute on function public.install_add_note(uuid, text)             to authenticated;
grant execute on function public.install_log_material(uuid, text, numeric, text, text)
  to authenticated;

notify pgrst, 'reload schema';


-- ----------------------------------------------------------------------------
-- VERIFY
--
--   -- columns added
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='installs'
--     and column_name in ('started_at','has_open_problem','completion_outcome');
--   -- expect 3 rows
--
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='photos'
--     and column_name='install_id';                                    -- 1 row
--
--   -- photos trigger now uses the fallback chain
--   select p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
--   where t.tgrelid='public.photos'::regclass and not t.tgisinternal;
--   -- expect: set_org_from_photo_parent
--
--   -- RPCs exist and anon has no EXECUTE
--   select routine_name, grantee, privilege_type
--   from information_schema.role_routine_grants
--   where routine_name in ('install_start','install_stop','install_complete',
--                          'install_report_problem','install_add_note',
--                          'install_log_material')
--   order by routine_name, grantee;
--   -- expect: authenticated present, anon absent
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname='public'
--     and tablename in ('install_time_entries','install_issues',
--                       'install_notes','install_materials')
--   order by tablename, cmd, policyname;                       -- 3 per table
-- ----------------------------------------------------------------------------
