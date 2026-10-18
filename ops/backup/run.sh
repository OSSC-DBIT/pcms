#!/bin/sh
# Runs backup.sh once a day at BACKUP_AT (HHMM, local time, default 0130 IST).
set -eu
AT="${BACKUP_AT:-0130}"
echo "backup scheduler: daily at ${AT} ($(date +%Z))"
while true; do
  if [ "$(date +%H%M)" = "$AT" ]; then
    /usr/local/bin/backup.sh || echo "BACKUP FAILED at $(date -Iseconds)" >&2
    sleep 61
  fi
  sleep 20
done
