#!/bin/sh
# Restore a checkpoint into the database and media volume (plan 28).
#   restore.sh /backups/pcms-YYYYmmdd-HHMM-Day.tar.age /run/identity.txt
# Stop api, worker and scheduler first. The database and the media are restored together.
# Messages still pending in the restored outbox are cancelled so old notifications are
# never replayed blindly; review them in the admin portal before resuming dispatch.
set -eu
umask 077

ARCHIVE="${1:?usage: restore.sh ARCHIVE IDENTITY_FILE}"
IDENTITY="${2:?usage: restore.sh ARCHIVE IDENTITY_FILE}"
MEDIA_DIR="${MEDIA_DIR:-/data/media}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "restore: decrypting $(basename "$ARCHIVE")"
age -d -i "$IDENTITY" "$ARCHIVE" | tar -C "$WORK" -xf -
(cd "$WORK" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum -c -)
cat "$WORK/MANIFEST" | grep -v '^[0-9a-f]\{64\}'

echo "restore: database"
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error -d "${PGDATABASE}" "$WORK/db.dump"

echo "restore: media"
find "$MEDIA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -C "$MEDIA_DIR" -xf "$WORK/media.tar"

echo "restore: cancelling unsent notifications from before the restore"
psql -v ON_ERROR_STOP=1 -c "UPDATE outbox SET state = 'cancelled', last_error = 'Cancelled by restore on ' || now()::text WHERE state IN ('pending', 'sending');"
psql -v ON_ERROR_STOP=1 -c "UPDATE user_session SET revoked_at = now() WHERE revoked_at IS NULL;"

TICKETS="$(psql -At -c 'SELECT count(*) FROM ticket')"
EXPECTED="$(sed -n 's/^tickets=//p' "$WORK/MANIFEST")"
echo "restore: tickets now ${TICKETS} (manifest ${EXPECTED})"
[ "$TICKETS" = "$EXPECTED" ] || { echo "restore: TICKET COUNT MISMATCH" >&2; exit 1; }
echo "restore: done. Everyone must sign in again. Reconcile paper reports and the lost-write window before reopening."
