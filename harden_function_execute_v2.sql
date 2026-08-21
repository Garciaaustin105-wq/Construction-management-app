-- harden_function_execute_v2.sql
-- Follow-up to harden_function_execute.sql. That file's "Business RPCs" section
-- (approve_estimate, reject_estimate, assign_job_crew) revoked anon/public
-- EXECUTE on the customer/office decision RPCs that existed at the time —
-- decide_change_order(uuid, text) and sign_proposal(uuid, text, text, text,
-- inet) were added later and never got the same treatment. Confirmed live via
-- pg_proc.proacl: both still carry `anon=X/postgres` and the blanket
-- `=X/postgres` (PUBLIC) grant, so both are currently reachable by anon
-- (unauthenticated) via /rest/v1/rpc/decide_change_order and
-- /rest/v1/rpc/sign_proposal.
--
-- Not a live exploit — both functions were read in full and each independently
-- resolves the caller's own customer_id via `select customer_id from profiles
-- where id = auth.uid()`, which is NULL for an anon/unauthenticated caller, so
-- both already raise "Not authorized" / "Only customer accounts may..." before
-- doing anything. This is the same defense-in-depth gap harden_function_
-- execute.sql already closed for approve_estimate/reject_estimate/
-- assign_job_crew — closing it here too for consistency, same reasoning, same
-- pattern. `authenticated` keeps EXECUTE (the app calls these via the session
-- client, and their own auth.uid()-based ownership checks are the real guard).
--
-- Reviewed 2026-08-20 (Claude-direct): signatures verified against
-- portal_messages.sql:132 + proposals_esign.sql:108; both NULL-out-for-anon
-- guards confirmed in-body; pattern matches harden_function_execute.sql §2;
-- policy-helper fns (tier_*/is_*/same_org/storage_*) untouched (RLS needs them).
--
-- Idempotent. No DROP. Run in the Supabase SQL editor (paste from a text
-- editor, not the web editor).

revoke execute on function public.decide_change_order(uuid, text)
  from public, anon;
revoke execute on function public.sign_proposal(uuid, text, text, text, inet)
  from public, anon;

notify pgrst, 'reload schema';

-- Verify (after running, only authenticated rows should remain — anon/public
-- gone for both routines):
--   select routine_name, grantee, privilege_type
--   from information_schema.role_routine_grants
--   where routine_name in ('decide_change_order','sign_proposal')
--   order by routine_name, grantee;