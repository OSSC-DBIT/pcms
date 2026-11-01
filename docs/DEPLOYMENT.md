# Deploying PCMS on the college server

Ownership follows plan v1.2 section 25:
- **College IT** owns the server, DNS, certificates and firewall.
- **Facilities** owns the service.
- **Team OSSC** prepares releases.

The commands below are for a Linux server (Ubuntu 24.04 LTS or similar) with Docker Engine and the Compose plugin.

```mermaid
flowchart LR
    A[1 Prepare host] --> B[2 DNS + HTTPS]
    B --> C[3 Secrets + settings]
    C --> D[4 Build or load images]
    D --> E[5 Start + first admin]
    E --> F[6 Twilio + push]
    F --> G[7 Backups + restore drill]
    G --> H[Pilot]
```

## 1. Prepare the host

- 4 CPU cores, 8 GB RAM, 256 GB SSD, wired network, UPS, plus at least 1 TB of separate backup storage.
- Create a service account (for example `pcms`) and the folders:
  ```sh
  sudo mkdir -p /srv/pcms/{secrets,certs,backups}
  sudo chown -R pcms:pcms /srv/pcms && sudo chmod 700 /srv/pcms/secrets
  ```
- Put the repository release in `/srv/pcms/app`. Allow SSH only from the management network or VPN.
  Never publish PostgreSQL or port 8000.

## 2. DNS and HTTPS

- IT points an internal DNS name (for example `pcms.dbit.edu.in`) at the server.
- Get a publicly trusted certificate, for example Let's Encrypt with the DNS-01 challenge, so the
  app itself does not have to be public. Copy `fullchain.pem` and `privkey.pem` to `/srv/pcms/certs/`.
- Renewal must replace these files and then run `docker compose -f compose.prod.yml exec nginx nginx -s reload`.
- HTTPS is required: the camera, install, offline support and notifications do not work over plain HTTP.

## 3. Secrets and settings

```sh
cd /srv/pcms/app
cp .env.example /srv/pcms/pcms.env && chmod 600 /srv/pcms/pcms.env
python3 -c "import secrets; print(secrets.token_urlsafe(24))"      # PCMS_DB_PASSWORD
python3 -c "import secrets; print(secrets.token_urlsafe(48))"      # PCMS_SECRET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(48))"      # PCMS_CREDENTIAL_KEY
```

Edit `/srv/pcms/pcms.env`:
- Set `PCMS_DB_NAME`, `PCMS_DB_USER` and `PCMS_DB_PASSWORD`. PostgreSQL creates this login the first
  time it starts with an empty data volume. The API, the migrations and the backups all use the same
  values. `migrate` refuses to start if the password is empty or still `CHANGE_ME`.
- Set `PCMS_SECRET_KEY` and `PCMS_CREDENTIAL_KEY`.
  `PCMS_CREDENTIAL_KEY` encrypts temporary passwords until each person chooses their own. Keep it out of
  backups of the database; losing it means Team OSSC must reset any temporary password still outstanding.
- Change `PCMS_HTTP_PORT`, `PCMS_HTTPS_PORT` or `PCMS_PUBLIC_PORT` if 80, 443 or 8081 are already in use.
- Add the Team OSSC admins: `PCMS_ADMIN_1_EMAIL`, `PCMS_ADMIN_1_NAME`, `PCMS_ADMIN_1_PASSWORD`, then
  `PCMS_ADMIN_2_...` and so on (step 5).
- Set the hostnames, the SMTP relay, and `PCMS_MESSAGING_PROVIDER` (`none` until Twilio is ready).

**Changing the database password later.** Changing `PCMS_DB_PASSWORD` alone does not change the existing
database. First run `docker compose -f compose.prod.yml exec db psql -U pcms -d pcms` and type
`\password pcms`, then put the same value in `pcms.env` and run `up -d`.

**Upgrading from a release that used secret files.** Copy the contents of `/srv/pcms/secrets/db_password`
into `PCMS_DB_PASSWORD`. The `db_password` and `pgpass` files are no longer read; `backup_recipient.txt` still is.

**Backup encryption key.** Make it on a custodian's computer, not on the server:

```sh
age-keygen -o pcms-backup-identity.txt     # keep this private file offline, with two custodians
age-keygen -y pcms-backup-identity.txt > backup_recipient.txt
```

Copy only `backup_recipient.txt` to `/srv/pcms/secrets/`.

## 4. Build (or load) the images

On the server, with internet:

```sh
export PCMS_ENV_FILE=/srv/pcms/pcms.env
docker compose -f compose.prod.yml --env-file /srv/pcms/pcms.env build
```

For an offline server: build on another machine, `docker save` the images, copy the tar and its
`sha256sum`, then run `docker load` (plan 26.2).

## 5. Start and create the admins

```sh
docker compose -f compose.prod.yml --env-file /srv/pcms/pcms.env up -d
docker compose -f compose.prod.yml ps                         # all healthy; migrate exited 0
docker compose -f compose.prod.yml exec api python -m app.cli create-admin-from-env
```

