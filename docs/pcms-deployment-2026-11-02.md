# PCMS staging deployment - 2 November 2026 (updated 5 November 2026)

What we did to get PCMS running in Docker on the OSSC server and public at
https://pcms-staging.webuildnow.in, what went wrong, and how each problem was fixed.
It ends with how to open and clear the database, and (5 November) how continuous deployment
and the production configuration are set up.

> **Since 5 November 2026, never run `docker compose ... up` (or `--build`) by hand on this server.**
> GitHub deploys: a merge to `dev` deploys staging, a merge to `main` deploys production. For
> everything else use `sudo pcms <staging|production> ...` ([SERVER.md](SERVER.md)). Sections 1 to 7
> below are the history of the first manual setup on 2 November; their commands are kept for the
> record and must not be run again. Problem 8 shows what happens if you do.

## Where things are now

| What | Staging | Production |
|---|---|---|
| Address | https://pcms-staging.webuildnow.in | https://pcms.webuildnow.in |
| Deployed by | merge to `dev` | merge to `main` |
| Compose project | `pcms` | `pcms-prod` |
| Settings file | `/srv/server-data/staging/pcms/pcms.env` | `/srv/server-data/production/pcms/pcms.env` |
| Certificates | `/srv/server-data/staging/pcms/certs/` | `/srv/server-data/production/pcms/certs/` |
| Backup public key | `/srv/server-data/staging/pcms/secrets/` | `/srv/server-data/production/pcms/secrets/` |
| Backups | `/srv/server-data/staging/pcms/backups/` | `/srv/server-data/production/pcms/backups/` |
| Database and uploads | Docker volumes `pcms_pgdata`, `pcms_media` | `pcms-prod_pgdata`, `pcms-prod_media` |
| Where the deploy is described | `/etc/pcms/staging.conf` | `/etc/pcms/production.conf` |
| Ports (HTTPS / HTTP) | 676 / 8082 | 677 / 8083 |

The code is not kept in a folder of its own: the GitHub runner checks out the commit for each deploy into
`/srv/actions-runner/_work/pcms/pcms`. The old checkout `/srv/server-data/pcms` and the old `/srv/pcms`
folders are no longer used (see "To do", step 7).

## Result (2 November)

- The production stack (`compose.prod.yml`) is running on the server.
- https://pcms-staging.webuildnow.in loads, and `/api/v1/health/ready` returns
  `{"status":"ok","database":"up"}`.
- Two Team OSSC admins (Mithun, Lekhan) are created and have signed in.
- No code was changed. Every fix was server or Cloudflare configuration.

## The server

| Item | Value |
|---|---|
| Machine | Dell Precision 7820, Ubuntu 24.04.5 |
| Code | checked out per deploy in `/srv/actions-runner/_work/pcms/pcms` (until 5 November: `/srv/server-data/pcms`) |
| Settings and files | `/srv/server-data/<staging\|production>/pcms/` |
| Public access | Cloudflare Tunnel (`cloudflared.service`), no ports open to the internet |

Other services already on this machine, and their ports:

| Port | Service |
|---|---|
| 22 | SSH |
| 8000, 6001, 6002 | Coolify (`coolify.webuildnow.in`) |
| 8080 | OSSC website nginx (`OSSC.webuildnow.in`) |
| 9000, 9443 | Portainer |
| 9090 | Cockpit |
| 20128 | OmniRoute |

Ports PCMS uses now (set in each `pcms.env`):

| Port | What | Bound to |
|---|---|---|
| 676 | staging nginx HTTPS (the app) | all interfaces |
| 8082 | staging nginx HTTP (only redirects to HTTPS) | all interfaces |
| 677 | production nginx HTTPS | all interfaces |
| 8083 | production nginx HTTP (only redirects) | all interfaces |

Port 8081 (the old public listener for Twilio webhooks and signed photos) is gone since 4 November 2026.

PostgreSQL, the API, ClamAV and the job containers are not published on the host at all.

## Problems and fixes, in order

Sections 1 to 7 are from 2 November, before continuous deployment. The paths they use (`/srv/pcms/...`,
`/srv/server-data/pcms/pcms.env`) are the old ones; staging's files are now in
`/srv/server-data/staging/pcms/`. Do not run these commands again.

