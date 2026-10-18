# Security

## Decisions that differ from plan v1.2

DBIT asked for these on 18 October 2026. They are deliberate. Review them before the pilot.

| Plan v1.2 | PCMS now | Risk and mitigation |
|---|---|---|
| Second factor for all admin-portal roles | Authenticator (TOTP) only for the super admin (Team OSSC) | A stolen facility manager or management password is enough to sign in. Mitigations: 10-character minimum, sign-in throttling, sessions revoked on password change, campus-only access. Turning TOTP back on is a one-line change in `app/security/roles.py`. |
| OSSC administers but does not dispatch or approve | OSSC has every capability | Separation of duty still holds: nobody, OSSC included, can approve a cost they requested or a ticket they reported. All actions are audited. |
| Facility manager views the worker directory | Facility manager also adds, imports and edits worker contacts | Phone numbers stay masked in lists, and contact imports are audited per worker. |
| Token `DB26C0123` | Token `C26-0123` | Tokens are references, not credentials; guessing one reveals nothing (404). |
| Worker messaging via Meta Cloud API, photos by media ID | Twilio, photos via signed links that expire in 10 minutes and stop working once the job closes | The link is unguessable (HMAC) and serves only that photo. |

## Controls

**Accounts**
- Named accounts only. Team OSSC creates them one at a time or by CSV import.
- Each new or reset account gets a random temporary password (about 70 bits). It is shown or
  downloaded once and stored only as an Argon2id hash.
- Temporary passwords expire after 7 days and must be changed at first sign-in.
- Suspending a person or changing their role ends all of their sessions.
- The last active super admin cannot be removed, and admins cannot change their own role.

**Sessions**
- Random opaque token in an HttpOnly, Secure (production), SameSite=Lax cookie. Only a hash is
  stored, and it expires after 12 hours.
- The CSRF token must be sent as the `X-CSRF-Token` header on every change.

**Sign-in**
- Throttled per employee ID and per IP; the window expires on its own, so there is no permanent lockout.
- Unknown ID and wrong password look the same. TOTP codes cannot be replayed. Recovery codes work once.

**Authorisation**
- Checked by the server on every request.
- Faculty only ever see their own tickets; anything else is 404.
- Faculty responses never include internal notes, costs, worker phone numbers, or staff and worker names in the timeline.

**Uploads**
- The type is detected from the bytes, not the name or browser.
- Photos are decoded and re-encoded, which drops EXIF and GPS. Videos are probed and remuxed without metadata.
- Limits: 3 photos, 1 video of 20 MB and 30 s, 35 MB in total.
- Files are stored under random keys in a private volume, held in quarantine until ClamAV clears
  them (production), and downloaded only after a permission check with `nosniff` and a sandbox CSP.

**Twilio webhooks**
- Every call must carry a valid `X-Twilio-Signature` computed over the public URL.
- Events are deduplicated. A button tap must come from the assigned worker's own number,
  replying to that job's message.

**Web**
- Strict CSP with no inline script, HSTS, `X-Frame-Options: DENY`, `nosniff`, and a narrow `Permissions-Policy`.
- The service worker caches only the app shell, never API responses.
- Signing out clears drafts and removes this device's push subscription.

**Data**
- History tables are append-only through database triggers, and every change writes an audit event.
- CSV exports neutralise spreadsheet formulas and are themselves audited.

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
