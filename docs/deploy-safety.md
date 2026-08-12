# Deploy & Safety Infrastructure

How we keep paying customers from going down or losing data when we ship an
update. Four layers, in order of how often you'll reach for them:

1. **Migration guardrails** — stop a data-killing migration before it ships.
2. **Staging environment** — catch bugs on a preview deployment + separate DB
   before customers see them.
3. **Rollback runbook** — when something does break, revert in ~1 minute.
4. **Scripted DB backups** — if data is lost despite all the above, restore from
   a nightly dump.

---

## 1. Migration guardrails

**The problem:** a migration like `DROP TABLE quotes` or `TRUNCATE receipts`
destroys live customer data the moment it runs in Supabase SQL Editor, and
nothing currently stops it.

**The guard:** `scripts/check-migrations.mjs` scans every `.sql` file in the
repo root and exits non-zero if it finds an unambiguous data killer:
`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP SCHEMA`, `DROP DATABASE`.

It intentionally does **not** flag idempotent DDL we use every day —
`drop policy if exists`, `drop index if exists`, `create or replace function`,
`drop constraint`. Those destroy no user data.

`DELETE`/`UPDATE` without `WHERE` are not auto-flagged because legitimate
migrations touch config tables that way (e.g. setting a storage bucket
`public = false`). Review those by hand.

**Where it runs:**

- **Locally, before push** (do this every time you touch `.sql`):
  ```sh
  node scripts/check-migrations.mjs
  ```
- **CI** — `.github/workflows/migration-guard.yml` runs on every PR and push to
  `main` that changes a `.sql` file. On a PR it blocks merge; on `main` it
  surfaces a loud red check after the fact (Vercel deploys main before CI
  finishes, so the local check is the one that actually protects production).

**If a flagged statement is intentional** (you confirmed the table is empty /
the column is dead): run `node scripts/check-migrations.mjs --allow-destructive`
to proceed. Use this sparingly and only after verifying there's no live data in
the object.

**Standing migration workflow (unchanged):** one migration in flight at a
time. You run the SQL in Supabase SQL Editor → it returns "Success" → then we
push code that depends on it. Never push code that queries a new column/table
before the SQL has run. Migrations stay idempotent (`if not exists` /
`drop policy if exists`).

---

## 2. Staging environment

We don't push straight to production. Two pieces:

### a. Vercel preview deployments (already on — no setup)

Every pull request gets its own preview URL on Vercel automatically. Open a
PR instead of pushing to `main`, and Vercel builds a throwaway deployment you
can click through. Merging the PR promotes it to production.

**Adopt the habit:** even for solo work, branch → PR → review the preview
deployment → merge. This is the single biggest thing you can do to stop
shipping breakages. The migration guard runs on PRs too, so a destructive
migration is caught at PR time, not after deploy.

### b. Separate staging Supabase project (one-time setup)

A preview deployment that talks to the **production** Supabase project still
mutates production data. For real staging, point preview deployments at a
second Supabase project.

**Setup (one time):**

1. Create a second Supabase project (e.g. `terra-vista-staging`). On the Free
   plan this is a second free project — allowed.
2. Run every migration `.sql` file against it in the same order you ran them
   against production (estimates → budget_vs_actual → etc.). Staging's schema
   must mirror production or queries break.
3. In Vercel → your project → Settings → Environment Variables, add the staging
   values scoped to the **Preview** environment:
   - `NEXT_PUBLIC_SUPABASE_URL` → staging project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → staging anon key
   - `SUPABASE_SERVICE_ROLE_KEY` → staging service key

   Keep the **Production** environment pointing at the production project.
   Preview deployments will now hit staging data; production deployments hit
   production data. Customers on the production URL are untouched by preview
   testing.

**To keep schemas in sync:** after running a migration against production in
SQL Editor, run the same file against staging. The migration guard covers both
— the guard scans the repo, not a specific DB.

---

## 3. Rollback runbook

Two kinds of bad deploy: bad **code** (Vercel) and bad **data/migration**
(Supabase). Different fixes.

### A. Bad code — Vercel instant rollback (~1 min)

When a push breaks the UI / API but the database is fine:

1. Vercel dashboard → your project → **Deployments**.
2. Find the latest (broken) deployment at the top.
3. The previous known-good deployment has a **⋮** menu → **Promote to
   Production** (a.k.a. "Instant Rollback"). Click it.
4. Production now serves the previous build within seconds. The broken build
   stays in history but isn't served.