### 1. API container would not start: port 8000 taken

Error:

```
Bind for 0.0.0.0:8000 failed: port is already allocated
... endpoint pcms-dev-api-1 ...
```

Cause: we were running the **dev** stack (`compose.dev.yml`). It publishes the API on host
port `PCMS_API_PORT`, default 8000. Coolify already listens on 8000. Changing
`PCMS_HTTP_PORT` and `PCMS_HTTPS_PORT` in `.env` did not help, because the clash was on the
API port, and `PCMS_HTTPS_PORT` is not used by the dev stack at all.

Fix: switch to the **production** stack (`compose.prod.yml`). It does not publish the API
port, so there is nothing to clash with. (For the dev stack, the fix would be
`PCMS_API_PORT=8001` in `.env`.)

We also changed in `.env`: `PCMS_HTTP_PORT` 80 -> 8082 and `PCMS_HTTPS_PORT` 443 -> 676.

### 2. `pcms.env not found`

Error:

```
env file /srv/server-data/pcms/pcms.env not found
```

Cause: `compose.prod.yml` reads app settings from `pcms.env`, not `.env`.

Fix:

```sh
sudo cp .env pcms.env
```

### 3. Backup secret missing

Error:

```
bind source path does not exist: /srv/pcms/secrets/backup_recipient.txt
```

Cause: the `backup` service needs a public key to encrypt nightly backups, and production
nginx needs TLS certificates. Neither existed, and nor did the `/srv/pcms` folders.

Fix: create the folders, an `age` backup key pair, and a self-signed certificate:

```sh
sudo mkdir -p /srv/pcms/{secrets,certs,backups}
sudo chmod 700 /srv/pcms/secrets
sudo chmod 600 pcms.env

sudo docker run --rm --entrypoint age-keygen pcms-backup:release > ~/pcms-backup-identity.txt
chmod 600 ~/pcms-backup-identity.txt
grep 'public key' ~/pcms-backup-identity.txt | awk '{print $4}' | sudo tee /srv/pcms/secrets/backup_recipient.txt

sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /srv/pcms/certs/privkey.pem -out /srv/pcms/certs/fullchain.pem \
  -subj "/CN=pcms-staging.webuildnow.in" \
  -addext "subjectAltName=DNS:pcms-staging.webuildnow.in"
sudo chmod 600 /srv/pcms/certs/privkey.pem
```

The certificate expires on 2 November 2027.

### 4. Start the stack (2 November only; now done by the deploy)

```sh
# Historical. Do not run: see problem 8.
sudo docker compose -f compose.prod.yml --env-file pcms.env up -d --build
```

Today: `sudo pcms staging status` shows what runs, and the health check is
`curl -sk https://127.0.0.1:676/api/v1/health/ready` (production: port 677).

### 5. Cloudflare: `400 The plain HTTP request was sent to HTTPS port`

Cause: the tunnel's public hostname was set to `http://localhost:676`. Port 676 speaks
HTTPS only.

Fix: Cloudflare Zero Trust > Networks > Tunnels > the tunnel > Public hostname >
`pcms-staging.webuildnow.in` > change the type from `HTTP` to `HTTPS` (URL `localhost:676`).

Do not point the tunnel at port 8082 instead. That port only redirects to HTTPS, so the
browser would loop.

### 6. Cloudflare: `502 Bad gateway`

`cloudflared` log:

```
tls: failed to verify certificate: x509: certificate is valid for pcms-staging.webuildnow.in, not localhost
```

Cause: `cloudflared` checks nginx's certificate. Ours is self-signed and issued for the
domain, not for `localhost`.

Fix: same hostname > Additional application settings > TLS > turn on **No TLS Verify** >
**Save hostname**. The first attempt did not apply because the setting was never saved.
Visitors still get Cloudflare's trusted certificate. This setting only affects the hop
from `cloudflared` to nginx on the same machine.

How to check what the tunnel is actually using:

```sh
curl -s http://127.0.0.1:20241/config      # live ingress rules
journalctl -u cloudflared --since "-10 min" | grep ERR
```

