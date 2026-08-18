-- Terra Vista / Terra Verde — scheduling-only crew members (no app login).
-- ============================================================================
-- Decouples "crew assigned to a visit" (lawn_visits.crew_id) from "auth user
-- who downloaded the app" (profiles). A crew_member MAY link to a real auth
-- user (user_id → profiles) — when it does, that app-user crew sees the visit
-- in My Route. When user_id is null, it's a scheduling-only crew: the office
-- assigns + marks their visits done; they never log in. This serves the crews
-- who "aren't tech-savvy or don't want to download the app."
--
-- FULL MIGRATION (chosen 2026-08-17): lawn_visits.crew_id FK moves
-- profiles(id) → crew_members(id). One canonical assignment field.
--
-- THE KEY TRICK that makes this safe on live data + live RLS: every existing
-- crew/superintendent auth user is seeded a crew_members row whose `id` EQUALS
-- their profiles.id, and a profiles trigger auto-creates the same for every
-- future crew/superintendent. So for any LINKED crew member,
-- `crew_members.id === auth.uid()` — which means every existing
-- `lawn_visits.crew_id = auth.uid()` RLS policy (lawn_crew_route.sql +
-- fix_jobs_recursion.sql) KEEPS WORKING UNCHANGED. Scheduling-only members get
-- fresh random ids (no auth.uid() → never matched by crew RLS → correctly
-- office-managed only). No RLS policy is rewritten; no lawn_visits row is
-- updated. The only app changes are the crew PICKER (read crew_members instead
-- of profiles) + crew name DISPLAY + a new office admin page to add
-- scheduling-only members.
--
-- Idempotent + additive. Run in the Supabase SQL editor (single-quoted
-- literals; paste from a text editor, not the web editor which mangles quotes).
-- ============================================================================
-- Run BEFORE deploying the crew_members app code (the FK swap is what the new
-- picker + admin page expect). Until you run this, the app still reads the old
-- profiles-based picker — safe either way.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. crew_members table
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.crew_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  phone           text,
  trade           text,
  -- Nullable link to a real auth user. null = scheduling-only (no app login).
  -- For seeded/trigger-created rows this EQUALS profiles.id, and crew_members.id
  -- also equals profiles.id — that's what keeps `crew_id = auth.uid()` RLS valid.
  user_id         uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One crew_member per auth user per org. NULLs are distinct in Postgres, so
  -- many scheduling-only members (user_id null) coexist in one org.
  unique (organization_id, user_id)
);

create index if not exists idx_crew_members_org
  on public.crew_members(organization_id);
-- Fast "which crew_member am I?" lookup for crew My Route / status ownership.
create index if not exists idx_crew_members_user
  on public.crew_members(user_id) where user_id is not null;

alter table public.crew_members enable row level security;

-- All authenticated users in the org can read crew_members (crew need to resolve
-- their own id + display names; office manages them). Only office/admin/super
-- can create/edit/delete (scheduling-only members are an office concern).
drop policy if exists "same org read crew members" on public.crew_members;
create policy "same org read crew members" on public.crew_members
  for select to authenticated
  using (public.same_org(auth.uid(), organization_id));

drop policy if exists "office insert crew members" on public.crew_members;
create policy "office insert crew members" on public.crew_members
  for insert to authenticated
  with check (public.tier_office(organization_id));

drop policy if exists "office update crew members" on public.crew_members;
create policy "office update crew members" on public.crew_members
  for update to authenticated
  using (public.tier_office(organization_id))
  with check (public.tier_office(organization_id));

drop policy if exists "office delete crew members" on public.crew_members;
create policy "office delete crew members" on public.crew_members
  for delete to authenticated
  using (public.tier_office(organization_id));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. BEFORE INSERT trigger: stamp organization_id from the creating office user
