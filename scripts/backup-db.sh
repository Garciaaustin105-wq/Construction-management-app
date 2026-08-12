#!/usr/bin/env bash
#
# Nightly Supabase DB backup via pg_dump, uploaded to a PRIVATE Supabase Storage
# bucket. The Supabase Free plan ships NO automated backups (that's Pro+), so
# this script is the data-loss safety net. Run it on a schedule (see
# .github/workflows/db-backup.yml) or by hand.
#
# Required env vars:
#   DB_URL                    postgres connection string
#                             (Supabase dashboard → Project Settings → Database →
#                              "Connection string" → URI format, starts postgresql://)
#   SUPABASE_URL              https://<project-ref>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY service-role key — SERVER ONLY, never expose to the
#                             browser. This script uses it to write the dump to a
#                             private storage bucket (service role bypasses RLS).
#
# Optional env vars:
#   BACKUP_BUCKET             storage bucket name (default: db-backups). Created as
#                             a private bucket on first run if it doesn't exist.
#   BACKUP_RETAIN_COUNT       number of backups to keep, oldest deleted first
#                             (default: 30). Set 0 to keep everything.
#
# Exit codes: 0 = ok, non-zero = failure (CI surfaces it).
set -euo pipefail

: "${DB_URL:?DB_URL is required (Supabase → Project Settings → Database → Connection string)}"
: "${SUPABASE_URL:?SUPABASE_URL is required (https://<project-ref>.supabase.co)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
BACKUP_BUCKET="${BACKUP_BUCKET:-db-backups}"
RETAIN="${BACKUP_RETAIN_COUNT:-30}"

auth_headers=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

# Timestamp is UTC, second-resolution — safe across runs (no Date.now/random in
# workflow scripts; this runs in a normal shell where `date` is allowed).
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OBJECT="backups/${STAMP}.sql.gz"
TMP="$(mktemp -t terra-backup-XXXXXX.sql.gz)"
trap 'rm -f "$TMP"' EXIT

echo "==> pg_dump → $TMP"
# --no-owner/--no-privileges: portable across roles on restore.
# --clean --if-exists: restore drops existing objects first, idempotent.
pg_dump --dbname="$DB_URL" --no-owner --no-privileges --clean --if-exists \
  | gzip > "$TMP"
SIZE=$(wc -c < "$TMP" | tr -d ' ')
echo "    dump size: $SIZE bytes"

# Ensure the private bucket exists. POST returns 409 if it already exists, which
# we ignore — the next upload still works.
echo "==> ensuring private bucket '$BACKUP_BUCKET'"
curl -sS -o /dev/null -w "    bucket create: %{http_code}\n" -X POST \
  "${SUPABASE_URL}/storage/v1/bucket" \
  "${auth_headers[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$BACKUP_BUCKET\",\"name\":\"$BACKUP_BUCKET\",\"public\":false}" \
  || true

# Upload the dump (service role bypasses storage RLS, so no bucket policy needed).
echo "==> uploading $OBJECT"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "${SUPABASE_URL}/storage/v1/object/${BACKUP_BUCKET}/${OBJECT}" \
  "${auth_headers[@]}" \
  -H "Content-Type: application/octet-stream" \
  -H "x-upsert: false" \
  --data-binary "@$TMP")
echo "    upload: $HTTP"
if [ "$HTTP" != "200" ]; then
  echo "!! upload failed (HTTP $HTTP)" >&2
  exit 1
fi

# Prune: keep newest $RETAIN by name (names are timestamp-sorted ascending).
# Count-based, not date-math-based, so it's portable across GNU/BSD date.
if [ "$RETAIN" -gt 0 ] && command -v jq >/dev/null 2>&1; then
  echo "==> pruning to newest $RETAIN backups"
  LIST=$(curl -sS -X POST \
    "${SUPABASE_URL}/storage/v1/object/list/${BACKUP_BUCKET}" \
    "${auth_headers[@]}" \
    -H "Content-Type: application/json" \
    -d '{"prefix":"backups/","limit":1000,"offset":0,"sortBy":{"column":"name","order":"asc"}}')
  # Sort ascending, drop the newest $RETAIN, delete the rest.
  echo "$LIST" | jq -r '.[].name' 2>/dev/null \
    | sort \
    | head -n "-${RETAIN}" \
    | while IFS= read -r old; do
        [ -n "$old" ] || continue
        CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
          "${SUPABASE_URL}/storage/v1/object/${BACKUP_BUCKET}/backups/${old}" \
          "${auth_headers[@]}")
        echo "    deleted backups/${old} ($CODE)"
      done
elif [ "$RETAIN" -gt 0 ]; then
  echo "!! jq not found — skipping prune (old backups will accumulate). Install jq to enable retention." >&2
fi

echo "==> done: ${BACKUP_BUCKET}/${OBJECT}"