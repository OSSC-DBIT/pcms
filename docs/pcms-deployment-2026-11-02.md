# PCMS staging deployment - 2 November 2026 (updated 5 November 2026)

What we did to get PCMS running in Docker on the OSSC server and public at
https://pcms-staging.webuildnow.in, what went wrong, and how each problem was fixed.
It ends with how to open and clear the database, and (5 November) how continuous deployment
and the production configuration are set up.

## Result

- The production stack (`compose.prod.yml`) is running on the server.
- https://pcms-staging.webuildnow.in loads, and `/api/v1/health/ready` returns
  `{"status":"ok","database":"up"}`.
- Two Team OSSC admins (Mithun, Lekhan) are created and have signed in.
- No code was changed. Every fix was server or Cloudflare configuration.

## The server

| Item | Value |
|---|---|
| Machine | Dell Precision 7820, Ubuntu 24.04.5 |
| Repo | `/srv/server-data/pcms` (owned by root) |
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

Ports PCMS uses now (set in `pcms.env`):

| Port | What | Bound to |
|---|---|---|
| 676 | nginx HTTPS (the app) | all interfaces |
| 8082 | nginx HTTP (only redirects to HTTPS) | all interfaces |

Port 8081 (the old public listener for Twilio webhooks and signed photos) is gone since 4 November 2026.

PostgreSQL, the API, ClamAV and the job containers are not published on the host at all.

## Problems and fixes, in order

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

### 4. Start the stack

```sh
sudo docker compose -f compose.prod.yml --env-file pcms.env up -d --build
sudo docker compose -f compose.prod.yml ps
curl -sk https://127.0.0.1:676/api/v1/health/ready
```

`--env-file pcms.env` makes compose read the ports from `pcms.env`. The `--profile jobs`
and `--profile nginx` flags only matter for `compose.dev.yml`.

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

```sh
sudo docker compose -f compose.prod.yml exec api python -m app.cli create-admin-from-env
```

This creates every `PCMS_ADMIN_N_*` account from `pcms.env`. It is safe to re-run, because
it skips accounts that already exist. The passwords in the file are temporary: on first
sign-in, each admin sets a new password, sets up an authenticator app, and saves the
recovery codes.

To add one admin without the file (prints a generated temporary password):

```sh
sudo docker compose -f compose.prod.yml exec api python -m app.cli create-admin --email you@dbit.edu.in --name "Full Name"
```

Everyone else is added from the web app under Admin > People.

### Also in the way: no Docker access for the assistant

The `dbit-oscc` account is not in the `docker` group, the repo is owned by root, and sudo
needs a password, so every Docker command had to be run by hand. To let a tool run them:
`sudo usermod -aG docker dbit-oscc`, then log in again. Being in the `docker` group is
effectively root access to the machine.

## Still to do

- [ ] Delete the `PCMS_ADMIN_*` lines from `.env` and `pcms.env` (the passwords are in plain text).
- [ ] `sudo chmod 600 .env`. It is currently readable by every user on the server.
- [ ] Move `~/pcms-backup-identity.txt` off the server to a safe place (two custodians),
      then delete it here. It is the only key that can decrypt the backups.
- [ ] Stop the old dev stack, which is still running on 5173 and 8025:
      `sudo docker compose -f compose.dev.yml down`.
- [x] ~~Email: `smtp.dbit.edu.in` does not resolve from this server.~~ Not needed: email was removed on
      4 November 2026. Web push is the only notification channel.
- [ ] Push notifications: `PCMS_VAPID_*` keys are empty, and since 4 November the stack refuses to start
      without them. See "Update, 5 November 2026" below.
- [ ] Rate limiting: all tunnel traffic reaches nginx from one address, so every visitor
      shares one rate limit (sign-in: 30 per minute). nginx should read Cloudflare's
      `CF-Connecting-IP` header (code change in `nginx/snippets/http.conf`).
