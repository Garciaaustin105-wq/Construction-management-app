-- crew_applicator_license.sql  (idempotent / additive — safe to re-run)
-- ----------------------------------------------------------------------------
-- WHY: we market chemical-application compliance as a lawn differentiator, and
-- the record we produce is genuinely good — chemical_applications captures the
-- product name, EPA registration number, active ingredient, rate, area treated,
-- wind/temp, and the re-entry interval, and /lawn/applications exports the
-- whole thing as CSV for a state inspection.
--
-- But the one field an inspector asks for first is missing: WHO applied it, and
-- were they licensed at the time. chemical_applications.applicator_id points at
-- crew_members, and crew_members has only (name, phone, trade, user_id) — no
-- licence number, no expiry. So the export can name the applicator but cannot
-- evidence their certification. That is a real hole in a feature we sell as a
-- strength.
--
--   applicator_license_number  — the state-issued certification number as
--     printed. Text, not numeric: real licence numbers carry letters, dashes
--     and leading zeros, and vary by state.
--
--   applicator_license_expires — date (no time; certifications expire on a
--     calendar day). Nullable so existing crew rows are unaffected and an
--     unlicensed crew member (a mower who never touches chemicals) stays valid
--     with both columns null.
--
-- Deliberately NOT enforced at the DB level. A NOT NULL or a check constraint
-- would break every existing crew_members row and block adding a crew member
-- who does no chemical work. Whether an EXPIRED licence should block logging an
-- application is a product decision, not a schema one — surface it in the UI
-- first, decide the enforcement later.
--
-- Additive + idempotent only (no DROP/TRUNCATE) so it passes
-- scripts/check-migrations.mjs. No RLS change — new columns inherit
-- crew_members' existing policies, same as every prior column addition.
-- ----------------------------------------------------------------------------

begin;

alter table public.crew_members
  add column if not exists applicator_license_number text,
  add column if not exists applicator_license_expires date;

commit;

-- Verification — expect 2 rows:
--   applicator_license_expires  date  YES
--   applicator_license_number   text  YES
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='crew_members'
--    and column_name like 'applicator_license%'
--  order by column_name;