That's it — no re-deploy, no rebuild. This is why we deploy via Vercel and not
by hand. **Practice this once** on a throwaway deployment so you know where the
button is before you need it for real.

### B. Bad migration — Supabase restore from backup

When a migration ran in SQL Editor and damaged data (wrong `UPDATE`, accidental
`DELETE`, a column you didn't mean to drop):

1. **Stop.** Do not run more SQL against production until the restore is done.
2. Download the latest backup from the `db-backups` storage bucket:
   - Supabase dashboard → Storage → `db-backups` → `backups/` → newest
     `YYYYMMDD-HHMMSS.sql.gz`, or use the service role:
     ```sh
     # List newest backups
     curl -sS -X POST "$SUPABASE_URL/storage/v1/object/list/db-backups" \
       -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
       -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
       -H "Content-Type: application/json" \
       -d '{"prefix":"backups/","limit":5,"offset":0,"sortBy":{"column":"name","order":"desc"}}' | jq '.[].name'
     ```
   - Download it (signed URL or the storage API), then `gunzip` it.
3. Restore into a **fresh** Supabase project (don't overwrite the live one in
   place — you'll want the damaged DB as a forensic copy until you're sure the
   restore is good):
   ```sh
   psql --dbname="$RESTORE_DB_URL" --file=backup.sql
   ```
   The dump uses `--clean --if-exists`, so it drops and recreates objects,
   making the restore idempotent.
4. Point Vercel Production env vars at the restored project, or, once you've
   verified the restored data is correct, you can recreate the damaged objects
   in the original project from the dump.
5. When stable, re-point Production env vars at whichever project has the good
   data.

**On the Free plan there is no point-in-time recovery (PITR)** — you restore to
the last nightly dump, so anything entered between the last backup and the bad
migration is lost. This is the trade-off of the Free plan; the nightly backup
script is the mitigation. Upgrading to Pro enables daily automated backups +
PITR for finer-grained recovery.

---

## 4. Scripted DB backups

**The problem:** the Supabase Free plan has **no automated database backups**
(that's Pro+). Without this, a bad migration or a Supabase-side incident means
total data loss. This script is the floor under everything else.

**What it does:** `scripts/backup-db.sh` runs `pg_dump` against the production
DB, gzips it, and uploads it to a **private** Supabase Storage bucket
(`db-backups`, created on first run). It keeps the newest 30 by default and
deletes older ones. Service role bypasses storage RLS, so no bucket policy is
needed to upload.

**Schedule:** `.github/workflows/db-backup.yml` runs it nightly at 06:17 UTC via
GitHub Actions, plus a manual "Run workflow" button in the Actions tab.

**One-time setup — add three repo secrets** (GitHub repo → Settings → Secrets
and variables → Actions → New repository secret):

| Secret name | Value | Where to find it |
|---|---|---|
| `SUPABASE_DB_URL` | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` | Supabase dashboard → Project Settings → Database → **Connection string** → URI. Use the **pooler** (port 6543) or direct (5432) string — either works. |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Supabase dashboard → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` (long) | Supabase dashboard → Project Settings → API → `service_role` secret |

Optional repo **variable** (Settings → Secrets → Variables):
`BACKUP_RETAIN_COUNT` — number of dumps to keep (default 30).

**Verify it works:** after adding the secrets, go to the Actions tab →
"nightly-db-backup" → **Run workflow**. The job should go green and the smoke
check confirms a backup object exists in the bucket. Then check Supabase →
Storage → `db-backups` for a `backups/<timestamp>.sql.gz`. If green, nightly
backups are now automatic — no further attention needed.

**Run it by hand** (no GitHub Actions): if you want an ad-hoc backup before a
risky migration, set the three env vars locally and run:
```sh
DB_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... bash scripts/backup-db.sh
```
Do this right before running any non-idempotent or destructive migration in
SQL Editor. The dump takes seconds for a small DB.

---

## Quick reference — before a risky change

Before pushing code or running a migration that could break things:

1. `node scripts/check-migrations.mjs` — no destructive SQL slipped in.
2. Branch → PR → review the Vercel preview deployment (and staging data).
3. `bash scripts/backup-db.sh` (or wait for the nightly run) — a fresh restore
   point exists.
4. Run the migration in Supabase SQL Editor → confirm "Success".
5. Push/merge. Watch the Vercel deployment; if it breaks, **Instant Rollback**
   from the Deployments page.

This is the full loop. Done in order, no single step can take the app down or
lose data without a chance to catch it first.