- [ ] Minor: the HSTS header is sent on API responses but not on pages, because location
      blocks with their own `add_header` drop the server-level one.
- [ ] Ports 676 and 8082 are open on all interfaces. Check the firewall (`sudo ufw status`).
      On campus the app is at `https://<server-ip>:676`.
- [ ] Before real use: confirm a nightly backup appears in `/srv/pcms/backups` and do a
      restore drill (`docs/DEPLOYMENT.md` section 7).

## Update, 5 November 2026: continuous deployment and the production configuration

From now on nobody runs `docker compose ... up` by hand on this server. A push deploys itself after CI passes:

| Branch | Environment | URL | Compose project | Env file | HTTPS port |
|---|---|---|---|---|---|
| `dev` | staging | https://pcms-staging.webuildnow.in | `pcms` (the existing volumes) | `/srv/server-data/pcms/pcms.env` | 676 |
| `main` | production | (to be decided) | `pcms-prod` | `/srv/pcms-prod/pcms.env` | 677 (or any free port) |

Both use `compose.prod.yml`. The dev stack (`compose.dev.yml`) is only for laptops and CI's tests; stop it here
if it still runs: `sudo docker compose -f compose.dev.yml down`.

Staging keeps the project name `pcms` on purpose: its database and uploads are in the volumes `pcms_pgdata`
and `pcms_media`. A different name would start an empty database.

### 1. Fix staging's `pcms.env` first

`sudo nano /srv/server-data/pcms/pcms.env`, then:

**Delete these lines** (removed features; ignored if left, but they confuse the next person):

```
PCMS_SMTP_HOST  PCMS_SMTP_PORT  PCMS_SMTP_STARTTLS  PCMS_SMTP_USERNAME  PCMS_SMTP_PASSWORD  PCMS_SMTP_FROM
PCMS_MESSAGING_PROVIDER
PCMS_TWILIO_ACCOUNT_SID  PCMS_TWILIO_AUTH_TOKEN  PCMS_TWILIO_WHATSAPP_FROM  PCMS_TWILIO_SMS_FROM
PCMS_TWILIO_JOB_CONTENT_SID  PCMS_TWILIO_JOB_MEDIA_CONTENT_SID  PCMS_FACILITIES_DESK_PHONE
PCMS_PUBLIC_BASE_URL  PCMS_PUBLIC_PORT  PCMS_PUBLIC_BIND
PCMS_ACCEPT_TIMEOUT_MINUTES
PCMS_ADMIN_1_* and PCMS_ADMIN_2_* (already on the to-do list: the admins have signed in)
```

**Make sure these are set** (`.env.example` has every line with a comment):

```
PCMS_PUBLIC_APP_URL=https://pcms-staging.webuildnow.in
PCMS_HTTP_PORT=8082
PCMS_HTTPS_PORT=676
PCMS_CERT_DIR=/srv/pcms/certs
PCMS_SECRETS_DIR=/srv/pcms/secrets
PCMS_BACKUP_DIR=/srv/pcms/backups
PCMS_VAPID_PUBLIC_KEY=...      # generate below
PCMS_VAPID_PRIVATE_KEY=...
PCMS_VAPID_SUBJECT=mailto:<a real OSSC address>
# Only if people on campus also open https://<server-ip>:676 (otherwise those requests are refused):
PCMS_ALLOWED_ORIGINS=https://<server-ip>:676
PCMS_ALLOWED_HOSTS=<server-ip>
```

Generate the push keys once and keep them:
`sudo docker compose -f compose.prod.yml exec api python -m app.cli vapid-keys`.
The three folder paths must be absolute, and the backup folder must belong to the backup container's
user: `sudo chown 70:70 /srv/pcms/backups`. Without that, backups fail with "permission denied", and a
production deploy refuses to run without a backup.

In Cloudflare Zero Trust, delete any tunnel route that pointed at `localhost:8081`. The app route
(`https://localhost:676`, No TLS Verify) stays as it is.

