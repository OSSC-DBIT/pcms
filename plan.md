# PCMS enhancement plan

Written 19 October 2026 against `main`. This file answers three questions:

1. What is **half built** and needs finishing.
2. What is **broken** and needs fixing.
3. What **new features** are worth adding, and in what order.

Priority keys: **P0** ship before the pilot, **P1** first month after, **P2** next quarter,
**P3** nice to have. Sizes are rough engineering days for one developer who already knows
the codebase.

Every item cites the file and line it came from, so it can be checked before it is trusted.

---

## Part 1: Half-built features (backend ready, UI missing)

These are the cheapest wins in the whole plan. The server already does the work; only the
PWA side is missing.

### 1.1 Reports and dashboard - P0, size L (3-4 days)

`GET /api/v1/reports` (`backend/app/routers/admin_ops.py:72`) returns a complete analytics
payload:

- open tickets by status and by priority
- untriaged count, unaccepted count, updates overdue
- pending approvals, holds by reason, open disputes
- failed notifications
- **repeat faults** (top 10 location + category pairs)
- triage and resolution **p50 and p90** times
- approved spend in paise

The API filters accept `building=` and `category=` (`admin_ops.py:79-87`). No page in
`frontend/src/pages/` calls it. The facility manager is flying blind with no numbers at all.

To do:

- new `frontend/src/pages/staff/Reports.tsx`, gated on `queue.view`
- add `api.report()` to `frontend/src/lib/api.ts`
- building and category selectors reusing `GET /catalogs`
- tiles for the scalar counts, a simple CSS bar chart (no chart library needed) for the
  status and priority splits, a table for repeat faults
- link it from the sidebar in `components/AppShell.tsx:14-28`
- extend `backend/tests/test_reports.py` - it currently exercises only `untriaged`,
  `openByPriority` and `repeatFaults`

### 1.2 CSV export - P0, size S (half a day)

`GET /api/v1/reports/tickets.csv` (`admin_ops.py:119`) exists, is CSV-injection safe via
`services/csvsafe.py`, is audited, and sends `Cache-Control: no-store`. There is no export
button anywhere in the UI. Add one to `Reports.tsx` and a test that the response is
formula-neutralised.

### 1.3 Audit log viewer - P1, size M (2 days)

`GET /api/v1/admin/audit` (`admin_ops.py:156`) supports filtering by action prefix, entity
id and a `beforeId` cursor, up to 500 rows. The `admin.audit` capability exists in
`backend/app/security/roles.py:23` and `frontend/src/lib/types.ts:16` and is **never
checked in the frontend**.

This matters because `AGENTS.md:57` says history is append-only and every change writes an
audit record, but today nobody can read the audit trail without `psql`.

To do: new `frontend/src/pages/staff/Audit.tsx`, infinite-scroll cursor pagination using the
existing `beforeId`, a text filter on action and entity id, and a capability guard of
`admin.audit` instead of the current `anyCap={['admin.users','admin.catalogs']}` on
`App.tsx:110`.

### 1.4 Assessment recording - P1, size M (2 days)

`POST /tickets/{id}/assessments` (`routers/tickets.py:153`) and the client wrapper
`api.recordAssessment()` (`lib/api.ts:161`) both exist. **The client function has zero call
sites.** The `Assessment` type (`lib/types.ts:37`, values `simple`, `workforce`, `parts`,
`expenditure`) is read into `TicketSummary.assessments` but nothing ever writes it.

So a manager cannot tell whether a job needs one person, three people, or parts money. Add
an assessment panel to `pages/staff/StaffTicket.tsx` between the assignment step and the
flag step, and a test in `tests/test_workflow.py`.

### 1.5 Edit and retire catalogs - P1, size S (1 day)

Only the create paths are wired:

| Endpoint | Backend | Wired in UI |
|---|---|---|
| `PATCH /admin/categories/{code}` | `admin_ops.py:266` | no |
| `PATCH /admin/buildings/{code}` | `admin_ops.py:304` | no |