### 7. Admin accounts

The one-time `PCMS_ADMIN_N_*` lines and `create-admin-from-env` were used on 2 November only; the setup
script now removes those lines. To add an admin (prints a generated temporary password):

```sh
sudo pcms staging admin --email you@dbit.edu.in --name "Full Name"      # or: production
```

On first sign-in, each admin sets a new password, sets up an authenticator app, and saves the recovery codes.
Everyone else is added from the web app under Admin > People.

### 8. Running `docker compose up` by hand took staging down (5 November)

Output, twice, when trying to start production by hand from the old checkout:

```
 ✔ Image pcms-api:release     Built
 ✘ Container pcms-migrate-1   Error service "migrate" didn't complete successfully: exit 255
 ✔ Container pcms-api-1       Recreated
```

and https://pcms-staging.webuildnow.in returned `502 Bad Gateway`.

Cause:
- `docker compose` without `-p` names the project after the folder. In `/srv/server-data/pcms` that is
  `pcms`, which is **staging's** project. So the command replaced staging's containers; it did not start
  production at all (production is the project `pcms-prod`, and its settings file is a different one).
- It built from the old checkout, which is older than the database. The deploy had already migrated the
  database to `0014`; the old code does not know `0014`, so `alembic upgrade` stopped with
  "Can't locate revision" (exit 255). Compose had already replaced the API, worker and scheduler and then
  never started them.
- Nothing in the database changed: the migration stopped before doing anything, and the volumes stayed.

Fix: re-run the last good deploy (GitHub, Actions, **Deploy**, Run workflow, branch `dev`). It ended with
`deployed staging-<sha> and healthy`.

Rule: production is started by merging `dev` into `main`, never by hand. Delete the old checkout
(step 7 below) so the command cannot be run from it again.

### Also in the way: no Docker access for the assistant

The `dbit-oscc` account is not in the `docker` group, the repo is owned by root, and sudo
needs a password, so every Docker command had to be run by hand. To let a tool run them:
`sudo usermod -aG docker dbit-oscc`, then log in again. Being in the `docker` group is
effectively root access to the machine.

## Still to do

- [x] ~~Delete the `PCMS_ADMIN_*` lines from `pcms.env`.~~ The setup script removed them (5 November).
- [ ] Delete the old checkout `/srv/server-data/pcms` (its `.env` still holds the one-time admin passwords
      and is readable by every user). See "To do, in order", step 7.
- [ ] Move `/root/pcms-<env>-backup-identity.txt` and the older `~/pcms-backup-identity.txt` off the server to
      a safe place (two custodians), then delete them here. They are the only keys that can decrypt the backups.
- [ ] Stop the old dev stack if it is still running on 5173 and 8025: `sudo docker compose -p pcms-dev ls`
      shows it; `sudo docker compose -p pcms-dev down` stops it (not `-v`).
- [x] ~~Email: `smtp.dbit.edu.in` does not resolve from this server.~~ Not needed: email was removed on
      4 November 2026. Web push is the only notification channel.
- [x] ~~Push notifications: `PCMS_VAPID_*` keys are empty.~~ The setup script created them (5 November).
- [ ] Rate limiting: all tunnel traffic reaches nginx from one address, so every visitor
      shares one rate limit (sign-in: 30 per minute). nginx should read Cloudflare's
      `CF-Connecting-IP` header (code change in `nginx/snippets/http.conf`).
- [ ] Minor: the HSTS header is sent on API responses but not on pages, because location
      blocks with their own `add_header` drop the server-level one.
- [ ] Ports 676, 677, 8082 and 8083 are open on all interfaces. Check the firewall (`sudo ufw status`).
- [ ] Before real use: confirm a nightly backup appears in `/srv/server-data/production/pcms/backups` and do a
      restore drill (`docs/DEPLOYMENT.md` section 7).

## Update, 5 November 2026: continuous deployment, production, push only

From now on nobody runs `docker compose ... up` by hand here. A merge into `dev` or `main` deploys itself (the
tests ran on the pull request). The
general server runbook (ports, folders, the `pcms` helper, adding more apps) is [SERVER.md](SERVER.md).

