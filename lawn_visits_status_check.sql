-- §5.1 (feature-completeness audit): lawn_visits.status is the ONLY status
-- column in the database with no CHECK constraint — every other status column
-- has one. The lifecycle module (src/lib/lifecycles/lawn-visit.ts) has been the
-- sole enforcement source so far, but one bad write from any future code path
-- (a raw update, a migration, a script) and nothing catches it. This adds the
-- same domain guard at the DB level. Reversible (drop + re-add).
--
-- Applied live 2026-08-26. Verified no existing rows violate it before applying
-- (live statuses were only pending/done/skipped; 'paused' is also allowed).

alter table public.lawn_visits drop constraint if exists lawn_visits_status_check;
alter table public.lawn_visits
  add constraint lawn_visits_status_check
  check (status = any (array['pending'::text, 'done'::text, 'skipped'::text, 'paused'::text]));