### Opening staging on the campus network too

Staging answers at both addresses:

| Address | Who | Certificate |
|---|---|---|
| https://pcms-staging.webuildnow.in | everyone, through the Cloudflare tunnel | Cloudflare's, trusted |
| https://`<server-ip>`:676 | people on the campus network, directly | the server's own self-signed one |

The API refuses requests from any address it does not know, so list the local one in `pcms.env` next to
the domain, then let the next deploy (or `up -d`) pick it up:

```
PCMS_PUBLIC_APP_URL=https://pcms-staging.webuildnow.in
PCMS_ALLOWED_ORIGINS=https://<server-ip>:676
PCMS_ALLOWED_HOSTS=<server-ip>
```

For a local name as well (for example `pcms.lan` set up in the campus DNS), add it to both lists,
comma-separated: `PCMS_ALLOWED_ORIGINS=https://<server-ip>:676,https://pcms.lan:676` and
`PCMS_ALLOWED_HOSTS=<server-ip>,pcms.lan`.

Reissue the certificate so it also names the local address (it currently names only the domain):

```sh
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /srv/pcms/certs/privkey.pem -out /srv/pcms/certs/fullchain.pem \
  -subj "/CN=pcms-staging.webuildnow.in" \
  -addext "subjectAltName=DNS:pcms-staging.webuildnow.in,IP:<server-ip>"
sudo chmod 600 /srv/pcms/certs/privkey.pem
cd /srv/server-data/pcms && sudo docker compose -f compose.prod.yml --env-file pcms.env exec nginx nginx -s reload
```

Cloudflare keeps working: the tunnel has **No TLS Verify** on and does not check the name.

