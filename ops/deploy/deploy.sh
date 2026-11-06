#!/usr/bin/env bash
# Deploy one PCMS environment on this server from the checked-out commit.
#
#   ops/deploy/deploy.sh <staging|production> <git-sha>
#
# Run by the self-hosted GitHub Actions runner (.github/workflows/deploy.yml), or by hand
# from a checkout of the commit to deploy. It never deletes data:
#   1. reads /etc/pcms/<env>.conf (project name, env file, health URL)
#   2. builds images tagged <env>-<sha>, so staging and production never share an image
#   3. takes a backup first (required for production) when the stack is already running
#   4. starts the stack; `migrate` runs the database migrations before the API starts
#   5. waits for the API and nginx to be healthy and checks the health URL
#   6. records the deployed tag, so ops/deploy/rollback.sh can return to the previous one
# On failure it prints the logs and stops. It does not roll back on its own, because a
# migration that already ran may need the backup instead (docs/DEPLOYMENT.md, Rollback).
set -euo pipefail

ENVIRONMENT="${1:-}"
SHA="${2:-}"
case "$ENVIRONMENT" in
  staging|production) ;;
  *) echo "usage: $0 <staging|production> <git-sha>" >&2; exit 2 ;;
esac
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "error: '$SHA' is not a git commit SHA" >&2; exit 2; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF="/etc/pcms/${ENVIRONMENT}.conf"
STATE_DIR="${PCMS_DEPLOY_STATE_DIR:-/var/lib/pcms-deploy}"
KEEP_IMAGES="${PCMS_KEEP_IMAGES:-5}"