`Admin.tsx:230` and `Admin.tsx:263` only call `POST`. Renaming a building or retiring a type
is impossible today. Retirement needs care: old tickets keep their token letter, so a
category must be **deactivated, never deleted** (`docs/ARCHITECTURE.md:82`).

### 1.6 Edit a worker - P1, size S (half a day)

`api.updateWorker()` (`lib/api.ts:180`) accepts name, phone, trades, area, language, mode,
kind and active. `pages/staff/Workers.tsx:85` only ever sends `{ active }`. Add an edit
dialog reusing the `AddWorker` form at `Workers.tsx:113`.

### 1.7 Pagination - P0, size M (2 days)

This is a correctness bug dressed as a missing feature.

`GET /tickets` accepts `page` and `pageSize` and returns `{items, total, page, pageSize}`.
`lib/api.ts:89` hardcodes `pageSize: params.pageSize ?? 100`. `lib/useTickets.ts:14` never
passes either parameter, and `useTickets.ts:30` **throws `page.total` away**. The backend
caps at 200 (`routers/tickets.py:26`).

Result: a faculty member with 150 tickets sees only the newest 100 and gets no indication
that anything is missing. There is no "showing 100 of 150" text anywhere.

Same problem on the people list: `api.listUsers()` hardcodes `page_size: 50`
(`lib/api.ts:189`) and `Admin.tsx:62` never sends `page`.

To do: keep `total` in the hook return, add a pager component to
`pages/faculty/Tickets.tsx`, `pages/staff/Queue.tsx`, `pages/staff/Approvals.tsx` and
`pages/staff/Admin.tsx`.

### 1.8 Search and filter on the queue - P1, size L (3 days)

`Queue.tsx:49-58` has priority and building filters, but both run **client-side** on an
already-fetched 100-row array. Missing entirely:

- free text search on title and token
- category filter
- I / C / P flag filter
- assigned worker filter
- date range
- sort (the backend hardcodes `created_at desc`, `routers/tickets.py:44`; there is no `sort`
  or `order` parameter on any endpoint)

Move filtering server-side, add query parameters, add indexes. See Part 6 for the migration.

---

## Part 2: Bugs and dead code

### 2.1 P0 - `throttle.clear()` never clears the IP counter - real bug

`backend/app/services/throttle.py:39-40`:

```python
async def clear(db: AsyncSession, employee_id: str) -> None:
    await db.execute(delete(ThrottleEvent).where(ThrottleEvent.key == f"emp:{employee_id}"))
```

`_keys()` at line 20 returns **two** keys: `emp:<id>` and `ip:<address>`. A successful
sign-in clears only the first.

On a campus the whole building is behind one NAT address, so the `ip:` key is shared by
everyone. It is capped at `signin_max_attempts * 4` (default 20) per 300 second window.
Twenty wrong password attempts anywhere on campus lock out **every user** at that address
for five minutes, and no successful sign-in clears it. Students mistyping a temp password
can take the whole building offline from the sign-in screen.

Fix: change the signature to `clear(db, employee_id, ip)` and delete both keys. Add a
regression test in a new `backend/tests/test_throttle.py`.

### 2.2 P0 - `check_production()` does not check the webhook signature flag - real gap

`config.py:81-98` blocks weak secrets, insecure cookies, a dev DB password, ClamAV off and
the fake provider. It does **not** check `twilio_validate_signature`. That flag exists
(`config.py:72`) and when false it disables `X-Twilio-Signature` checking entirely in
`routers/webhooks.py:43-44`.

A production deployment with one typo in a compose file would accept forged Twilio webhooks,
meaning anyone on the internet could mark a worker's job accepted. Add the check, and add
tests for `check_production()` itself - it currently has **zero** tests.

Also worth blocking in prod: `public_base_url` / `public_app_url` still on `http://`, a
half-set VAPID key pair, and `smtp_starttls` off against a non-local host.

### 2.3 P1 - No rule for reopening a duplicate

The transition table in `services/lifecycle.py:36-51` has 14 actions but no path out of
`Duplicate`. If a duplicate is marked in error the ticket is stuck. Add a `reopen` rule from
`Duplicate` and a test.