The local address still shows a certificate warning, because the certificate is self-signed. After you click
through, the app works, but browsers **refuse install and push notifications** on a page with a certificate
error. Use the domain for phones and anyone who needs notifications. For working push on the local address
too, either:
- install the certificate as trusted on those devices (fine for a few staff machines), or
- point a local name at the server in the campus DNS and give it a publicly trusted certificate (for example
  Let's Encrypt with the DNS-01 challenge on a `webuildnow.in` subdomain), then list that name above.

Check the firewall lets campus machines reach port 676: `sudo ufw status`.

### 2. Install the self-hosted runner

The deploy runs on this machine through a GitHub Actions runner. The runner connects out to GitHub, so
nothing new is opened to the internet and no password or SSH key goes into GitHub.

```sh
sudo useradd -m -s /bin/bash gh-runner
sudo usermod -aG docker gh-runner              # docker group = root on this machine; runner use only
sudo apt-get install -y git curl util-linux
sudo install -d -o gh-runner -g gh-runner /srv/actions-runner /var/lib/pcms-deploy
```

In GitHub: `OSSC-DBIT/pcms`, Settings, Actions, Runners, **New self-hosted runner**, Linux x64. Run the
commands it shows as `gh-runner` inside `/srv/actions-runner` (`sudo -iu gh-runner`). When `config.sh` asks
for labels, type `pcms`. Then, back as your own user:

```sh
cd /srv/actions-runner && sudo ./svc.sh install gh-runner && sudo ./svc.sh start
```

Let the runner read the env file without making it world-readable:

```sh
sudo groupadd -f pcms && sudo usermod -aG pcms gh-runner
sudo chown root:pcms /srv/server-data/pcms/pcms.env && sudo chmod 640 /srv/server-data/pcms/pcms.env
sudo ./svc.sh stop && sudo ./svc.sh start       # pick up the new groups
```

### 3. Tell the deploy where staging lives

```sh
sudo install -d /etc/pcms
sudo cp /srv/server-data/pcms/ops/deploy/staging.conf.example /etc/pcms/staging.conf
sudo chmod 644 /etc/pcms/staging.conf
```

The example already holds staging's values: project `pcms`, env file `/srv/server-data/pcms/pcms.env`, and
health check `https://127.0.0.1:676/api/v1/health/ready`.

### 4. Branches

Create `dev` from `main` and push it. Protect `main` and `dev` in Settings, Branches: require a pull request,
require the CI checks, and block force pushes. Work goes feature branch, then a pull request to `dev`
(deploys staging), then a pull request from `dev` to `main` (deploys production).

### 5. First deploy

Push to `dev`, or run it by hand: GitHub, Actions, **Deploy**, Run workflow, branch `dev`, environment
`staging`. Watch the log. A good run ends with `deployed staging-<sha> and healthy`. To go back one release:
`sudo bash /srv/actions-runner/_work/pcms/pcms/ops/deploy/rollback.sh staging`.

### Production, later

Production gets its **own** everything, so it can never touch staging's data:
- `/srv/pcms-prod/` with `pcms.env` (new database password, `PCMS_SECRET_KEY`, `PCMS_CREDENTIAL_KEY`, VAPID
  keys, admins, the production `PCMS_PUBLIC_APP_URL`, ports such as 8083 and 677) and `certs/`, `secrets/`,
  `backups/` (`chown 70:70`).
- `/etc/pcms/production.conf` from `ops/deploy/production.conf.example` (project `pcms-prod`).
- Its own Cloudflare tunnel hostname pointing at its HTTPS port.
- Then merge `dev` into `main`. A production deploy refuses to continue if the backup before it fails.

`docs/DEPLOYMENT.md` section 8 explains every step the deploy takes.

## The database

### How to open it

PostgreSQL is on an internal Docker network and has no host port, on purpose. Open it
through the container:

```sh
cd /srv/server-data/pcms
sudo docker compose -f compose.prod.yml exec db psql -U pcms -d pcms
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
sudo docker compose -f compose.prod.yml exec -T db pg_dump -U pcms -Fc pcms > ~/pcms-before-clear.dump
chmod 600 ~/pcms-before-clear.dump    # it contains password hashes
```

To put it back:

```sh
sudo docker compose -f compose.prod.yml exec -T db pg_restore -U pcms -d pcms --clean --if-exists < ~/pcms-before-clear.dump
```

### Option A: clear tickets, keep accounts and settings

Removes every ticket and everything attached to it: history, comments, ratings, photos,
approvals and queued notifications. Ticket numbers start again at `-0001`. People,
categories and buildings stay.

```sh
sudo docker compose -f compose.prod.yml exec -T db psql -U pcms -d pcms -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
TRUNCATE ticket, ticket_event, ticket_comment, ticket_rating, attachment,
         proposal, proposal_line, decision, assignment,
         outbox, delivery_attempt, provider_event,
         token_counter, text_translation
  RESTART IDENTITY CASCADE;
COMMIT;
SQL

# Delete the photo and document files too, or they stay on disk with nothing pointing to them
sudo docker compose -f compose.prod.yml exec api find /data/media -mindepth 1 -delete
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
cd /srv/server-data/pcms
sudo docker compose -f compose.prod.yml --env-file pcms.env down
sudo docker volume rm pcms_pgdata pcms_media
sudo docker compose -f compose.prod.yml --env-file pcms.env up -d
sudo docker compose -f compose.prod.yml ps                      # migrate should show Exited (0)
sudo docker compose -f compose.prod.yml exec api python -m app.cli create-admin-from-env
```

- Do not use `down -v`. It also deletes `pcms_clamdb`, and ClamAV then downloads its
  signatures again, which takes several minutes.
- `create-admin-from-env` needs the `PCMS_ADMIN_*` lines in `pcms.env`. If you have
  already removed them, use `create-admin --email ... --name ...` instead.
- The database login comes from `PCMS_DB_USER` and `PCMS_DB_PASSWORD` in `pcms.env` and is
  created again when the empty volume starts.
