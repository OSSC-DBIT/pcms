# Changelog

Every user-visible change to PCMS. Newest first. Dates are in Asia/Kolkata.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Pushes to `dev` deploy
staging and pushes to `main` deploy production, so releases are named by date.

Each entry says what changed for people, and **Action needed** lists anything an operator must do
when deploying it.

## Unreleased (5 November 2026): web push only, continuous deployment

### Removed
- **Email and Twilio (WhatsApp/SMS).** No email is sent and there is no worker messaging. The Twilio
  webhooks, the signed public photo links, nginx's public listener on port 8081, the Mailpit dev service,
  the "messages need you" card in the queue and its `/admin/notifications` endpoints are gone, along with
  the `twilio` and `aiosmtplib` packages. History tables are kept.

### Changed
- **Web push is the only notification channel.** The app saves each device's subscription on every open,
  when it returns to the foreground (at most hourly), and when the browser replaces the subscription
  (`pushsubscriptionchange`), so notifications keep working without anyone doing anything.
- Production refuses to start without `PCMS_VAPID_PUBLIC_KEY`, `PCMS_VAPID_PRIVATE_KEY` and a real
  `PCMS_VAPID_SUBJECT`.
- Reports: "Failed messages" is now "Undelivered notifications" (pushes that kept failing).
- Every main screen fits widths from 320 px to 2560 px: the page controls wrap, the queue tabs scroll
  inside their box and the monthly chart narrows on small phones. A browser test checks eight sizes.

### Added
- **Server setup in one command:** `ops/deploy/setup-environment.sh staging|production` prepares an environment
  (folders, settings file, push keys, backup key, certificate with the campus IP, CD config) and installs the
  `pcms` helper (`sudo pcms production status`, `logs`, `admin`, `backup`, `psql`, `rollback`). Production is
  `pcms-prod` at https://pcms.webuildnow.in. `docs/SERVER.md` is the runbook for the OSSC server, including how
  to host more apps there.
- **Continuous deployment.** `.github/workflows/deploy.yml`: a push to `dev` runs CI and deploys staging; a
  push to `main` deploys production. It runs `ops/deploy/deploy.sh` on a self-hosted runner on the server:
  build images tagged per environment and commit, back up, migrate while the old release keeps serving,
  start, health check. `ops/deploy/rollback.sh` returns to the previous release.

### Action needed
- Delete from `pcms.env`: `PCMS_SMTP_*`, `PCMS_MESSAGING_PROVIDER`, `PCMS_TWILIO_*`,
  `PCMS_FACILITIES_DESK_PHONE`, `PCMS_PUBLIC_BASE_URL`, `PCMS_PUBLIC_PORT`, `PCMS_PUBLIC_BIND`,
  `PCMS_ACCEPT_TIMEOUT_MINUTES` (they are ignored if left).
- Set `PCMS_VAPID_*` (`python -m app.cli vapid-keys`), absolute `PCMS_CERT_DIR`, `PCMS_SECRETS_DIR`,
  `PCMS_BACKUP_DIR`, and `sudo chown 70:70` the backup folder.
- Migration `0014` expires email and WhatsApp/SMS messages still queued.
- Remove any tunnel route to port 8081.
- Set up the runner and `/etc/pcms/staging.conf`, and create the `dev` branch: `docs/DEPLOYMENT.md` section 8
  and `docs/pcms-deployment-2026-11-02.md`.
- On the OSSC server each environment's files are in `/srv/server-data/<staging|production>/pcms/`
  (the setup script copies staging there). **Never run `docker compose up` by hand on the server**: without
  `-p`, a run from the old checkout replaced staging's containers with old code, the migration failed and
  staging went down (5 November). Use `sudo pcms <env> ...` and let GitHub deploy.

## Unreleased (DBIT changes of 4 November 2026)

### Changed
- **No up-front Immediate / Critical / Postpone choice.** The facility manager writes a note and presses
  **Critical** or **Postpone** only when the work cannot be finished now. With neither pressed, the work is
  Immediate and is marked complete directly. The server records the flag itself (`resolve` sets `I`
  unless the ticket is `C`; `resume` clears `P`).
- The closing note on **Mark as complete** is now optional.
- The type **Mechanical** is now **Mechanical / Electrical** (English, Hindi and Kannada).
- A ticket the **principal reports** follows the same flow as any other report. If it goes Critical,
  it goes straight to **institute management**, because the principal may not decide spending on their
  own report. Before this, such a request waited forever.
