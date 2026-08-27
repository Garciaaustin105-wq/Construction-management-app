-- harden_function_execute_v3.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- APPLIED LIVE 2026-08-25 via Supabase apply_migration(name: 'harden_function_execute_v3').
-- Follow-up to harden_function_execute.sql (v1) and _v2.sql.
--
-- WHY: the Supabase Security Advisor flagged 19 SECURITY DEFINER functions
-- executable by `anon` and 33 by `authenticated`. v1 deliberately LEFT the RLS
-- policy-helper predicates executable by anon, on the theory that "revoking
-- would break RLS." That theory is wrong: an RLS policy's USING/WITH CHECK
-- expressions run with the TABLE OWNER's privileges, so a SECURITY DEFINER
-- helper called inside a policy does NOT require the querying role
-- (anon/authenticated) to hold EXECUTE on it. The advisor keeps flagging these
-- for exactly this reason. v3 closes the gap.
--
-- SCOPE (NEW revocations in v3, beyond what v1/v2 already did):
--   * 18 RLS policy / storage helper predicates (is_*, tier_*, my_org_id,
--     same_org, lawn_visit_assigned_to, storage_caller_*_job, storage_job_org,
--     storage_sub_org): revoke EXECUTE from PUBLIC + anon. Invoked inside
--     policies, never via direct .rpc() from any route (verified by grep of
--     src/ for `.rpc('...'`) — safe. `authenticated` KEEPS EXECUTE (server
--     routes call some directly via the service-role / session client; harmless
--     to keep, and matches v1's conservative stance).
--   * set_org_from_customer(): trigger-only (like the other set_org_from_* in
--     v1 §1) — revoke from PUBLIC + anon + authenticated (triggers fire as the
--     table owner regardless of EXECUTE grants).
--
-- NOT TOUCHED (intentionally kept):
--   * install_* ISP-module RPCs (install_add_note / _complete / _log_material /
--     _report_problem / _start / _stop): called by authenticated clients from
--     the ISP module. `anon`/`PUBLIC` were ALREADY revoked on these (confirmed
--     via pg_proc grants: only authenticated+postgres+service_role). No change.
--   * storage_caller_assigned_to_install / storage_install_org: anon/PUBLIC
--     already revoked. authenticated kept (storage policy helpers).
--   * Business RPCs (approve_estimate, assign_job_crew, decide_change_order,
--     get_my_tenant, reject_estimate, sign_proposal): anon already revoked;
--     authenticated kept (called by authenticated clients).
--
-- SAFETY VERIFICATION DONE 2026-08-25 before applying:
--   1. get_advisors(security) → 19 anon + 33 authenticated SECURITY DEFINER
--      findings (recorded below as "before").
--   2. grep src/ for `.rpc('<any of these 19 helpers>')` → NO matches. None of
--      the helpers are called directly from a public (anon) token-portal route
--      or any server route, so no anon .rpc() path depends on anon EXECUTE.
--      The helpers are referenced only from RLS policy USING/WITH CHECK
--      clauses (which run as the table owner) and triggers (which fire as the
--      table owner).
--   3. pg_proc signature check → confirmed all 19 live signatures match the
--      REVOKE identity-arg forms below (types only, no param names).
--
-- Idempotent (REVOKE is a no-op if already revoked). No DROP. No function
-- body changes. notify pgrst reloads the PostgREST schema cache so the
-- revoked functions disappear from the anon API surface immediately.
--
-- BEFORE: 19 anon_security_definer_function_executable + 33 authenticated.
-- AFTER : 0  anon + 32 authenticated (set_org_from_customer dropped from the
--         authenticated list; the 18 policy helpers keep authenticated).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Batch 1: role predicate helpers — each takes (uid uuid) ──────────────────
revoke execute on function public.is_accountant(uuid)   from public, anon;
revoke execute on function public.is_management(uuid)   from public, anon;
revoke execute on function public.is_office(uuid)       from public, anon;
revoke execute on function public.is_office_or_pm(uuid) from public, anon;
revoke execute on function public.is_pipeline(uuid)     from public, anon;
revoke execute on function public.is_super_admin(uuid)  from public, anon;
revoke execute on function public.my_org_id(uuid)        from public, anon;

-- ── Batch 2: tier predicate helpers — each takes (org_id uuid) ───────────────
-- (tier_* gate which roles an org has enabled; used inside policies like is_*.)
revoke execute on function public.tier_accountant(uuid)    from public, anon;
revoke execute on function public.tier_management(uuid)    from public, anon;
revoke execute on function public.tier_office(uuid)        from public, anon;
revoke execute on function public.tier_office_or_pm(uuid)  from public, anon;
revoke execute on function public.tier_pipeline(uuid)      from public, anon;

-- ── Batch 3: cross-table helpers ─────────────────────────────────────────────
-- same_org(uid uuid, org_id uuid); lawn_visit_assigned_to(p_job_id uuid, p_uid uuid).
-- Identity-arg form (types only, names dropped) is what REVOKE requires.
revoke execute on function public.same_org(uuid, uuid)               from public, anon;
revoke execute on function public.lawn_visit_assigned_to(uuid, uuid) from public, anon;

-- ── Batch 4: storage policy helpers — each takes (p_name text) ───────────────
revoke execute on function public.storage_caller_assigned_to_job(text) from public, anon;
revoke execute on function public.storage_caller_owns_job(text)         from public, anon;
revoke execute on function public.storage_job_org(text)                 from public, anon;
revoke execute on function public.storage_sub_org(text)                 from public, anon;

-- ── Batch 5: trigger-only fn — revoke from everyone but owner ───────────────
revoke execute on function public.set_org_from_customer() from public, anon, authenticated;

-- Reload PostgREST schema cache so the revoked functions leave the anon API now.
notify pgrst, 'reload schema';

-- ── Verify grants after applying ─────────────────────────────────────────────
-- Every fn below should show authenticated=EXECUTE but NO anon and NO PUBLIC.
-- (set_org_from_customer should show NEITHER anon, PUBLIC, NOR authenticated.)
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args,
--          (select string_agg(grantee||'='||privilege_type, ', ')
--             from information_schema.role_routine_grants g
--            where g.specific_schema='public' and g.routine_name=p.proname) as grants
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public'
--     and p.proname in (
--       'is_accountant','is_management','is_office','is_office_or_pm','is_pipeline',
--       'is_super_admin','my_org_id','same_org','lawn_visit_assigned_to',
--       'storage_caller_assigned_to_job','storage_caller_owns_job',
--       'storage_job_org','storage_sub_org',
--       'tier_accountant','tier_management','tier_office','tier_office_or_pm','tier_pipeline',
--       'set_org_from_customer')
--   order by p.proname;