### 2.4 P1 - `close_unverified` has no scheduler job

`lifecycle.py:50` defines the action and `auto_close_days` exists (`config.py:79`), but
nothing in `app/jobs/scheduler.py` runs it. `verification_reminders()`
(`services/scheduler.py:55`) nudges once per resolution. Nothing ever closes the ticket.
Add a scheduler task, following the pattern at `services/scheduler.py:70`.

### 2.5 P1 - `hold_reviews()` notifies but never escalates

`services/scheduler.py:70` sends a notification when a hold passes its review date and then
leaves the ticket `OnHold` forever. Either resume it, or notify the manager that it is now
blocked and needs a decision. Right now it is silent drift.

### 2.6 P1 - Twilio webhook returns an empty TwiML body

`routers/webhooks.py:30`:

```python
EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
```

Every unmatched inbound SMS is a silent no-op that only writes a log line
(`webhooks.py:128-132`). The `help` intent (`webhooks.py:145-149`) writes a timeline event
and a manager notification, then tells the worker **nothing at all**. A worker who replies
"help" gets silence and probably calls the desk anyway.

At minimum reply with the desk phone number (`config.py:73` already exists for this).
Better: implement the documented future scope (Part 3.1).

### 2.7 P1 - WhatsApp dispatch is non-functional out of the box

Two compounding defaults: `messaging_provider` is `none` (`config.py:64`) and
`PCMS_TWILIO_JOB_CONTENT_SID` is `None`, in which case `providers.py:93-94` raises
`ValueError("No WhatsApp content template configured for job dispatch")` at send time.
That is a late, ugly failure. Fail fast at startup instead, with a message naming the
missing variable. `docs/DEPLOYMENT.md:119` does say to keep `none` until Twilio is approved,
so this is a diagnostics problem, not a config problem.

### 2.8 P2 - Dead code to remove or wire up

| Item | Location | State |
|---|---|---|
| `require_any()` | `security/deps.py:97` | defined, **never called** anywhere |
| `notify_user(email=...)` | `services/notify.py:36` | parameter never passed by any caller |
| `Worker.alt_phone_e164` | `models/worker.py:31` | column never written, never read, not in any schema |
| `Assignment.started_at` | `models/worker.py:76` | serialised in `services/tickets.py:253` and `schemas/ticket.py:75` but **never written**, so the API field is permanently `null` |
| `Outbox.state = "cancelled"` | `models/outbox.py:18` | allowed by the constraint, only ever set by `ops/backup/restore.sh`, never by the app |
| `Assignment.delivery = "unknown"` | `models/worker.py:16` | never assigned |
| `PCMS_COLLEGE_CODE` | `config.py:18` | never read; the token letter comes from `Category.letter` |
| `framer-motion` | `frontend/package.json:16` | declared dependency, zero imports |
| `labelStatus()` | `lib/api.ts:258` | superseded by `t('status.' + s)` at `components/ui.tsx:229` |
| disabled test | `tests/test_workflow.py:97` | `await _tr(mgr, tid, action="resume") if False else None` - the `resume` transition is untested by accident |

The `Assignment.started_at` one is worth deciding carefully. Either write it when the worker
accepts (`workflow.accept()`, `workflow.py:196`, which currently sets only `accepted_at`) or
drop the column. Shipping a permanently null field in the API is worse than not having it.

### 2.9 P2 - Hardcoded values that should be settings

| Value | Location |
|---|---|
| `MAX_PHOTOS=3`, `MAX_VIDEOS=1`, `MAX_TOTAL=35MB`, pixel ceiling | `services/media.py:33-39` |
| `BACKOFF_MINUTES = (1, 5, 15, 60)` | `services/outbox.py:32` |
| worker poll 2s, scheduler tick 10s, all six task intervals | `jobs/worker.py:31`, `jobs/scheduler.py:12-19` |
| `MAX_SUBSCRIPTIONS_PER_USER = 10` | `routers/push.py:27` |
| `IP_MULTIPLIER = 4` | `services/throttle.py:17` |
| outbox claim batch `limit=20` | `services/outbox.py:49,171` |
| worker CSV import cap 200 | `routers/directory.py:58` |
| gallery upload cap 4, which disagrees with the form's 3+1 | `components/ticket.tsx:154` |

