#!/usr/bin/env bash
# Prepare one PCMS environment on the OSSC server, in one command. Safe to run again.
#
#   sudo bash setup-environment.sh staging     [--email you@x] [--ip 10.0.0.5]
#   sudo bash setup-environment.sh production  [--email you@x] [--ip 10.0.0.5]
#
# It never overwrites a secret that is already set. It does:
#   - folders: <dir>/{certs,secrets,backups}, with the right owners
#   - the env file: created with fresh secrets (production), or cleaned and completed (staging):
#     removes settings that no longer exist, adds web push keys, the campus address, absolute paths
#   - the backup key pair (private key saved for the custodians, public key used by the server)
#   - a self-signed certificate naming the domain and the server IP (Cloudflare does not check it)
#   - /etc/pcms/<env>.conf for continuous deployment, and the `pcms` helper command
# See docs/SERVER.md and docs/pcms-deployment-2026-11-02.md.
set -euo pipefail

ENVIRONMENT="${1:-}"; shift || true
EMAIL=""; IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

case "$ENVIRONMENT" in
  staging)
    PROJECT=pcms; DOMAIN=pcms-staging.webuildnow.in
    DATA_DIR=/srv/server-data/staging/pcms; ENV_FILE=/srv/server-data/staging/pcms/pcms.env
    # Before 5 November staging lived in the old checkout and directly in /srv/pcms.
    OLD_ENV=/srv/server-data/pcms/pcms.env; OLD_DATA=/srv/pcms
    HTTPS_PORT=676; HTTP_PORT=8082; BACKUP_AT=0130 ;;
  production)
    PROJECT=pcms-prod; DOMAIN=pcms.webuildnow.in
    DATA_DIR=/srv/server-data/production/pcms; ENV_FILE=/srv/server-data/production/pcms/pcms.env
    OLD_ENV=; OLD_DATA=
    HTTPS_PORT=677; HTTP_PORT=8083; BACKUP_AT=0200 ;;
  *) echo "usage: sudo bash $0 <staging|production> [--email you@example.org] [--ip <server-lan-ip>]" >&2; exit 2 ;;
esac

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is not installed" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
STAMP="$(date +%Y%m%d-%H%M%S)"
[ -n "$IP" ] || IP="$(hostname -I | awk '{print $1}')"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not work out the server IP; pass --ip" >&2; exit 1; }

b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
random() { openssl rand -base64 "$1" | tr -d '/+=\n' | head -c "$2"; }

