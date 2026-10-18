#!/bin/sh
# Consistent checkpoint (plan 28): database dump, then the media files, then a manifest,
# packed and encrypted with age. Media is copied after the dump, so every attachment row
# in the dump has its file (files are only ever added or moved, never edited).
set -eu
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
MEDIA_DIR="${MEDIA_DIR:-/data/media}"
RECIPIENT_FILE="${BACKUP_RECIPIENT_FILE:?BACKUP_RECIPIENT_FILE is required}"
STAMP="$(date +%Y%m%d-%H%M)-$(date +%a)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "backup ${STAMP}: dumping database"
pg_dump --format=custom --no-owner --no-privileges --file "$WORK/db.dump"
pg_restore --list "$WORK/db.dump" > /dev/null   # dump is readable

echo "backup ${STAMP}: copying media"
tar -C "$MEDIA_DIR" -cf "$WORK/media.tar" --exclude='./tmp' .

REV="$(psql -At -c 'SELECT version_num FROM alembic_version' 2>/dev/null || echo unknown)"
TICKETS="$(psql -At -c 'SELECT count(*) FROM ticket' 2>/dev/null || echo 0)"
ATTACH="$(psql -At -c "SELECT count(*) FROM attachment WHERE state = 'available'" 2>/dev/null || echo 0)"
{
  echo "created_at=$(date -Iseconds)"
  echo "schema_revision=${REV}"
  echo "tickets=${TICKETS}"
  echo "attachments_available=${ATTACH}"
  (cd "$WORK" && sha256sum db.dump media.tar)
} > "$WORK/MANIFEST"

OUT="${BACKUP_DIR}/pcms-${STAMP}.tar.age"
tar -C "$WORK" -cf - MANIFEST db.dump media.tar | age -R "$RECIPIENT_FILE" -o "${OUT}.partial"
mv "${OUT}.partial" "$OUT"
echo "backup ${STAMP}: wrote $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"

# Rotation: keep the 7 newest, plus the 4 newest Sunday backups.
cd "$BACKUP_DIR"
ls -1t pcms-*.tar.age 2>/dev/null > "$WORK/all" || true
head -n 7 "$WORK/all" > "$WORK/keep"
grep -- '-Sun\.tar\.age$' "$WORK/all" | head -n 4 >> "$WORK/keep" || true
grep -vxF -f "$WORK/keep" "$WORK/all" | while read -r old; do
  echo "rotation: removing ${old}"
  rm -f -- "$old"
done

# Optional off-host copy (plan 28: a backup on the same host does not protect the host).
if [ -n "${BACKUP_COPY_CMD:-}" ]; then
  sh -c "$BACKUP_COPY_CMD \"$OUT\""
fi
date -Iseconds > "${BACKUP_DIR}/LAST_SUCCESS"