All of these should be `PCMS_*` settings in `app/config.py`. Two of them (the media limits and
the gallery cap) are inconsistent with each other today.

---

## Part 3: New features

### 3.1 Worker captures their own reason - P1, size XL (5-8 days)

The one item `AGENTS.md:30` and `docs/ARCHITECTURE.md:141` both name as future scope:
workers recording why something is Critical or Postpone, by SMS reply or voice.

The parser at `routers/webhooks.py:99-107` currently understands exactly three intents:
`accept`, `done`, `help`. Extending it to `critical <reason>` and `postpone <reason>` is
maybe 40 lines and closes the documented gap. It has to stay safe: the number must be the
assigned worker's own number (`docs/SECURITY.md:46-65` says button taps are only accepted
from the assigned worker), the state change must go through `services/lifecycle.py` with
`expected_version`, and it must be written to the outbox in the same transaction.

A printed job card with a QR code to a token-locked web form is a good fallback for workers
without data. This is the single highest-value feature in the plan, because it is the one
DBIT explicitly asked about and because it removes the phone-call bottleneck.

### 3.2 Offline submission - P1, size L (3-4 days)

`frontend/src/sw.ts` has no `sync` or `periodicsync` listener. `pages/faculty/Report.tsx`
catches the offline error at line 137 and preserves only a **text** draft in
`localStorage`. Photos are not kept at all, which the UI admits: *"The text is saved on this
device; photos are not."* (`Report.tsx:288`).

Faculty in a basement lab or a block with bad WiFi cannot report anything. Add:

- IndexedDB queue for the draft **including** blobs
- a `sync` listener in `sw.ts` for ticket create plus attachment upload
- clear the queue and show "sent" once the network returns
- respect `AGENTS.md:56`: never cache API responses or media, only the user's own unsent work

Also fix the single-draft slot while you are there: `Report.tsx:25-27` reads `d[0]`, so a
second draft overwrites the first.

### 3.3 SLA clock that understands service hours - P2, size M (2 days)

`services/tickets.py:40-41` is honest about the limitation:

```python
# Gross next-update targets (plan 9.1). Service hours and holidays are a later refinement.
NEXT_UPDATE = {"P1": timedelta(minutes=30), ...}
```

A P1 reported at 8pm Friday starts a 30 minute clock at 8pm. Add a business calendar table
(service hours per day, holiday list) and make "update overdue" mean working time, not wall
time. This changes what the Queue tile at `Queue.tsx:45` is telling managers, so do it
carefully and keep the old number available behind a query flag.

### 3.4 Suggested worker by trade and workload - P2, size M (2 days)

`workers_out()` already computes `workload` (`services/workflow.py:63-66`) and the
assignment dialog already filters by trade (`StaffTicket.tsx:152-158`). Nothing ranks.
Suggest the least-loaded active worker who has the trade, as a one-tap default. Cheap, and
it removes a judgement call from a busy manager.

### 3.5 Print job card - P2, size S (1 day)

Small standalone page at `/staff/card/:ticketId` printing token, place, title, reporter
contact preference, a large QR code to the public media link, and the I/C/P options as tick
boxes. `ops/backup` already generates nothing of the sort, but `docs/USER-GUIDE.md` tells
managers to dispatch by job card, so the software should be able to produce one.

### 3.6 Full staff localisation - P2, size L (3 days)

`Worker.language` already models `kn|hi|ta|te|en` (`Workers.tsx:14`). The app ships only
English and Hindi, and Hindi covers roughly 90 of about 150 keys. **All five staff screens are
hardcoded English** - Queue, StaffTicket, Workers, Admin, Approvals. Complete the Hindi set,
then add Kannada, Tamil and Telugu for the SMS templates and the job card.

### 3.7 Notification preferences and quiet hours - P2, size M (2 days)