# ---------- env file helpers ----------
get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }
put() {  # replace or append KEY=value (value written as given)
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^$key=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
put_if_empty() { [ -n "$(get "$1")" ] || { put "$1" "$2"; note "set $1"; }; }

# ---------- folders ----------
# Layout: /srv/server-data/<environment>/pcms/{pcms.env,certs,secrets,backups}. Other apps go beside it, in
# /srv/server-data/<environment>/<app>. An environment set up in an older place is copied in once; the old copies
# stay until you remove them (docs/SERVER.md), so the stack that is running now keeps working until the
# next deploy recreates it with the new paths.
groupadd -f pcms
if id gh-runner >/dev/null 2>&1 && ! id -nG gh-runner | tr ' ' '\n' | grep -qx pcms; then
  usermod -aG pcms gh-runner
  # A running process keeps the groups it started with: restart the runner so deploys can read
  # the settings file (root:pcms 640). Without this the deploy fails with "not readable".
  if systemctl list-units --type=service --all 'actions.runner.*' --no-legend 2>/dev/null | grep -q .; then
    systemctl restart 'actions.runner.*' && note "restarted the GitHub runner so it is in group pcms"
  fi
fi
install -d -m 755 /srv/server-data "/srv/server-data/$ENVIRONMENT"
if [ ! -f "$ENV_FILE" ] && [ -n "$OLD_ENV" ] && [ -f "$OLD_ENV" ]; then
  say "moving $ENVIRONMENT to $DATA_DIR (copying; the old files stay until you delete them)"
  install -d -m 750 -o root -g pcms "$DATA_DIR"
  for d in certs secrets backups; do
    if [ -d "$OLD_DATA/$d" ] && [ ! -e "$DATA_DIR/$d" ]; then
      cp -a "$OLD_DATA/$d" "$DATA_DIR/$d"
      note "copied $OLD_DATA/$d"
    fi
  done
  cp -a "$OLD_ENV" "$ENV_FILE"
  note "copied $OLD_ENV"
fi

say "folders in $DATA_DIR"
install -d -m 750 -o root -g pcms "$DATA_DIR"
install -d -m 755 "$DATA_DIR/certs"
install -d -m 700 "$DATA_DIR/secrets"
install -d -m 750 -o 70 -g 70 "$DATA_DIR/backups"
note "ok (backups owned by uid 70, the backup container)"

# ---------- env file ----------
say "settings file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  [ "$ENVIRONMENT" = production ] || { echo "$ENV_FILE does not exist and there is no old $OLD_ENV to copy" >&2; exit 1; }
  install -m 640 -o root -g pcms /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# PCMS $ENVIRONMENT settings. Created by setup-environment.sh on $(date -u +%F). Mode 640, root:pcms.
# Every setting is explained in .env.example in the repository.

PCMS_DB_NAME=pcms
PCMS_DB_USER=pcms
PCMS_DB_PASSWORD=$(random 48 32)
PCMS_SECRET_KEY=$(random 72 64)
PCMS_CREDENTIAL_KEY=$(random 72 64)

PCMS_PUBLIC_APP_URL=https://$DOMAIN
PCMS_HTTP_PORT=$HTTP_PORT
PCMS_HTTPS_PORT=$HTTPS_PORT

PCMS_COLLEGE_CODE=DB
PCMS_TIMEZONE=Asia/Kolkata
PCMS_TRANSLATION_PROVIDER=mymemory
PCMS_TRANSLATION_EMAIL=
PCMS_TRANSLATION_FALLBACK=google

PCMS_DISPUTE_WINDOW_DAYS=7
PCMS_VERIFY_REMINDER_DAYS=2
PCMS_AUTO_CLOSE_DAYS=5
PCMS_TEMP_PASSWORD_DAYS=7

PCMS_CERT_DIR=$DATA_DIR/certs
PCMS_SECRETS_DIR=$DATA_DIR/secrets
PCMS_BACKUP_DIR=$DATA_DIR/backups
PCMS_BACKUP_AT=$BACKUP_AT
EOF
  note "created with fresh database password and keys"
else
  cp -a "$ENV_FILE" "$ENV_FILE.bak-$STAMP"
  note "backup: $ENV_FILE.bak-$STAMP"
  removed="$(grep -cE '^(PCMS_SMTP_[A-Z]+|PCMS_TWILIO_[A-Z_]+|PCMS_MESSAGING_PROVIDER|PCMS_FACILITIES_DESK_PHONE|PCMS_PUBLIC_BASE_URL|PCMS_PUBLIC_PORT|PCMS_PUBLIC_BIND|PCMS_ACCEPT_TIMEOUT_MINUTES|PCMS_ADMIN_[0-9]+_[A-Z]+)=' "$ENV_FILE" || true)"
  sed -i -E '/^(PCMS_SMTP_[A-Z]+|PCMS_TWILIO_[A-Z_]+|PCMS_MESSAGING_PROVIDER|PCMS_FACILITIES_DESK_PHONE|PCMS_PUBLIC_BASE_URL|PCMS_PUBLIC_PORT|PCMS_PUBLIC_BIND|PCMS_ACCEPT_TIMEOUT_MINUTES|PCMS_ADMIN_[0-9]+_[A-Z]+)=/d' "$ENV_FILE"
  note "removed $removed line(s) for settings that no longer exist (email, Twilio, tunnel listener, one-time admins)"
  put_if_empty PCMS_PUBLIC_APP_URL "https://$DOMAIN"
  put_if_empty PCMS_HTTP_PORT "$HTTP_PORT"
  put_if_empty PCMS_HTTPS_PORT "$HTTPS_PORT"
  for key in CERT_DIR:certs SECRETS_DIR:secrets BACKUP_DIR:backups; do
    k="PCMS_${key%%:*}"; v="$(get "$k")"
    [ "$v" = "$DATA_DIR/${key##*:}" ] || { put "$k" "$DATA_DIR/${key##*:}"; note "set $k=$DATA_DIR/${key##*:}"; }
  done
fi
HTTPS_PORT="$(get PCMS_HTTPS_PORT)"

# Web push keys (the only notification channel). Generated once; never replaced.
if [ -z "$(get PCMS_VAPID_PUBLIC_KEY)" ] || [ -z "$(get PCMS_VAPID_PRIVATE_KEY)" ]; then
  key="$(mktemp)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$key" 2>/dev/null
  put PCMS_VAPID_PRIVATE_KEY "$(openssl ec -in "$key" -outform DER 2>/dev/null | tail -c +8 | head -c 32 | b64url)"
  put PCMS_VAPID_PUBLIC_KEY "$(openssl ec -in "$key" -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)"
  rm -f "$key"
  note "generated the web push keys (keep them: new keys turn off notifications on every device)"
fi
subject="$(get PCMS_VAPID_SUBJECT)"
if [ -z "$subject" ] || [[ "$subject" == *@localhost ]]; then
  if [ -z "$EMAIL" ] && [ -t 0 ]; then
    read -r -p "   Contact email for the push services (for example ossc@dbit.in): " EMAIL
  fi
  [ -n "$EMAIL" ] || { echo "a contact email is needed: run again with --email you@example.org" >&2; exit 1; }
  put PCMS_VAPID_SUBJECT "mailto:$EMAIL"
  note "set PCMS_VAPID_SUBJECT=mailto:$EMAIL"
fi

# The campus address next to the domain (the API refuses addresses it does not know).
origin="https://$IP:$HTTPS_PORT"
cur="$(get PCMS_ALLOWED_ORIGINS)"
[[ ",$cur," == *",$origin,"* ]] || { put PCMS_ALLOWED_ORIGINS "${cur:+$cur,}$origin"; note "allowed the campus address $origin"; }
cur="$(get PCMS_ALLOWED_HOSTS)"
[[ ",$cur," == *",$IP,"* ]] || put PCMS_ALLOWED_HOSTS "${cur:+$cur,}$IP"

chown root:pcms "$ENV_FILE"; chmod 640 "$ENV_FILE"

# ---------- backup key ----------
say "backup encryption key"
recipient="$DATA_DIR/secrets/backup_recipient.txt"
if [ -s "$recipient" ]; then
  note "already present ($recipient)"
else
  identity="/root/pcms-$ENVIRONMENT-backup-identity.txt"
  # age-keygen from a backup image already on this server; otherwise from a small public image.
  img="$(docker image ls pcms-backup --format '{{.Repository}}:{{.Tag}}' | head -n1)"
  if [ -n "$img" ]; then
    docker run --rm --entrypoint age-keygen "$img" > "$identity" 2>/dev/null
  else
    docker run --rm alpine:3.22 sh -c 'apk add -q age >/dev/null && age-keygen 2>/dev/null' > "$identity"
  fi
  chmod 600 "$identity"
  grep -q 'AGE-SECRET-KEY' "$identity" || { echo "could not create the backup key (Docker could not run age-keygen)" >&2; exit 1; }
  grep -o 'age1[0-9a-z]*' "$identity" | head -n1 > "$recipient"
  chmod 644 "$recipient"
  note "public key: $recipient"
  note "PRIVATE key: $identity  <- the only way to read the backups."
  note "Copy it to two custodians (password manager, USB in a safe), then delete it from this server."
fi

# ---------- certificate ----------
say "certificate for $DOMAIN and $IP"
cert="$DATA_DIR/certs/fullchain.pem"
if [ -s "$cert" ] && openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$IP"; then
  note "already names $DOMAIN and $IP"
else
  [ -s "$cert" ] && cp -a "$cert" "$cert.bak-$STAMP" && cp -a "$DATA_DIR/certs/privkey.pem" "$DATA_DIR/certs/privkey.pem.bak-$STAMP"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$DATA_DIR/certs/privkey.pem" -out "$cert" \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN,IP:$IP" 2>/dev/null
  chmod 644 "$cert"; chmod 600 "$DATA_DIR/certs/privkey.pem"
  note "self-signed, valid 825 days; visitors on the domain still see Cloudflare's trusted certificate"
fi

# ---------- continuous deployment ----------
say "/etc/pcms/$ENVIRONMENT.conf"
install -d -m 755 /etc/pcms
printf 'PCMS_PROJECT=%s\nPCMS_ENV_FILE=%s\nPCMS_HEALTH_URL=https://127.0.0.1:%s/api/v1/health/ready\n' \
  "$PROJECT" "$ENV_FILE" "$HTTPS_PORT" > "/etc/pcms/$ENVIRONMENT.conf"
chown root:root "/etc/pcms/$ENVIRONMENT.conf"; chmod 644 "/etc/pcms/$ENVIRONMENT.conf"
install -d -o "$(id -u gh-runner 2>/dev/null || echo 0)" -g "$(id -g gh-runner 2>/dev/null || echo 0)" /var/lib/pcms-deploy
note "project $PROJECT, health check on port $HTTPS_PORT"

# ---------- the `pcms` helper ----------
say "helper command: pcms"
cat > /usr/local/bin/pcms <<'HELPER'
#!/usr/bin/env bash
# pcms <staging|production> <command>   Day-to-day commands for a PCMS environment on this server.
#   status        what is deployed, container health, the health check
#   logs [svc]    last 200 lines (api, worker, nginx, migrate, backup, ...), follow with -f
#   admin --email E --name "N"   create a Team OSSC admin (prints a temporary password)
#   backup        take a backup now
#   psql          open the database
#   rollback [tag]  go back to the previous release
#   compose ...   any docker compose command for this environment
set -euo pipefail
ENVIRONMENT="${1:-}"; CMD="${2:-status}"; shift 2 2>/dev/null || shift $#
CONF="/etc/pcms/$ENVIRONMENT.conf"
[ -r "$CONF" ] || { echo "usage: pcms <staging|production> <status|logs|admin|backup|psql|rollback|compose ...>" >&2; exit 2; }
conf() { grep -E "^$1=" "$CONF" | tail -n1 | cut -d= -f2-; }
PROJECT="$(conf PCMS_PROJECT)"; ENV_FILE="$(conf PCMS_ENV_FILE)"; HEALTH="$(conf PCMS_HEALTH_URL)"
REPO=/srv/actions-runner/_work/pcms/pcms
[ -f "$REPO/compose.prod.yml" ] || REPO=/srv/server-data/pcms
TAG="$(cat "/var/lib/pcms-deploy/$ENVIRONMENT.current" 2>/dev/null || true)"
if [ -n "$TAG" ]; then export PCMS_IMAGE_API="pcms-api:$TAG" PCMS_IMAGE_WEB="pcms-web:$TAG" PCMS_IMAGE_BACKUP="pcms-backup:$TAG"; fi
export PCMS_ENV_FILE="$ENV_FILE"
dc() { docker compose -p "$PROJECT" -f "$REPO/compose.prod.yml" --env-file "$ENV_FILE" "$@"; }
case "$CMD" in
  status)
    echo "environment: $ENVIRONMENT   project: $PROJECT   release: ${TAG:-not deployed by CD yet}"
    dc ps --format 'table {{.Service}}\t{{.Status}}'
    printf 'health: '; curl -fsSk --max-time 10 "$HEALTH" && echo || echo "NOT OK ($HEALTH)"
    tail -n 5 "/var/lib/pcms-deploy/$ENVIRONMENT.history" 2>/dev/null | sed 's/^/deployed: /' || true ;;
  logs) dc logs --tail 200 "$@" ;;
  admin) dc exec api python -m app.cli create-admin "$@" ;;
  backup) dc exec -T backup backup.sh ;;
  psql) dc exec db psql -U pcms -d pcms ;;
  rollback) bash "$REPO/ops/deploy/rollback.sh" "$ENVIRONMENT" "$@" ;;
  compose) dc "$@" ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