--    when not supplied (mirrors set_org_from_*). Service-role inserts pass
--    organization_id explicitly → no-op. SECURITY DEFINER so the helper's own
--    profiles read isn't blocked by RLS.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.set_org_from_crew_member()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_org uuid;
begin
  if new.organization_id is null then
    select organization_id into v_org from public.profiles where id = auth.uid();
    if v_org is null then
      raise exception 'Cannot insert crew_members: no organization and caller has no profile org',
        using errcode = '23503';
    end if;
    new.organization_id := v_org;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crew_members_org on public.crew_members;
create trigger trg_crew_members_org before insert on public.crew_members
  for each row execute function public.set_org_from_crew_member();

-- updated_at maintenance (re-use the shared helper if present; guarded).
create or replace function public.touch_updated_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_crew_members_touch on public.crew_members;
create trigger trg_crew_members_touch
  before update on public.crew_members
  for each row execute function public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Backfill: seed crew_members for every existing crew/superintendent profile
--    AND every profile currently referenced by lawn_visits.crew_id. Use
--    id = profiles.id + user_id = profiles.id so:
--      (a) existing lawn_visits.crew_id values now point at a real crew_members
--          row (the FK swap below succeeds with ZERO lawn_visits updates), and
--      (b) crew_members.id === auth.uid() for linked crew → existing
--          `crew_id = auth.uid()` RLS keeps working unchanged.
--    ON CONFLICT (organization_id, user_id) DO NOTHING keeps re-runs safe.
-- ────────────────────────────────────────────────────────────────────────────
insert into public.crew_members (id, organization_id, name, phone, user_id)
select p.id, p.organization_id, coalesce(nullif(trim(p.full_name), ''), 'Crew'),
       p.phone, p.id
from public.profiles p
where p.id in (
  select id from public.profiles where role in ('crew', 'superintendent')
  union
  select crew_id from public.lawn_visits where crew_id is not null
)
on conflict (organization_id, user_id) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Swap the lawn_visits.crew_id FK: profiles(id) → crew_members(id).
--    Values are unchanged (backfill made id = profiles.id), so no row update.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.lawn_visits
  drop constraint if exists lawn_visits_crew_id_fkey,
  add constraint lawn_visits_crew_id_fkey
    foreign key (crew_id) references public.crew_members(id) on delete set null;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Profiles trigger: keep crew_members in sync with crew/superintendent
--    profiles going forward. On INSERT of a crew/superintendent profile (and on
--    UPDATE of role/name/phone/org), upsert a crew_members row with
--    id = profiles.id + user_id = profiles.id. This populates the picker for new
--    hires AND preserves crew_members.id === auth.uid() so `crew_id = auth.uid()`
--    RLS stays valid for them too. Rows for non-crew roles are never created.
--    SECURITY DEFINER so the upsert isn't blocked by crew_members RLS.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.sync_crew_member_from_profile()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(new.role, '') in ('crew', 'superintendent') then
    insert into public.crew_members (id, organization_id, name, phone, user_id)
    values (new.id, new.organization_id,
            coalesce(nullif(trim(new.full_name), ''), 'Crew'),
            new.phone, new.id)
    on conflict (organization_id, user_id) do update
      set name   = excluded.name,
          phone  = excluded.phone,
          organization_id = excluded.organization_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_crew_member_on_profile on public.profiles;
create trigger trg_sync_crew_member_on_profile
  after insert or update of role, full_name, phone, organization_id
  on public.profiles
  for each row execute function public.sync_crew_member_from_profile();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Defense-in-depth: revoke anon/authenticated direct RPC execute on the new
--    SECURITY DEFINER helpers (they're trigger-only). Mirrors
--    harden_function_execute.sql.
-- ────────────────────────────────────────────────────────────────────────────
revoke execute on function public.set_org_from_crew_member()        from public, anon, authenticated;
revoke execute on function public.sync_crew_member_from_profile()   from public, anon, authenticated;
revoke execute on function public.touch_updated_at()                from public, anon, authenticated;