Every user gets every notification. There is no per-event preference, no quiet hours, and no
digest. `pages/Settings.tsx` has only a single on/off push toggle. Add a preference model,
respect it in `services/notify.py` (the intents are already separate rows in the outbox, so
this is mostly a filter), and add an optional daily digest job.

### 3.8 Preventive maintenance - P3, size XL

The system is purely reactive: report, fix, close. Add a `maintenance_plan` table (asset or
building + category, interval, last done, next due), auto-generate tickets on a schedule, and
a preventive/complaint flag on the ticket type so reports and planned work can be separated in
reporting. This is a real shift in the product and needs DBIT sign-off, which is why it is
P3.

### 3.9 Asset and vendor register - P3, size XL

Same shape as above. An `asset` table (what it is, where, warranty, vendor, AMC contract) and
a `vendor` table, so repeat faults on one asset become visible and AMC renewal dates can be
warned about. Depends on 3.8.

### 3.10 Analytics deepening - P3, size L

The existing report already gives repeat faults by location + category and p50/p90 times. Add
spend per category and per vendor, a month-on-month trend, and a building heatmap. Mostly
query work once 3.8 exists.

---

## Part 4: Security hardening

`docs/SECURITY.md:67-72` has an honest "Not verified yet" list. These are its four items plus
what the code review turned up.

| # | Item | Priority | Size |
|---|---|---|---|
| 4.1 | Fix the throttle IP bug (2.1) and add tests | P0 | S |
| 4.2 | Add `twilio_validate_signature` and URL scheme checks to `check_production()` (2.2), and test `check_production()` itself | P0 | S |
| 4.3 | **Negative e2e tests.** `AGENTS.md:49` makes faculty isolation the central privacy rule. No browser test asserts that faculty A cannot open faculty B's ticket, or that staff names, costs and worker phone numbers never leak into a faculty response. This is the highest risk item in the document and it is completely unverified outside unit tests. | P0 | M |
| 4.4 | Management-role e2e test. Approve / Ask a question / Defer / Reject and the ceiling check are untested in a browser. | P1 | M |
| 4.5 | Extend TOTP beyond super admin. `roles.py:16` is `frozenset({"ossc"})`. `SECURITY.md:9` admits *"A stolen facility manager or management password is enough to sign in."* It is a one-line change and management accounts are the ones with spending authority. | P1 | S + recovery code UX |
| 4.6 | Second factor for `admin.users` role changes specifically, even if MFA stays narrow. | P2 | M |
| 4.7 | Dependabot or Renovate, plus `pip-audit` / `npm audit` in CI. Neither exists today. | P1 | S |
| 4.8 | Secret scanning in CI (gitleaks). | P1 | S |
| 4.9 | SAST and container image scanning in CI. | P2 | M |
| 4.10 | `alembic check` in CI, to catch model/migration drift. | P1 | S |
| 4.11 | Rate-limit the file download path separately from the general API zone. | P2 | S |
| 4.12 | Actually build and boot `compose.prod.yml` in CI, not just `config --quiet`. | P2 | M |

### Untested backend surface

There is no coverage tooling at all: `backend/pyproject.toml` has only `pytest` and
`pytest-asyncio`, no `pytest-cov`, no `fail_under`. Add both, then close these gaps:

- transitions with **no** test: `set_priority`, `recategorise`, `resume` (explicitly disabled,
  `test_workflow.py:97`), `reopen`, `duplicate`, `cancel`, `close_unverified`
- scheduler functions with no test: `hold_reviews`, `housekeeping`, both job main loops
- endpoints with no test: `POST /push/test`, `GET /admin/notifications` and its retry and
  dismiss actions, `GET /admin/users/import/template`, `GET /health/live`
- untested branches: the webhook signature-disabled path, the `help` intent, the `.MOV`
  rejection at `services/media.py:157`, the webpush 404/410 `gone` classification, CSV import
  error truncation past 50 rows (`services/users.py:215`)
- untested report fields: `openByStatus`, `unaccepted`, `overdueUpdates`, `pendingApprovals`,
  `holdsByReason`, `disputes`, `failedNotifications`, `triageTime`, `resolutionTime`,
  `approvedPaise`, and both query filters