The command creates every admin listed as `PCMS_ADMIN_1_...`, `PCMS_ADMIN_2_...` and so on, and skips
accounts that already exist, so it is safe to run again after adding more. A password left empty is
generated and printed; a password from the file is never printed. Either way it is temporary. Each admin:
1. Opens the site and signs in with it.
2. Sets their own password.
3. Scans the authenticator QR code and saves the recovery codes.

Then clear the `PCMS_ADMIN_*` values from `pcms.env`. To add a single admin without the file, run
`python -m app.cli create-admin --email you@dbit.edu.in --name "Full Name"`.

Admins create everyone else under **Admin, then People**: one person at a time, or many with
**Import file** (Excel or CSV), for any role including other admins. The import response is a credentials workbook with the temporary passwords; share each
row with that person and delete the file afterwards. It can be downloaded again until the person sets
their own password.

`migrate` runs `check-config` first, so the stack will not start with unsafe settings.

## 6. Twilio (legacy) and web push

**Push**
```sh
docker compose -f compose.prod.yml exec api python -m app.cli vapid-keys
```
Put both values in `pcms.env`, set `PCMS_VAPID_SUBJECT=mailto:facilities@dbit.edu.in`, then `up -d`.
Use `python -m app.cli push-test-all` to send one test to every enabled device.

**Tunnel** (only Twilio's webhooks and photo links are public)

PCMS does not run a tunnel; you run your own. nginx publishes its public listener on
`127.0.0.1:PCMS_PUBLIC_PORT` (default 8081). That listener serves only the two Twilio webhook routes and
signed photo links; everything else returns 404.
1. On this server, point your tunnel at `http://127.0.0.1:8081`, for example
   `cloudflared tunnel --url http://127.0.0.1:8081` or `ngrok http 8081`, and give it a public https hostname.
2. Set `PCMS_PUBLIC_BASE_URL` to that https address (for example `https://pcms-hooks.dbit.edu.in`), then `up -d`.
3. If the tunnel runs on another machine, set `PCMS_PUBLIC_BIND` to this server's LAN address and let only
   that machine through the firewall.

Never point the tunnel at port 80 or 443. That would put the whole app on the internet.

**Twilio (legacy)**
Worker dispatch is retired. PCMS no longer queues new worker messages, so a new installation
does not need Twilio at all. Keep the existing Twilio settings, templates and webhook only until
the messages that were sent before the cutover have drained. Their status updates and Accept
taps still work through the handlers described in `docs/SECURITY.md`.

To keep the old messages working on an existing installation:
1. Keep the WhatsApp sender, the SMS number or Messaging Service, the `HX...` template SIDs, the
   account SID, the auth token and the senders in `pcms.env`.
2. Keep the WhatsApp sender's incoming-message webhook at
   `https://pcms-hooks.dbit.edu.in/webhooks/twilio`.
3. Keep `PCMS_MESSAGING_PROVIDER=twilio` until those messages are delivered or expired.

For a fresh installation, set `PCMS_MESSAGING_PROVIDER=none`. Managers contact workers directly
and record the state on the ticket; nothing else changes.

A later cleanup release can remove Twilio, the provider settings and the `worker`, `worker_skill`
and `assignment` tables after a backup.

## 7. Backups and the restore drill

The `backup` service runs nightly at `PCMS_BACKUP_AT` (Asia/Kolkata):
- It dumps the database, copies media and a manifest, and encrypts everything to `/srv/pcms/backups`.
- It keeps 7 daily and 4 weekly backups.
- `LAST_SUCCESS` records the time of the last good backup. Alert if it is older than 26 hours.
- Off-host copy: set `BACKUP_COPY_CMD` (for example an `rsync` to the backup store), or have IT pull the folder.
  A backup on the same server does not protect against losing the server.

**Restore**
```sh
docker compose -f compose.prod.yml stop api worker scheduler
docker compose -f compose.prod.yml run --rm -v /path/to/pcms-backup-identity.txt:/run/identity.txt:ro \
  backup restore.sh /backups/pcms-YYYYmmdd-HHMM-Day.tar.age /run/identity.txt
docker compose -f compose.prod.yml up -d
```

What the restore does:
- Verifies the checksums.
- Restores the database and media together.
- Cancels unsent notifications, so old messages are not replayed.
- Signs everyone out.
- Checks the ticket count against the manifest.

Do a drill monthly on a separate machine (plan 28). The same scripts were drilled on 18 October 2026:
the dev database and media were restored into a scratch database and volume, and the counts matched.

## Updating

1. Announce a window and check `LAST_SUCCESS` is recent.
2. Run a manual backup: `docker compose -f compose.prod.yml exec backup backup.sh`.
3. Deploy: `git pull` (or load the new images), then `docker compose -f compose.prod.yml --env-file /srv/pcms/pcms.env up -d --build`.
   `migrate` applies migrations before `api` starts.
4. Smoke test: sign in, open the queue, raise a test ticket.

Open browsers show "A new version is ready", so nobody loses a half-filled form.

**Rollback.** Start the previous images. If a migration already ran and is not backward compatible,
restore the backup from step 2. Reverting a container does not undo a migration.
