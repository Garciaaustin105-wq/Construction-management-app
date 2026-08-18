-- harden_function_execute.sql
-- Supabase Database Linter hardening: remove unnecessary direct-RPC EXECUTE
-- grants from anon (and, for trigger-only fns, authenticated) on SECURITY
-- DEFINER functions. Idempotent. No DROP. Run in the CONSTRUCTION project SQL
-- Editor — paste from a text editor (Notepad), NOT the web editor (it mangles
-- single quotes).
--
-- Background: Postgres grants EXECUTE to PUBLIC by default when a function is
-- created, so every SECURITY DEFINER fn was reachable by `anon` via
-- /rest/v1/rpc/<name> even though the defining SQL only did
-- `grant execute to authenticated`. This file tightens that.
--
-- Scope (verified against the app 2026-08-16):
--   * Trigger-only fns (set_org_from_*, guard_*, seed_notification_templates)
--     are fired ONLY by triggers — never called via RPC, never used inside an
--     RLS policy. Triggers execute as the function/table owner regardless of
--     EXECUTE grants, so revoking direct-call rights from everyone is zero-risk.
--   * Business RPCs (approve_estimate, reject_estimate, assign_job_crew) ARE
--     called by the app via the authenticated session client, so authenticated
--     keeps EXECUTE. They each guard internally with auth.uid() (NULL for anon
--     => raise 'Not authorized'), so this is defense-in-depth, not a live fix.
--     anon/public lose EXECUTE.
--   * Policy-helper fns (tier_*, is_*, same_org, my_org_id, lawn_visit_assigned_to,
--     storage_*) are intentionally LEFT executable — RLS policies call them at
--     query time; revoking would break RLS. These linter warnings are expected
--     for the SECURITY DEFINER policy-helper pattern.
--
-- After running: re-run the Supabase Advisor — the anon/authenticated
-- "Security Definer Function Executable" warnings should drop to just the
-- policy-helper set (which we keep on purpose).

-- ── 1. Trigger-only functions: revoke direct EXECUTE from everyone but owner ──
revoke execute on function public.set_org_from_job()              from public, anon, authenticated;
revoke execute on function public.set_org_from_invoice()          from public, anon, authenticated;
revoke execute on function public.set_org_from_estimate()         from public, anon, authenticated;
revoke execute on function public.set_org_from_subcontractor()    from public, anon, authenticated;
revoke execute on function public.set_org_from_change_order()     from public, anon, authenticated;
revoke execute on function public.set_org_from_template()         from public, anon, authenticated;
revoke execute on function public.set_org_from_job_or_estimate()  from public, anon, authenticated;
revoke execute on function public.set_org_from_job_or_org()       from public, anon, authenticated;
revoke execute on function public.guard_job_create()              from public, anon, authenticated;
revoke execute on function public.guard_jobs_variant()            from public, anon, authenticated;
revoke execute on function public.guard_lawn_visit_crew_update()  from public, anon, authenticated;
revoke execute on function public.seed_notification_templates()   from public, anon, authenticated;

-- ── 2. Business RPCs: keep authenticated (app uses the session client),
--       revoke anon + public (defense-in-depth; already guarded by auth.uid()) ──
revoke execute on function public.approve_estimate(uuid)          from public, anon;
revoke execute on function public.reject_estimate(uuid)           from public, anon;
revoke execute on function public.assign_job_crew(uuid, uuid[])   from public, anon;

notify pgrst, 'reload schema';