- every CLI command except the `create-test-accounts` prod refusal: `seed`, `create-admin`,
  `reset-password`, `vapid-keys`, `check-config`, `export-openapi`, `push-test-all`,
  `create-smoke-accounts`

### Frontend tests

There are **no** frontend unit tests - no vitest, no jest, no test step in CI
(`.github/workflows/ci.yml:46-61` runs only `lint` and `build`). Add vitest plus
`@testing-library/react` and cover `lib/http.ts` error mapping, `lib/i18n.tsx` missing-key
fallback, `formatPaise` / `parseRupees` round-tripping (`lib/api.ts:246-256`), and the
stale-version 409 reload path.

### Browser tests

`e2e/smoke.spec.ts` has three tests. One full flow (report to critical), one landing page,
one manifest. Missing: reporter confirm and dispute, Immediate and Postpone branches, reject,
duplicate, reopen, TOTP enrolment, CSV import, workers import, the offline banner, the update
prompt, CSV export, and the audit viewer. Also `retries: 0` and `workers: 1`
(`e2e/playwright.config.ts:6-7`), so any flake fails CI with no retry.

---

## Part 5: Observability

This is the largest systemic gap. Everything else in the project is production grade; this is
not. Grep for `sentry|prometheus|opentelemetry|metrics|grafana` across `backend/` returns
zero hits, and there is no `ErrorBoundary` anywhere in `frontend/src`.

| # | Item | Priority | Size |
|---|---|---|---|
| 5.1 | Backup failure alerting. `ops/backup/backup.sh:52` writes a `LAST_SUCCESS` file and `docs/DEPLOYMENT.md:129` says alert if it is older than 26 hours. **Nothing reads that file.** Send an email or SMS from the backup container on failure, and a health endpoint that exposes backup age. | P0 | S |
| 5.2 | A `/metrics` endpoint on the API: request rate, latency, error rate, DB pool saturation, outbox queue depth and oldest pending item age. A plain Prometheus text format is enough. | P1 | M |
| 5.3 | Client-side error boundary and `window.onerror` / `unhandledrejection` reporting. Today a render throw blanks the app silently. | P1 | S |
| 5.4 | Structured JSON logging instead of the fixed `logging.basicConfig` format (`main.py:11`), so logs can be shipped without a regex. Include the `request_id` from `RequestIdMiddleware` (`errors.py:83`) in every line. | P1 | M |
| 5.5 | Up-to-date external uptime check against `/api/v1/health/ready`. Docker healthchecks only detect a dead container, not a broken dependency. | P2 | S |
| 5.6 | Log shipping (Loki, or just journald with a retention policy). `json-file` with `20m x 5` rotates, which means history is short. | P2 | M |
| 5.7 | An email or SMS digest of outbox items stuck in `action_required` for more than 24 hours. Right on time, the only signal is a manager opening the Queue screen. | P2 | S |
| 5.8 | Track the p50/p90 numbers `SECURITY.md:71` admits were never measured, for 50 active sessions. Add a load test to CI at least once. | P2 | M |

---

## Part 6: Performance and scale

Realistically fine for one campus, and cheap to keep that way.

- **Indexes** on whatever `sort` and filter columns get added in 1.8: `ticket(status)`,
  `ticket(building_id)`, `ticket(category_id)`, `ticket(created_at desc)`, and a
  `pg_trgm` GIN index on `title` for the text search. Alembic autogenerate, then review, as
  `AGENTS.md:64` requires.
- **Pagination everywhere** - see 1.7. This is the single most likely cause of a slow screen
  once the ticket table grows past a few thousand rows.
- **`Queue.tsx` client-side filtering** moves server-side in 1.8; right now the browser is
  re-filtering a 100-row array on every keystroke with no benefit.
- **`Home.tsx:24`** renders `others.slice(0, 6)` with no "see all" affordance. Cosmetic, but
  easy.
- Consider `Lookups` batching is already done in `services/tickets.py` for the serialiser, so
  there is no N+1 there. Leave it alone.

---

## Part 7: UX and accessibility

