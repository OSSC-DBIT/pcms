# Security

## Decisions that differ from plan v1.2

DBIT asked for these on 18 October 2026. They are deliberate. Review them before the pilot.

| Plan v1.2 | PCMS now | Risk and mitigation |
|---|---|---|
| Second factor for all admin-portal roles | Authenticator (TOTP) only for the super admin (Team OSSC) | A stolen facility manager or management password is enough to sign in. Mitigations: 10-character minimum, sign-in throttling, sessions revoked on password change, campus-only access. Turning TOTP back on is a one-line change in `app/security/roles.py`. **If the app is published through the Cloudflare tunnel, campus-only access no longer holds**: put Cloudflare Access in front of that hostname, or turn TOTP back on for the manager and management roles. See "Publishing PCMS off campus" below. |
| OSSC administers but does not dispatch or approve | OSSC has every capability | Separation of duty still holds: nobody, OSSC included, can approve a cost they requested or a ticket they reported. All actions are audited. |
| Facility manager views the worker directory | Workers are contacted directly; PCMS keeps only an optional free-text worker or vendor name on the ticket | There is no worker login, phone number field or directory. The name is staff-only and never appears in faculty responses or public timeline entries. |
| Token `DB26C0123` | Token `C26-0123` | Tokens are references, not credentials; guessing one reveals nothing (404). |
| Worker messaging via Meta Cloud API, photos by media ID | Twilio is legacy only: no new worker messages are queued. Messages sent before the cutover keep working, including signed photo links that expire in 10 minutes and stop working once the job closes | The link is unguessable (HMAC) and serves only that photo. A later cleanup release removes Twilio and the legacy tables. |

## Controls

**Accounts**
- Named accounts only, signed in with a college email. Team OSSC creates them one at a time or by
  Excel/CSV import. There is no self-registration, email link, OTP or security question.
- Each new or reset account gets a temporary password: random (about 70 bits) or chosen by the admin.
  It is stored as an Argon2id hash for verification and, until the person replaces it, as
  AES-256-GCM ciphertext under `PCMS_CREDENTIAL_KEY`. The key is separate from `PCMS_SECRET_KEY`.
- A temporary password can be downloaded again by Team OSSC under **Admin, People, Credentials file**.
  That download needs the admin's own password, is throttled, is marked `no-store`, and is audited.
  Once the person chooses a password, the ciphertext and expiry are deleted; the chosen password is
  never stored reversibly.
- Temporary passwords expire after 7 days and must be changed at first sign-in.
- Forgotten passwords are reset by Team OSSC. No password is ever emailed.
- Suspending a person or changing their role or email ends all of their sessions.
- The last active super admin cannot be removed, and admins cannot change their own role.

**Sessions**
- Random opaque token in an HttpOnly, Secure (production), SameSite=Lax cookie. Only a hash is
  stored, and it expires after 12 hours.
- The CSRF token must be sent as the `X-CSRF-Token` header on every change.

**Sign-in**
- Throttled per email and per IP; the window expires on its own, so there is no permanent lockout.
- Unknown email and wrong password look the same. TOTP codes cannot be replayed. Recovery codes work once.

**Authorisation**
- Checked by the server on every request.
- Faculty only ever see their own tickets; anything else is 404.
- Faculty responses never include internal notes, costs, worker names or staff names in the timeline.
- Only the reporter can rate a ticket, only after it is `Closed`. Another faculty member gets 404
  through the normal visibility check; staff get 403 because they can see the ticket but cannot rate.
- A rating is a single immutable row per ticket, enforced by a unique constraint. The comment is
  visible only to the reporter and staff and is never copied into the timeline, push payloads or
  the audit snapshot (which records the stars and whether a comment exists).

