-- storage_cap.sql
-- ----------------------------------------------------------------------------
-- Per-org STORAGE cap (money leak #1) + seats defense-in-depth trigger.
--
-- PROBLEM: maxStorageBytes (Starter 5GB / Pro 25GB / Business 75-100GB) was
-- display-only in BillingForm — uploads went to Supabase Storage gated by WHO
-- (RLS) but never by HOW MUCH. A 5GB Starter tenant could store unbounded bytes;
-- the Supabase Storage bill passed straight through to the platform.
--
-- FIX: a `storage_bytes` counter on organizations, maintained by triggers on
-- `storage.objects` (the single chokepoint — fires for client AND service-role
-- uploads regardless of which of the ~20 inline upload sites initiated them),
-- with a BEFORE INSERT trigger that hard-blocks an upload that would push the
-- org over its plan cap. The owning org is resolved from the object path via
-- the existing SECURITY DEFINER helpers storage_job_org / storage_sub_org
-- (path's first segment = jobs.id / subcontractors.id) and directly for
-- org-logos / proposal-docs (first segment = organizations.id).
--
-- Caps MIRROR src/lib/plans.ts maxStorageBytes (variant-aware):
--   trial null (unlimited), starter 5GB,
--   pro construction 25GB / lawn 75GB (lawn bumped 2026-08-19 — before/after
--   photos accumulate ~36MB/yard/yr; 25GB stranded a 150-yard Pro in ~4yr),
--   enterprise construction 100GB / lawn 75GB (SOFT — see below), expired/canceled 0.
-- `trial` stays unlimited per existing plans.ts (30-day full access). The
-- residual leak (trial abuse + expired orgs keeping stored files) is a flagged
-- follow-on (trial cap + retention/purge) — sensitive (customer data), separate
-- decision, NOT this file.
--
-- COMPETITIVE CHOICE — Business (enterprise) is SOFT-capped, not hard-blocked.
-- plans.ts storageCustom:true means Business storage is a "call/email for more"
-- soft ceiling. A loyal 200-yard Business customer who keeps years of
-- before/after photos must NOT be locked out at 75GB ("pay more or delete
-- photos" is the bad UX that loses big customers). So enterprise does NOT raise
-- here: the counter still tracks usage (storage_object_added runs), and a
-- nightly probe / the platform can alert the owner to provision more or reach
-- out 1:1 — the storageCustom relationship. Starter/Pro ARE hard-blocked: that
-- is where abuse scales (a 5GB Starter org uploading terabytes) and where the
-- cap protects the thin margin that makes the flat price sustainable. Business
-- ($199-399/mo) absorbs more storage cost (still ~90%+ margin even at 1TB) and
-- has few enough orgs to manage 1:1.
--
-- PREREQ VERIFY (run FIRST in the Supabase SQL editor before this file):
--   select name, bucket_id, metadata->>'size' as size from storage.objects limit 5;
-- `size` MUST be populated. If it's empty/null for real objects, the triggers
-- can neither count nor enforce — switch to Plan B (an app-level upload
-- gateway that sums on the fly) documented in the session plan. Plan A (these
-- triggers) assumes Supabase writes the file size into metadata on upload.
--
-- Idempotent: add column if not exists / drop trigger if exists / create or
-- replace function. Run in the Supabase SQL editor (paste via Notepad to
-- preserve quotes). After running, backfill once:
--   select public.reconcile_org_storage(id) from public.organizations;
-- (the triggers only count NEW writes; existing objects are summed by reconcile.)
--
-- Verify:
--   select tgname, tgtype from pg_trigger where tgrelid = 'storage.objects'::regclass;
-- Expect: trg_guard_storage_object, trg_storage_object_added, trg_storage_object_removed.
--   select column_name from information_schema.columns where table_name='organizations' and column_name='storage_bytes';
--   select id, storage_bytes from organizations order by storage_bytes desc limit 10;
-- ----------------------------------------------------------------------------

alter table public.organizations
  add column if not exists storage_bytes bigint not null default 0;

-- ----------------------------------------------------------------------------
-- Resolve the owning org for a storage object from its (bucket, path).
-- job-photos / blueprints / receipts / submittal-files  -> storage_job_org (jobs.id is first path segment)
-- subcontractor-files                                 -> storage_sub_org (subcontractors.id is first path segment)
-- org-logos / proposal-docs                            -> organizations.id is the first path segment (direct lookup)
-- anything else                                        -> null (unknown: don't block, don't count)
-- ----------------------------------------------------------------------------
create or replace function public.storage_object_org(p_name text, p_bucket text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_bucket in ('job-photos', 'blueprints', 'receipts', 'submittal-files') then
    return public.storage_job_org(p_name);
  elsif p_bucket = 'subcontractor-files' then
    return public.storage_sub_org(p_name);
  elsif p_bucket in ('org-logos', 'proposal-docs') then
    select id into v_org from public.organizations
      where id::text = split_part(p_name, '/', 1);
    return v_org;
  else
    return null;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- BEFORE INSERT: hard-block an upload that would push the org over its cap.
-- Reads size from metadata->>'size' (Supabase writes it on upload). Unknown
-- org / missing size -> allow (can't enforce without the inputs).
-- ----------------------------------------------------------------------------
create or replace function public.guard_storage_object()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_size    bigint;
  v_plan    text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_used    bigint;
  v_max     bigint;
begin
  v_org := public.storage_object_org(new.name, new.bucket_id);
  if v_org is null then
    return new;
  end if;
  v_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  if v_size <= 0 then
    return new;
  end if;

  select plan, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_trial, v_variant
    from public.organizations
    where id = v_org;
  if not found then
    return new;
  end if;

  -- Effective plan (lazy trial expiry, mirrors guard_job_create / billing.ts).
  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  -- maxStorageBytes (mirror src/lib/plans.ts). GB = 1024^3. null = unlimited/no-block.
  -- enterprise (Business) is intentionally null here = SOFT cap: tracked, never
  -- blocked (see the competitive-choice note at the top of this file). The
  -- counter still increments so usage can be monitored/alerted nightly.
  -- pro is variant-aware: lawn 75GB (before/after photos), construction 25GB.
  v_max := case
    when v_eff = 'trial'                       then null
    when v_eff = 'enterprise'                       then null
    when v_eff = 'pro' and v_variant = 'lawn'       then 75::bigint * 1024 * 1024 * 1024
    when v_eff = 'pro'                              then 25::bigint * 1024 * 1024 * 1024
    when v_eff = 'starter'                          then 5::bigint  * 1024 * 1024 * 1024
    when v_eff in ('expired', 'canceled')           then 0::bigint
    else null
  end;

  if v_max is not null then
    select storage_bytes into v_used from public.organizations where id = v_org;
    if coalesce(v_used, 0) + v_size > v_max then
      raise exception 'Storage limit reached (%s) on the %s plan. Remove files or upgrade to upload more.',
        pg_size_pretty(v_max), v_eff;
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- AFTER INSERT: add the object's size to the org counter.
-- ----------------------------------------------------------------------------
create or replace function public.storage_object_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_size bigint;
begin
  v_org := public.storage_object_org(new.name, new.bucket_id);
  if v_org is null then
    return new;
  end if;
  v_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  if v_size <= 0 then
    return new;
  end if;
  update public.organizations
    set storage_bytes = storage_bytes + v_size
    where id = v_org;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- AFTER DELETE: subtract the object's size from the org counter (floor at 0 so
-- drift from a missed add can never go negative).
-- ----------------------------------------------------------------------------
create or replace function public.storage_object_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_size bigint;
begin
  v_org := public.storage_object_org(old.name, old.bucket_id);
  if v_org is null then
    return old;
  end if;
  v_size := coalesce((old.metadata ->> 'size')::bigint, 0);
  if v_size <= 0 then
    return old;
  end if;
  update public.organizations
    set storage_bytes = greatest(0, storage_bytes - v_size)
    where id = v_org;
  return old;
end;
$$;

-- ----------------------------------------------------------------------------
-- Recompute storage_bytes from storage.objects for one org (sum of object
-- sizes whose path resolves to the org). Run manually or nightly to correct
-- trigger drift (e.g. objects created before the triggers existed, or a
-- missed size on insert). Returns the recomputed total.
-- ----------------------------------------------------------------------------
create or replace function public.reconcile_org_storage(p_org uuid)
returns bigint
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_total bigint;
begin
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into v_total
  from storage.objects o
  where public.storage_object_org(o.name, o.bucket_id) = p_org;

  update public.organizations
    set storage_bytes = v_total
    where id = p_org;

  return v_total;
end;
$$;

-- Triggers (all on the internal storage.objects table).
drop trigger if exists trg_guard_storage_object on storage.objects;
create trigger trg_guard_storage_object
  before insert on storage.objects
  for each row execute function public.guard_storage_object();

drop trigger if exists trg_storage_object_added on storage.objects;
create trigger trg_storage_object_added
  after insert on storage.objects
  for each row execute function public.storage_object_added();

drop trigger if exists trg_storage_object_removed on storage.objects;
create trigger trg_storage_object_removed
  after delete on storage.objects
  for each row execute function public.storage_object_removed();

-- Trigger-only: no direct execution (matches plan_limits_v2.sql discipline).
revoke execute on function public.storage_object_org(text, text) from public, anon, authenticated;
revoke execute on function public.guard_storage_object()        from public, anon, authenticated;
revoke execute on function public.storage_object_added()        from public, anon, authenticated;
revoke execute on function public.storage_object_removed()      from public, anon, authenticated;
revoke execute on function public.reconcile_org_storage(uuid)   from public, anon, authenticated;