- **Error boundary and a real 404 page.** `App.tsx:114` redirects unknown routes to home
  silently, so a stale bookmark or a bad link looks like the app just ignored you.
- **Route-level error handling** on every page.
- **WCAG pass**: focus trapping in `ActionDialog`, `aria-live` on the update-overdue tile so
  screen readers hear the count change, keyboard navigation on the queue tabs, and colour
  contrast on the priority chips in both themes.
- **Reduced motion toggle** in Settings, alongside the existing theme toggle
  (`Settings.tsx:26-35`).
- **Self-service MFA management** in Settings. Today the only option is "ask an admin to reset
  it" (`Settings.tsx`), which means a locked-out super admin needs a console.
- **Account data export** and deletion request, at least a documented manual process.
- **Queue as a board** (New / In progress / Waiting) instead of a list, if managers say the
  list is hard to scan. Cheap to add, but ask first.
- **`iOS push needs the app installed** and there is no route to the install instructions
  from Settings. `InstallCard` is already a component - link it from the notification section.

---

## Part 8: Suggested order

**Phase 0 - before the pilot (about 2 weeks)**

1. Fix the throttle IP bug (4.1) with a regression test.
2. Harden and test `check_production()` (4.2).
3. Negative e2e tests for faculty isolation (4.3).
4. Pagination (1.7) so nobody silently loses tickets past 100.
5. Backup failure alerting (5.1).
6. `.MOV` message: either support it or make the error message less alarming
   (`services/media.py:157`).
7. Enable `pytest-cov`, close the untested transition and endpoint list in Part 4.

**Phase 1 - first month after the pilot**

8. Reports and dashboard page (1.1) and CSV export (1.2).
9. Queue search and server-side filters (1.8) with the supporting migration.
10. Audit log viewer (1.3).
11. Assessment UI (1.4) and worker edit (1.6) and catalog edit (1.5).
12. Error boundary (5.3) and a 404 page (Part 7).
13. Dependabot, secret scanning, `alembic check` in CI (4.7, 4.8, 4.10).
14. Extend TOTP to management accounts (4.5).

**Phase 2 - the rest of the quarter**

15. Worker self-service reasons over SMS (3.1) and the printed job card (3.5).
16. Offline submission with background sync (3.2).
17. Metrics endpoint (5.2) and structured logging (5.4).
18. Suggested worker by trade and workload (3.4).
19. Service-hour-aware SLA clock (3.3).
20. Full staff localisation (3.6).
21. Notification preferences and quiet hours (3.7).
22. Frontend unit tests and the rest of the e2e matrix (Part 4).

**Phase 3 - needs DBIT sign-off first**

23. Preventive maintenance (3.8).
24. Asset and vendor register (3.9).
25. Deepened analytics (3.10).
26. An independent penetration test. `SECURITY.md:72` records that nobody outside the authors
    has done this. For a system holding staff names, phone numbers and campus spending, it is
    worth doing before the system carries anything that matters.

---

## Part 9: Things to decide before writing code

These need an answer from DBIT or the club, not a developer guess.

1. **How many real users, really?** `SECURITY.md:71` says 50 active sessions was never
   measured. Everything in Part 6 sizes off that number.
2. **Is the campus behind one NAT?** If yes, the per-IP throttle at `services/throttle.py:22`
   needs rethinking even after the 2.1 fix, because a shared address makes IP-based limiting
   meaningless and an attacker could lock out a building.
3. **Should faculty see other faculty's tickets in their building?** Today the answer is a
   hard no (`AGENTS.md:49`). It is the right default, but if DBIT expects a shared board this
   is a design conversation, not a bug.
4. **Will workers really reply by SMS?** Part 3.1 assumes they will. If most workers will
   never send a message, the printed job card (3.5) is the higher-value half and should come
   first.
5. **Who reads the audit log, and how often?** If it is only OSSC, a searchable page is
   enough. If DBIT needs it, add retention and export policy.
6. **Preventive maintenance: is it the same system?** If yes, do it. If the college already
   has an AMC vendor system, integrate or leave it alone.