- A facility manager who reports a problem is no longer sent the "new report" alert for it.
- The queue's work-type (I/C/P) filter is gone; reporter, role, worker and date filters are under
  **More filters**.
- Department filter on Reports works without choosing a building first.
- Sign-in and session cookies are `SameSite=Strict` (were `Lax`).

### Added
- **Actual cost**: the facility manager can enter the exact amount spent (optional) when marking a ticket
  complete. It shows on the staff ticket, and for the principal, management and Team OSSC in Reports:
  the actual cost of repairs in the period, each request's actual cost beside its approved limit, and
  the CSV, Excel and PDF exports. Faculty never see it.
- **Reports by department**: a table of tickets per building and department (reported, open, fixed,
  update overdue) with a fixed/open bar.
- **Spending by department** (principal, management and Team OSSC), in the Expenditure section: bars per
  department for the actual cost, approved or requested amount, with shares of the total, and a table of
  requests, requested, approved, awaiting, repairs with a cost and actual cost. Also in the expenditure
  Excel (**By Department** sheet), the full Excel report (**Spending by Department**) and the PDF.
- **New places**: Library in Block B; Placement Department, Dean's Room, R&D Department, Board Room and
  Server Room in the Administrator Block.
- **Remove ticket** for Team OSSC (capability `admin.tickets`): hides a ticket from every list, report and
  export (404 for everyone) with a reason. History is append-only, so nothing is erased; the audit log
  records who removed it and why.
- **People import**: optional `department` and `position` columns, common HR headers (`Email ID`,
  `Full Name`, `Dept`, `Designation`), and a generated temporary password when the password cell is blank.
  The returned credentials workbook includes department and position. **Add person** also takes them.
- `CONTRIBUTING.md` and this changelog.

### Security
- **Same origin only.** The API refuses any request whose `Origin`, `Sec-Fetch-Site` or `Referer` is another
  site, and in production any unknown `Host`, with 403 `cross_origin` before routing. Health checks are exempt.
- Production refuses to start with a `PCMS_PUBLIC_APP_URL` that is not https or points at localhost.
- nginx now **replaces** `X-Forwarded-For` instead of appending to it, so a client cannot spoof the IP
  that the sign-in throttle uses.
- Stricter email check (no spaces or quotes, no leading, trailing or double dots, proper domain labels,
  6 to 254 characters). Sign-in refuses a malformed email with 400 before touching the database.
- Names are 2 to 120 characters in the admin API (the schema allowed 200); version numbers and the audit
  cursor are capped so oversized numbers are a 400, not a database error; import cells are capped at 512
  characters; frontend fields got `maxLength` matching the server.

### Fixed
- **Notifications cut off mid-word.** Push titles and bodies were sliced at 80 and 200 characters. They are
  now shortened at a word boundary with `...`, with more room (100 and 240).
- **A newer update on the same ticket replaced the earlier notification silently.** It now alerts again
  (`renotify`).
- **Pushes to a phone that was offline for more than an hour were lost.** The push lifetime is now 24 hours.
- **Turning notifications off did not stick**: the app re-subscribed on the next open. The choice is now
  remembered per device. "Not now" on the permission banner keeps it away for a week instead of one session.
- A push service answering 403 (keys rotated) left the dead subscription in place. It is now removed;
  when every device of a person is gone the notification expires instead of retrying.

### Action needed
- Run migrations (`migrate` does this): `0012` adds `ticket.actual_cost_paise`, the new places and the
  new type name; `0013` adds ticket removal columns and `app_user.department` / `position`.
- Check that `PCMS_PUBLIC_APP_URL` is the exact https address people open. If they also use another name
  or an IP address, set `PCMS_ALLOWED_ORIGINS` and `PCMS_ALLOWED_HOSTS` (see `docs/DEPLOYMENT.md`), or those
  requests are refused.
- Rebuild nginx (`up -d --build`) for the `X-Forwarded-For` change.
- API clients that sent `set_flag` before `resolve` keep working; it is no longer needed.

## 2026-11-02

Baseline for this changelog: the release deployed on 2 November 2026 (see
`docs/pcms-deployment-2026-11-02.md`). Earlier history is in the git log.