| Branch | Environment | Address | Compose project | Settings file | Ports (HTTPS / HTTP) |
|---|---|---|---|---|---|
| `dev` | staging | https://pcms-staging.webuildnow.in | `pcms` (the existing volumes) | `/srv/server-data/staging/pcms/pcms.env` | 676 / 8082 |
| `main` | production | https://pcms.webuildnow.in | `pcms-prod` (its own volumes) | `/srv/server-data/production/pcms/pcms.env` | 677 / 8083 |

Everyone uses the Cloudflare addresses. There is no separate clone per environment: the runner checks out the
commit for each deploy. Staging moved from `/srv/server-data/pcms` and `/srv/pcms` to `/srv/server-data/staging/pcms` on
5 November (the setup script copies it); the old folders go once the first deploy works (SERVER.md, "Retiring
the old staging layout").

Both run `compose.prod.yml`. Staging keeps the project name `pcms` on purpose: its database and uploads are in
`pcms_pgdata` and `pcms_media`, and a new name would start an empty database. Production never shares anything
with staging: its own database, keys, admins, folders, ports and backups.

### Done

- **GitHub:** `dev` created from `main`. `dev` and `main` protected (pull request, the four CI checks, no
  force push). Outside contributors' workflows need approval. The default workflow token is read-only.
- **Runner:** `ossc-server` installed as user `gh-runner` (service
  `actions.runner.OSSC-DBIT-pcms.ossc-server`, label `pcms`), online in GitHub. `/etc/pcms/staging.conf`
  written, and the backup folder given to uid 70.
- `apt` on this machine is blocked by an unfinished kernel and NVIDIA update (see SERVER.md, "Known issues").
  The setup did not need it.
- **Staging settings** moved to `/srv/server-data/staging/pcms/` by the setup script (push keys, campus
  address, certificate with the server IP).
- **First staging deploy:** pull request #7 merged into `dev`; Deploy ended with
  `deployed staging-e6a9b4932abf and healthy`.

### To do, in order

**1. Check staging** (on the server, then on a phone):
- `sudo pcms staging status`: the release is `staging-<sha>`, every container is up, health `ok`.
- https://pcms-staging.webuildnow.in: sign in, report, and allow notifications. Then **Settings,
  Notifications, Send test**.

**2. Production settings, one command** (do **not** run `docker compose up`; see problem 8):

```sh
curl -fsSL https://raw.githubusercontent.com/OSSC-DBIT/pcms/dev/ops/deploy/setup-environment.sh -o /tmp/setup-env.sh && sudo bash /tmp/setup-env.sh production --email <ossc contact email>
```

It creates `/srv/server-data/production/pcms/` with a fresh database password, secret keys, push keys, backup
key, certificate, and `/etc/pcms/production.conf`. It does not start anything. It prints where the backup
**private** key is: copy that to two custodians and delete it from the server.
Check: `cat /etc/pcms/production.conf` shows `PCMS_PROJECT=pcms-prod` and
`PCMS_ENV_FILE=/srv/server-data/production/pcms/pcms.env`.

**3. Cloudflare:** Zero Trust, Networks, Tunnels, the tunnel, Public hostname, **Add**. Subdomain `pcms`,
domain `webuildnow.in`, type **HTTPS**, URL `localhost:677`. Under Additional application settings, TLS, turn
on **No TLS Verify**, then **Save hostname**.

**4. First production deploy:** on GitHub open a pull request from `dev` to `main` and merge it once CI passes.
Actions, **Deploy** ends with `deployed production-<sha> and healthy`. Then create the first admin, who signs
in, sets a password and scans the authenticator code:

```sh
sudo pcms production admin --email <you@dbit.in> --name "<Your Name>"
```

That admin adds everyone else under Admin, People (one by one, or the Excel import).

**5. Test production:** `sudo pcms production status`, then https://pcms.webuildnow.in on a phone, including
**Send test** under Settings, Notifications.

**6. Clean up Cloudflare:** delete any tunnel route to `localhost:8081`.

**7. Retire the old staging folders** once staging works (keeps a copy in `/root`; the database and uploads
are Docker volumes and are not touched):

```sh
sudo tar -C /srv -czf /root/pcms-old-staging-$(date +%F).tar.gz server-data/pcms pcms && sudo rm -rf /srv/server-data/pcms /srv/pcms
```

Delete the archive once you are sure nothing is missing: it holds the old `.env` with the one-time admin
passwords.

### Settings that no longer exist

The setup script removes these from staging's `pcms.env`. Do not add them to a new one:
`PCMS_SMTP_*`, `PCMS_MESSAGING_PROVIDER`, `PCMS_TWILIO_*`, `PCMS_FACILITIES_DESK_PHONE`, `PCMS_PUBLIC_BASE_URL`,
`PCMS_PUBLIC_PORT`, `PCMS_PUBLIC_BIND`, `PCMS_ACCEPT_TIMEOUT_MINUTES`, and the one-time `PCMS_ADMIN_*` lines
once the admins have signed in. `.env.example` lists every setting that does exist.

### If a deploy fails

The log in Actions shows the step and the container logs. A failed migration leaves the old release serving.
To go back one release: `sudo pcms staging rollback` (or `production`). If the release being undone ran a
migration (see CHANGELOG.md), restore the backup taken just before it instead (DEPLOYMENT.md section 7).

## The database

### How to open it

PostgreSQL is on an internal Docker network and has no host port, on purpose. Open it
through the container (use `production` instead of `staging` for production):

```sh
sudo pcms staging psql
```

Useful commands inside `psql`:

```sql
\dt                                    -- list tables
\d ticket                              -- columns of a table
SELECT email, name, role, active FROM app_user;
SELECT token, status, title, created_at FROM ticket ORDER BY created_at DESC LIMIT 20;
SELECT count(*) FROM ticket;
\q                                     -- quit
```

### Always take a copy first

```sh
sudo pcms staging compose exec -T db pg_dump -U pcms -Fc pcms > ~/pcms-before-clear.dump
chmod 600 ~/pcms-before-clear.dump    # it contains password hashes
```

To put it back:

```sh
sudo pcms staging compose exec -T db pg_restore -U pcms -d pcms --clean --if-exists < ~/pcms-before-clear.dump
```

### Option A: clear tickets, keep accounts and settings

Removes every ticket and everything attached to it: history, comments, ratings, photos,
approvals and queued notifications. Ticket numbers start again at `-0001`. People,
categories and buildings stay.

```sh
sudo pcms staging compose exec -T db psql -U pcms -d pcms -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
TRUNCATE ticket, ticket_event, ticket_comment, ticket_rating, attachment,
         proposal, proposal_line, decision, assignment,
         outbox, delivery_attempt, provider_event,
         token_counter, text_translation
  RESTART IDENTITY CASCADE;
COMMIT;
SQL

# Delete the photo and document files too, or they stay on disk with nothing pointing to them
sudo pcms staging compose exec api find /data/media -mindepth 1 -delete
```

Notes:
- `ticket_event`, `ticket_comment`, `decision`, `delivery_attempt` and `audit_event` are
  append-only: a trigger blocks `UPDATE` and `DELETE`. `TRUNCATE` does not fire those
  triggers, so it works. Use it only for clearing test data. On a live system this
  history is the audit record.
- `audit_event` is left alone, so the record of who did what remains. Add it to the list
  if you also want an empty audit log.
- To remove people, deactivate them under Admin > People instead of deleting rows.
  Their past actions still point to them.

### Option B: wipe everything and start fresh

Deletes the whole database and all uploaded files, including the admin accounts.
Migrations rebuild the tables and the seed restores categories and buildings.

```sh
sudo pcms staging compose down
sudo docker volume rm pcms_pgdata pcms_media          # production: pcms-prod_pgdata pcms-prod_media
sudo pcms staging compose up -d
sudo pcms staging status                              # migrate should show Exited (0)
sudo pcms staging admin --email you@dbit.in --name "Your Name"
```

- Do not use `down -v`. It also deletes `pcms_clamdb`, and ClamAV then downloads its
  signatures again, which takes several minutes.
- The database login comes from `PCMS_DB_USER` and `PCMS_DB_PASSWORD` in `pcms.env` and is
  created again when the empty volume starts.