HELPER
chmod 755 /usr/local/bin/pcms
note "try: sudo pcms $ENVIRONMENT status"

# ---------- ports ----------
say "ports"
for port in "$HTTP_PORT" "$HTTPS_PORT"; do
  owner="$(ss -ltnpH "sport = :$port" 2>/dev/null | head -n1 || true)"
  if [ -z "$owner" ]; then note "$port free"
  elif echo "$owner" | grep -q docker; then note "$port used by Docker (expected if $ENVIRONMENT is already running)"
  else note "WARNING: $port is used by: $owner"; fi
done

say "summary"
note "settings:    $ENV_FILE"
grep -E '^PCMS_(PUBLIC_APP_URL|HTTPS_PORT|HTTP_PORT|ALLOWED_ORIGINS|ALLOWED_HOSTS|VAPID_PUBLIC_KEY|VAPID_SUBJECT|CERT_DIR|SECRETS_DIR|BACKUP_DIR)=' "$ENV_FILE" | sed 's/^/             /'
note "Cloudflare:  public hostname $DOMAIN -> service HTTPS localhost:$HTTPS_PORT, TLS: No TLS Verify ON"
note "campus:      https://$IP:$HTTPS_PORT (certificate warning; push and install only on the domain)"
if [ "$ENVIRONMENT" = production ]; then
  note "next:        merge dev into main on GitHub; it deploys production. Then create the first admin:"
  note "             sudo pcms production admin --email you@dbit.in --name \"Your Name\""
else
  note "next:        merge the pull request into dev on GitHub; it deploys staging"
fi
