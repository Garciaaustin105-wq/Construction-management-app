-- lawn_time_model_harden.sql — gate arrival-window writes to office/PM
-- ----------------------------------------------------------------------------
-- WHY: the time-model slice put `scheduled_window_start`/`scheduled_window_end`
-- on lawn_visits (an office scheduling decision: "between 9 and 11"). The visit
-- page gates window EDITING to isOffice in the UI, but RLS + the existing
-- guard_lawn_visit_crew_update trigger do NOT block a crew/superintendent from
-- setting the window via a crafted request — the guard's non-office blocked
-- list was only due_date/job_id/recurring_schedule_id/crew_id/organization_id
-- (it predates the window columns). A wrong window would mislead the customer
-- reminder ("between 9 and 11") and the on-my-way ETA.
--
-- This tightens the guard so non-office users can no longer change the window
-- columns. `started_at` is deliberately NOT added to the blocked list — the
-- Start action is intentionally crew-allowed (a crew member starts their own
-- visit), and it now goes through /api/lawn/visits/[id]/start which stamps
-- server-side anyway. Status/completed_at/notes stay crew-permitted as before.
--
-- `create or replace function` — replaces the existing trigger function in
-- place; the trigger itself (trg_lawn_visit_crew_guard) is unchanged and keeps
-- firing. Idempotent (re-runnable). No DROP, no data loss — passes
-- scripts/check-migrations.mjs (create-or-replace is not flagged).
--
-- Run in the Supabase SQL Editor for project avmqteevisqxwmmxkrbg. Claude-direct
-- owns this file (SQL sign-off). Verify after: a non-office user attempting to
-- update scheduled_window_start/_end should now raise 42501
-- ("Crew may only update status/completed_at/notes/started_at on lawn_visits").
-- ----------------------------------------------------------------------------

begin;

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
       or NEW.organization_id is distinct from OLD.organization_id
       or NEW.scheduled_window_start is distinct from OLD.scheduled_window_start
       or NEW.scheduled_window_end is distinct from OLD.scheduled_window_end then
      raise exception 'Crew may only update status/completed_at/notes/started_at on lawn_visits'
        using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

-- ── Verification (run manually after this file succeeds) ─────────────────────
-- select prosrc from pg_proc where proname = 'guard_lawn_visit_crew_update';
-- -- the function body should now reference scheduled_window_start/_end.

commit;