**Uploads**
- The type is detected from the bytes, not the name or browser.
- Photos are decoded and re-encoded, which drops EXIF and GPS. Videos are probed and remuxed without metadata.
- Limits: 3 photos, 1 video of 20 MB and 30 s, 35 MB in total.
- Files are stored under random keys in a private volume, held in quarantine until ClamAV clears
  them (production), and downloaded only after a permission check with `nosniff` and a sandbox CSP.

**Twilio webhooks (legacy)**
- Every call must carry a valid `X-Twilio-Signature` computed over the public URL.
- Events are deduplicated. A button tap must come from the assigned worker's own number,
  replying to that job's message.
- These handlers remain only for messages sent before worker dispatch was retired. No new worker
  messages are queued.

**Web**
- Strict CSP with no inline script, HSTS, `X-Frame-Options: DENY`, `nosniff`, and a narrow `Permissions-Policy`.
- The service worker caches only the app shell, never API responses.
- Signing out clears drafts and removes this device's push subscription.

**Publishing PCMS off campus (Cloudflare tunnel)**
- The tunnel is optional and off unless the stack is started with `--profile tunnel`.
  `cloudflared` dials out, so no inbound port is opened on the college server.
- Two hostnames, two nginx listeners, neither published on the host:
  `:8082` is the whole app and API, `:8081` is the Twilio webhooks and signed photo links only.
- **The app hostname belongs behind Cloudflare Access** (college SSO, `@dbit.edu.in` policy).
  Without it the sign-in page faces the open internet while only the super admin has a second
  factor, which is the single largest change to the threat model in this document. The
  alternative is turning TOTP on for the manager and management roles.
  Access must **not** cover the webhooks hostname: Twilio cannot sign in, and that listener
  verifies request signatures and serves nothing else.
- Cloudflare terminates TLS and forwards plain HTTP on the tunnel hop, so nginx trusts
  `CF-Connecting-IP` on port 8082 only, and ignores it (along with any client-sent
  `X-Forwarded-For`) on the campus listeners, where the peer is the visitor. nginx overwrites
  `X-Forwarded-For` rather than appending to it, so the address sign-in throttling and rate
  limits count against cannot be forged by sending a header.
- Rate limits and sign-in throttling therefore apply per real visitor, not per tunnel.
  Without that, one person's failed sign-ins would lock out everyone arriving remotely.

**Data**
- History tables are append-only through database triggers, and every change writes an audit event.
  An UPDATE to history is refused unconditionally: no code path can rewrite the past.
- A DELETE is refused too, unless the transaction has set `pcms.retention = 'on'`. Only the
  nightly retention prune (`services/scheduler.py`) does that, and the setting is `SET LOCAL`, so
  it expires with the transaction. An application bug or a stray `psql` DELETE is still refused.
  The prune removes the audit trail past `PCMS_RETENTION_AUDIT_DAYS` (3 years by default), and the
  timeline and messages of tickets closed longer ago than `PCMS_RETENTION_TICKET_HISTORY_DAYS`.
  Tickets, tokens and ratings are never pruned, and an open ticket keeps its whole timeline no
  matter how old. Setting a window to 0 disables that prune. Deciding the real retention period
  is DBIT's call, not a technical default.
- CSV and Excel exports neutralise spreadsheet formulas by writing every cell as text, and are themselves audited.
  Imports reject formula cells and macro workbooks.

**Operations**
- The API refuses to start in production with a weak secret, insecure cookies, the dev database
  password, virus scanning off, or the test messaging provider.
- Swagger and ReDoc are disabled, and the OpenAPI JSON route is off in production.
- Containers run as non-root with read-only filesystems and no Linux capabilities. Only nginx publishes ports.
- Backups are encrypted to an age public key, so the server cannot read its own backups.

## Not verified yet

- Real Twilio sending and replies need DBIT's account and an approved WhatsApp template.
- Push and install on real Android and iPhone devices need HTTPS on the college hostname.
- Load at the plan's 50 active sessions has not been measured.
- A penetration test by someone other than the authors has not been done.