log() { printf '[deploy %s %s] %s\n' "$ENVIRONMENT" "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[deploy %s] error: %s\n' "$ENVIRONMENT" "$*" >&2; exit 1; }

# ---------- configuration ----------
# Read KEY=value lines; never execute the file. It must be writable by root only, because it
# decides which env file and project a root-equivalent Docker command acts on.
[ -r "$CONF" ] || die "$CONF not found or not readable. See docs/DEPLOYMENT.md, Continuous deployment."
if [ "${PCMS_DEPLOY_SKIP_OWNER_CHECK:-}" != 1 ]; then
  [ "$(stat -c %u "$CONF")" = 0 ] || die "$CONF must be owned by root"
  perms="$(stat -c %a "$CONF")"
  (( (8#$perms & 8#022) == 0 )) || die "$CONF must not be writable by group or others (chmod 644)"
fi
conf() { grep -E "^$1=" "$CONF" | tail -n1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }
PCMS_PROJECT="$(conf PCMS_PROJECT)"
PCMS_ENV_FILE="$(conf PCMS_ENV_FILE)"
PCMS_HEALTH_URL="$(conf PCMS_HEALTH_URL)"
[ -n "$PCMS_PROJECT" ] || die "set PCMS_PROJECT in $CONF"
[ -n "$PCMS_ENV_FILE" ] || die "set PCMS_ENV_FILE in $CONF"
[ -n "$PCMS_HEALTH_URL" ] || die "set PCMS_HEALTH_URL in $CONF"
[[ "$PCMS_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "PCMS_PROJECT must be lowercase letters, digits, - or _"
[[ "$PCMS_ENV_FILE" == /* ]] || die "PCMS_ENV_FILE must be an absolute path"
[[ "$PCMS_HEALTH_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?/ ]] || die "PCMS_HEALTH_URL must point at this server (127.0.0.1)"
if [ ! -e "$PCMS_ENV_FILE" ]; then
  die "env file $PCMS_ENV_FILE does not exist. Run: sudo bash ops/deploy/setup-environment.sh $ENVIRONMENT"
elif [ ! -r "$PCMS_ENV_FILE" ]; then
  # The file is root:pcms 640. A running runner keeps the groups it started with, so after
  # setup-environment.sh adds gh-runner to pcms the runner service must be restarted once.
  die "env file $PCMS_ENV_FILE is not readable by $(id -un) (groups: $(id -Gn)). It must be group pcms, mode 640, and the runner must be in group pcms: sudo usermod -aG pcms $(id -un), then restart the runner service (sudo systemctl restart 'actions.runner.*') and re-run this job"
fi

# Paths inside the env file must be absolute: the checkout directory changes on every run,
# and a relative ./secrets or ./certs would silently point into it.
BACKUP_DIR=""
for key in PCMS_SECRETS_DIR PCMS_CERT_DIR PCMS_BACKUP_DIR; do
  value="$(grep -E "^${key}=" "$PCMS_ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
  [ -n "$value" ] || die "$key is not set in $PCMS_ENV_FILE (it must be an absolute path)"
  [[ "$value" == /* ]] || die "$key in $PCMS_ENV_FILE must be an absolute path, not '$value'"
  [ "$key" = PCMS_BACKUP_DIR ] && BACKUP_DIR="$value"
done
# The backup container runs as the postgres user (uid 70). A root-owned folder makes every
# backup fail with "permission denied", including the one taken before each deploy.
if [ -d "$BACKUP_DIR" ] && [ "${PCMS_DEPLOY_SKIP_OWNER_CHECK:-}" != 1 ]; then
  [ "$(stat -c %u "$BACKUP_DIR")" = 70 ] || die "$BACKUP_DIR must be owned by uid 70 (the backup container): sudo chown 70:70 $BACKUP_DIR"
fi

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/${ENVIRONMENT}.lock"
flock -n 9 || die "another deploy of $ENVIRONMENT is running"

TAG="${ENVIRONMENT}-${SHA:0:12}"
export PCMS_ENV_FILE
export PCMS_IMAGE_API="pcms-api:${TAG}"
export PCMS_IMAGE_WEB="pcms-web:${TAG}"
export PCMS_IMAGE_BACKUP="pcms-backup:${TAG}"
dc() { docker compose -p "$PCMS_PROJECT" -f "$REPO_DIR/compose.prod.yml" --env-file "$PCMS_ENV_FILE" "$@"; }

cd "$REPO_DIR"
log "commit $SHA, project $PCMS_PROJECT, images *:$TAG"
dc config --quiet || die "compose.prod.yml with $PCMS_ENV_FILE is not valid"

# ---------- build ----------
log "building images"
dc build --pull api nginx backup

# ---------- backup before migrations ----------
if [ -n "$(dc ps -q db 2>/dev/null)" ] && [ -n "$(dc ps -q backup 2>/dev/null)" ]; then
  log "backing up before deploying"
  if ! dc exec -T backup backup.sh; then
    [ "$ENVIRONMENT" = production ] && die "backup failed; production is not deployed without a backup"
    log "warning: backup failed; continuing because this is staging"
  fi
else
  log "stack not running yet; no backup to take"
fi

previous="$(cat "$STATE_DIR/${ENVIRONMENT}.current" 2>/dev/null || true)"

container() { dc ps -aq "$1" | head -n1; }
wait_healthy() {
  local service="$1" deadline=$((SECONDS + ${2:-300})) id status
  while (( SECONDS < deadline )); do
    id="$(container "$service")"
    if [ -n "$id" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      case "$status" in
        healthy) return 0 ;;
        unhealthy|exited|dead) return 1 ;;
      esac
    fi
    sleep 5
  done
  return 1
}
fail() {
  log "deploy FAILED: $1"
  dc ps -a || true
  dc logs --tail 80 migrate api nginx || true
  if [ -n "$previous" ]; then
    log "previous release: $previous. If the database migrated, restore the backup first;"
    log "otherwise: ops/deploy/rollback.sh $ENVIRONMENT"
  fi
  exit 1
}

# ---------- start ----------
# Migrations run first, in a one-off container, while the current release keeps serving.
# If they fail, nothing running is touched: the site stays up on the old release.
log "starting the database and running migrations (the current release keeps serving)"
dc up -d --wait db || fail "the database did not become healthy"
dc run --rm --no-deps migrate || fail "migrations failed (check-config, alembic or seed); the current release is still running"

# Now replace the containers. `up` runs migrate once more (a no-op) before the API starts.
log "starting the new release"
dc up -d --remove-orphans || fail "docker compose up failed"

migrate_id="$(container migrate)"
if [ -n "$migrate_id" ]; then
  docker wait "$migrate_id" >/dev/null
  code="$(docker inspect -f '{{.State.ExitCode}}' "$migrate_id")"
  [ "$code" = 0 ] || fail "migrate exited with code $code (check-config, alembic or seed failed)"
fi
wait_healthy api 300 || fail "api did not become healthy"
wait_healthy nginx 180 || fail "nginx did not become healthy"
curl -fsSk --max-time 10 "$PCMS_HEALTH_URL" >/dev/null || fail "$PCMS_HEALTH_URL did not answer 200"

# ---------- record and tidy ----------
[ -n "$previous" ] && [ "$previous" != "$TAG" ] && echo "$previous" > "$STATE_DIR/${ENVIRONMENT}.previous"
echo "$TAG" > "$STATE_DIR/${ENVIRONMENT}.current"
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$TAG" "$SHA" >> "$STATE_DIR/${ENVIRONMENT}.history"

# Keep the newest images of this environment (the current one, and earlier ones to roll back to).
for repo in pcms-api pcms-web pcms-backup; do
  docker image ls "$repo" --format '{{.CreatedAt}}\t{{.Tag}}' \
    | grep -P "\t${ENVIRONMENT}-" | sort -r | tail -n +"$((KEEP_IMAGES + 1))" | cut -f2 \
    | while read -r old; do
        [ "$old" = "$TAG" ] || docker image rm "$repo:$old" >/dev/null 2>&1 || true
      done
done

log "deployed $TAG and healthy"
