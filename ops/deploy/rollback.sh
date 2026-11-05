#!/usr/bin/env bash
# Return one PCMS environment to the release before the current one, without building.
#
#   ops/deploy/rollback.sh <staging|production> [tag]
#
# Uses the images kept by deploy.sh (tag <env>-<sha>). With no tag, it uses the previous
# release recorded in /var/lib/pcms-deploy/<env>.previous; `docker image ls pcms-api` lists
# what is available.
#
# A rollback starts the old code against the current database. If the release being undone
# ran a migration that the old code cannot use, restore the backup taken before that deploy
# instead (docs/DEPLOYMENT.md section 7). CHANGELOG.md says which releases migrate.
set -euo pipefail

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  staging|production) ;;
  *) echo "usage: $0 <staging|production> [tag]" >&2; exit 2 ;;
esac
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${PCMS_DEPLOY_STATE_DIR:-/var/lib/pcms-deploy}"
CONF="/etc/pcms/${ENVIRONMENT}.conf"
[ -r "$CONF" ] || { echo "error: $CONF not found" >&2; exit 1; }
conf() { grep -E "^$1=" "$CONF" | tail -n1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }
PCMS_PROJECT="$(conf PCMS_PROJECT)"
PCMS_ENV_FILE="$(conf PCMS_ENV_FILE)"
PCMS_HEALTH_URL="$(conf PCMS_HEALTH_URL)"
[[ "$PCMS_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "error: bad PCMS_PROJECT in $CONF" >&2; exit 1; }

TAG="${2:-$(cat "$STATE_DIR/${ENVIRONMENT}.previous" 2>/dev/null || true)}"
[ -n "$TAG" ] || { echo "error: no previous release recorded; pass a tag" >&2; exit 1; }
[[ "$TAG" == "${ENVIRONMENT}-"* ]] || { echo "error: tag '$TAG' is not a $ENVIRONMENT release" >&2; exit 1; }
for repo in pcms-api pcms-web pcms-backup; do
  docker image inspect "$repo:$TAG" >/dev/null 2>&1 || { echo "error: image $repo:$TAG is not on this server" >&2; exit 1; }
done

exec 9>"$STATE_DIR/${ENVIRONMENT}.lock"
flock -n 9 || { echo "error: a deploy of $ENVIRONMENT is running" >&2; exit 1; }

export PCMS_ENV_FILE PCMS_IMAGE_API="pcms-api:$TAG" PCMS_IMAGE_WEB="pcms-web:$TAG" PCMS_IMAGE_BACKUP="pcms-backup:$TAG"
echo "[rollback $ENVIRONMENT] starting $TAG"
docker compose -p "$PCMS_PROJECT" -f "$REPO_DIR/compose.prod.yml" --env-file "$PCMS_ENV_FILE" up -d --no-build --remove-orphans
for _ in $(seq 1 60); do
  curl -fsSk --max-time 10 "$PCMS_HEALTH_URL" >/dev/null && { echo "$TAG" > "$STATE_DIR/${ENVIRONMENT}.current"; echo "[rollback $ENVIRONMENT] $TAG is healthy"; exit 0; }
  sleep 5
done
echo "[rollback $ENVIRONMENT] $TAG did not become healthy; see: docker compose -p $PCMS_PROJECT logs api" >&2
exit 1
