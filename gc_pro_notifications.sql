-- Terra Vista — fire the two GC-pro notifications that were declared in the
-- office feed UI (NotificationsFeed.tsx: daily_log_submitted,
-- punch_item_completed) but never inserted. The office dashboard feed already
-- renders these types with icons + titles; the rows just never got created.
-- ----------------------------------------------------------------------------
-- WHY TRIGGERS (not app code): daily logs and punch items are written by BOTH
-- office (daily-logs/new, punch/new) and crew (crew/daily-log, crew/punch, and
-- the punch [id] advance() "Mark Complete") via direct RLS client inserts /
-- updates. The notifications table has NO INSERT policy for authenticated roles
-- (service-role inserts only — see notifications.sql), so a crew client cannot
-- write a notification row. A SECURITY DEFINER trigger fires as the function
-- owner (postgres, bypasses RLS) regardless of the invoking role, so a crew-
-- submitted daily log / crew-completed punch item still produces the office
-- notification. This mirrors the existing set_org_from_* BEFORE-INSERT stamp
-- triggers (SECURITY DEFINER infra).
--
-- organization_id is stamped onto daily_logs / punch_items by their
-- set_org_from_job BEFORE-INSERT triggers, so NEW.organization_id is populated
-- by the time these AFTER triggers fire. A jobs fallback covers any edge case.
--
-- The unique (type, entity_id) index notifications_type_entity_key makes a
-- re-fire a no-op (ON CONFLICT DO NOTHING) — safe for repeated saves.
--
-- Additive + idempotent (drop trigger if exists before create). Safe to re-run.
-- Run in the Supabase SQL editor (single-quoted literals only — paste from a
-- text editor, not the SQL editor, which mangles quotes).
-- ============================================================================
-- Run AFTER deploy (or before — no app code depends on these existing yet).

create or replace function public.notify_daily_log_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org       uuid;
  v_job_name  text;
begin
  -- organization_id is stamped by the set_org_from_job BEFORE-INSERT trigger;
  -- fall back to a jobs lookup if it is somehow still null.
  v_org := coalesce(
    new.organization_id,
    (select organization_id from public.jobs where id = new.job_id)
  );
  if v_org is null then
    return new;
  end if;

  select name into v_job_name from public.jobs where id = new.job_id;

  insert into public.notifications
    (organization_id, type, title, body, href, entity_id)
  values
    (v_org,
     'daily_log_submitted',
     'Daily log submitted',
     concat_ws(' · ', v_job_name, new.log_date::text),
     '/daily-logs/' || new.id::text,
     new.id)
  on conflict (type, entity_id) do nothing;

  return new;
end;
$$;

create or replace function public.notify_punch_item_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org       uuid;
  v_job_name  text;
begin
  v_org := coalesce(
    new.organization_id,
    (select organization_id from public.jobs where id = new.job_id)
  );
  if v_org is null then
    return new;
  end if;

  select name into v_job_name from public.jobs where id = new.job_id;

  insert into public.notifications
    (organization_id, type, title, body, href, entity_id)
  values
    (v_org,
     'punch_item_completed',
     'Punch item completed',
     concat_ws(' · ', v_job_name, new.title),
     '/punch/' || new.id::text,
     new.id)
  on conflict (type, entity_id) do nothing;

  return new;
end;
$$;

-- Revoke execution from anon/authenticated: these are internal triggers, not a
-- public RPC surface (defense in depth — pairs with harden_function_execute.sql).
revoke execute on function public.notify_daily_log_submitted() from anon, authenticated;
revoke execute on function public.notify_punch_item_completed() from anon, authenticated;

-- Fire once when a daily log is created with status 'submitted'. (Office and
-- crew both insert with status='submitted'; updates to an existing log do not
-- re-fire.)
drop trigger if exists trg_notify_daily_log_submitted on public.daily_logs;
create trigger trg_notify_daily_log_submitted
  after insert on public.daily_logs
  for each row
  when (new.status = 'submitted')
  execute function public.notify_daily_log_submitted();

-- Fire once when a punch item transitions TO 'complete' from any other status
-- (open / in_progress / void). The punch [id] page's advance() and save() both
-- flip status to 'complete' via direct client update; the trigger catches both
-- + any future server path. IS DISTINCT FROM guards against null old.status.
drop trigger if exists trg_notify_punch_item_complete on public.punch_items;
create trigger trg_notify_punch_item_complete
  after update on public.punch_items
  for each row
  when (new.status = 'complete' and old.status is distinct from 'complete')
  execute function public.notify_punch_item_completed();