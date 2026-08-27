# Migration tracking policy

**Established 2026-08-25.** Supersedes the loose-`.sql`-at-repo-root era.

## History

From the project's start through 2026-08-25, every DDL change was applied
**directly to the live Supabase database** (via the SQL editor or `apply_migration`)
and saved as a loose `.sql` file at the **repo root**. ~104 such files exist.

`supabase_migrations.schema_migrations` records only 7 of them
(`blueprints_office_or_pm`, `lawn_skip_reason`, and the `isp_module*` family)
because only those went through a *named* `apply_migration`. The rest were
pasted into the SQL editor, so they were never recorded in migration history.

**Result:** the live database is healthy and up-to-date, but a fresh
environment **cannot** be rebuilt from `supabase_migrations.schema_migrations`
alone — the migration history is incomplete. Replaying the 104 root `.sql`
files in order is *not* a substitute: most are not idempotent, and several
**contradict** each other (a later file undoes or replaces an earlier one —
see "Superseded files" below).

## Policy, from now on

1. **The baseline is the source of truth.** `docs/schema-baseline-2026-08-25.sql`
   is a full `--schema-only` dump of the live database as of 2026-08-25. It
   captures every table, column, policy, function, trigger, and grant that
   exists in production. A fresh environment should be created from this
   baseline (restore into a new Supabase project, or apply it to a local
   Postgres), **not** by replaying the 104 root `.sql` files.

2. **Every DDL change goes through `apply_migration` with a recorded name.**
   No more pasting into the SQL editor. The Supabase MCP `apply_migration`
   tool (or `supabase migration new <name>` + `supabase db push`) records the
   change in `supabase_migrations.schema_migrations` so the history is
   complete and replayable from this point forward.

3. **Migration names are descriptive, kebab-case, and unique.** Example:
   `harden_function_execute_v3`, `lawn_time_model`, `add_applicator_license`.
   Match the root `.sql` filename when one exists, so the paper trail stays
   traceable.

4. **Idempotency is required for new migrations.** Use `create table if not
   exists`, `add column if not exists`, `drop policy if exists`, etc. The
   legacy root files are NOT idempotent — that's why they can't be replayed.
   New ones must be.

5. **The root `.sql` files are frozen.** Do not edit them to "fix" history.
   They are kept as a historical record of what was applied and when. New
   DDL lives in a named migration only.

6. **This repo does not run `supabase db push` from `supabase/migrations/`.**
   There is no `supabase/migrations/` directory and no local migration
   framework in CI. DDL is applied to the hosted Supabase project
   (`avmqteevisqxwmmxkrbg`) via MCP `apply_migration`. (If a local-Postgres
   dev workflow is added later, generate it from the baseline, not from the
   root files.)

## What counts as "DDL"

Tables, columns, indexes, constraints, RLS policies, functions, triggers,
grants, storage policies, enums, views, sequences. **Not** data (seed rows,
notification templates) unless the seed is part of a migration.

## Superseded / dead root `.sql` files

See `docs/superseded-sql-files.md` for the categorized list of root `.sql`
files that are **superseded** by a later file (safe to delete in a future
cleanup, after confirming against the live schema) and those that are
**dead** (referenced a table/column/policy that has since been dropped).

The cleanup itself is a separate, deliberate step — this policy does not
delete anything. Deletion happens only after a reviewer confirms the
baseline already contains the surviving DDL and the superseded file adds
nothing live.