# PCMS staging deployment - 2 November 2026

What we did to get PCMS running in Docker on the OSSC server and public at
https://pcms-staging.webuildnow.in, what went wrong, and how each problem was fixed.
It ends with how to open and clear the database.

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
| 8081 | nginx public listener (Twilio webhooks, signed photos) | 127.0.0.1 |

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
- [ ] Email: `smtp.dbit.edu.in` does not resolve from this server, so no email is sent.
      Get the right SMTP host from college IT.
- [ ] Push notifications: `PCMS_VAPID_*` keys are empty. Generate them with
      `sudo docker compose -f compose.prod.yml exec api python -m app.cli vapid-keys`, put them
      in `pcms.env`, then `up -d`.
- [ ] Rate limiting: all tunnel traffic reaches nginx from one address, so every visitor
      shares one rate limit (sign-in: 30 per minute). nginx should read Cloudflare's
      `CF-Connecting-IP` header (code change in `nginx/snippets/http.conf`).
- [ ] Minor: the HSTS header is sent on API responses but not on pages, because location
      blocks with their own `add_header` drop the server-level one.
- [ ] Ports 676 and 8082 are open on all interfaces. Check the firewall (`sudo ufw status`).
      On campus the app is at `https://<server-ip>:676`.
- [ ] Before real use: confirm a nightly backup appears in `/srv/pcms/backups` and do a
      restore drill (`docs/DEPLOYMENT.md` section 7).

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
