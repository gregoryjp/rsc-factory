#!/bin/sh
set -eu

fail() {
  echo "db-restore: $2" >&2
  exit "$1"
}

file="${1:-}"
confirm="${2:-}"
[ -n "$file" ] || fail 2 "usage: db-restore.sh <backup.dump> --confirm"
[ "$confirm" = "--confirm" ] || fail 2 "pass --confirm to restore into RESTORE_DATABASE_URL"
[ -f "$file" ] || fail 2 "backup file not found: $file"
url="${RESTORE_DATABASE_URL:-}"
[ -n "$url" ] || fail 2 "set RESTORE_DATABASE_URL to an empty target database"
command -v pg_restore >/dev/null 2>&1 || fail 3 "pg_restore not found in PATH"

pg_restore --list "$file" >/dev/null || fail 5 "the file is not a valid pg_dump custom archive"
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$url" "$file" ||
  fail 4 "pg_restore failed; nothing was applied (the target must be empty)"

echo "restored $file"
