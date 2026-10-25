#!/bin/sh
set -eu

fail() {
  echo "db-backup: $2" >&2
  exit "$1"
}

url="${BACKUP_DATABASE_URL:-${MIGRATION_DATABASE_URL:-}}"
[ -n "$url" ] || fail 2 "set BACKUP_DATABASE_URL (or MIGRATION_DATABASE_URL)"
command -v pg_dump >/dev/null 2>&1 || fail 3 "pg_dump not found in PATH"
command -v pg_restore >/dev/null 2>&1 || fail 3 "pg_restore not found in PATH"

dir="${BACKUP_DIR:-./backups}"
umask 077
mkdir -p "$dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$dir/backup-$stamp.dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

pg_dump --format=custom --no-owner --no-privileges --dbname="$url" --file="$partial" ||
  fail 4 "pg_dump failed"
pg_restore --list "$partial" >/dev/null || fail 5 "the dump is not readable by pg_restore"
mv "$partial" "$file"

if [ -n "${BACKUP_KEEP_DAYS:-}" ]; then
  find "$dir" -maxdepth 1 -name 'backup-*.dump' -type f -mtime +"$BACKUP_KEEP_DAYS" -delete
fi

echo "$file"
