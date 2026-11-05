# AGENTS.md

Guidance for AI coding agents and new maintainers working on PCMS. Read this before changing code.

## What this is

PCMS is the campus maintenance system for Don Bosco Institute of Technology, Bengaluru. It is
maintained by the Open Source Student Club, DBIT. It is proprietary (see `LICENSE`).
Start with `docs/ARCHITECTURE.md` for the flow and `docs/SECURITY.md` for the rules that must not break.

| Part | Stack | Folder |
|---|---|---|
| API, jobs | Python 3.13, FastAPI, async SQLAlchemy 2, Alembic, PostgreSQL 17 | `backend/` |
| PWA | React 19, TypeScript, Vite, Tailwind 4, vite-plugin-pwa (injectManifest) | `frontend/` |
| Web server | nginx 1.30 | `nginx/` |
| Backups | pg_dump + age | `ops/backup/` |
| Browser test | Playwright | `e2e/` |

## The flow (confirmed by DBIT, 18 October 2026; updated 4 November 2026)

1. Anyone with an account submits a problem (type, part, "Other" needs a description, place, title, a red/orange/green severity, photos). The token is `<letter><yy>-<serial>`, for example `M26-0001`. Staff reporters, the principal included, follow exactly the same flow as faculty: the report waits for the facility manager.
2. The facility manager reviews it: **accept**, or **reject** with a reason. There is no manual priority (DBIT, 30 October 2026); the queue sorts and filters by the reporter's severity.
3. The facility manager **contacts a worker directly** (call, WhatsApp or in person), records an optional worker or vendor name, and marks the ticket Assigned. No message is sent by PCMS.
4. After the worker looks at it, the facility manager writes a note and, **only if needed**, ticks one of two small checkboxes under it (DBIT, 4 and 5 November 2026; there is no up-front I/C/P choice any more):
   - **Critical**: send it for a spending decision (reason, optional estimate). It goes to the **principal**, who approves, rejects, or escalates it to **institute management** for the final decision (approve, ask for clarification, defer or reject). If the **principal reported** the problem, it goes straight to institute management, because nobody decides spending on their own report.
   - **Postpone**: on hold with a reason and review date.
   - **Neither**: the work is Immediate. **Mark as complete** with an optional note and an optional **exact actual cost**. The server stores flag `I` (or keeps `C` for approved critical work).
   - **Once spending is approved**, the approval is final: the checkboxes are gone and only Mark as complete remains. The API refuses a new Critical request or a Postpone (`workflow.spending_approved`, 409 `spending_approved`). After a rejection, deferral or clarification a revised request is still allowed.
5. The reporter confirms the fix, or disputes it within 7 days. After the ticket is closed, the reporter may rate the repair once (1-5 stars and an optional comment).

Team OSSC can **remove** any ticket (with a reason). History stays; the ticket disappears from every list, report and export and returns 404.

Future scope (not built): letting workers record progress themselves.

## Run and test

Use PowerShell or bash on the host. Everything runs in Docker.

```sh
docker compose -f compose.dev.yml --profile jobs --profile nginx up -d --build
docker compose -f compose.dev.yml exec -T api pytest -q
cd frontend && npm run lint && npm run build
```

The browser test needs the stack running; see `.github/workflows/ci.yml`, job `e2e`. On your computer:

```powershell
docker compose -f compose.dev.yml exec -T api python -m app.cli create-smoke-accounts --password "Smoke-Test-Pass-91"
$nginx = docker compose -f compose.dev.yml ps -q nginx
docker run --rm --network "container:$nginx" -e SMOKE_PASSWORD=Smoke-Test-Pass-91 -v "${PWD}/e2e:/e2e" -w /e2e `
  mcr.microsoft.com/playwright:v1.64.1-noble sh -c "npm ci && npx playwright test smoke.spec.ts"
```

Name the spec file: `e2e/out/` may hold local scratch specs that are not part of the suite.
After changing the PWA, rebuild nginx (`up -d --build nginx`) or the browser test runs the old build.

Before you say something works, run the tests above. Add a regression test for every bug you fix.
The browser test writes accounts and tickets into whatever database the stack uses; on your computer that is the dev database.
Record every user-visible change in `CHANGELOG.md`. See `CONTRIBUTING.md` for branches, commits and review.

**Environments.** The server runs only `compose.prod.yml`: a push to `dev` deploys staging and a push to
`main` deploys production, after CI passes (`.github/workflows/deploy.yml`). `compose.dev.yml` is for a
developer's computer and CI's tests only. Never deploy by hand-editing containers on the server.

## Rules

- **Server decides.** Every permission check lives in the API (`app/security/deps.py`, `require(...)`). UI checks are cosmetic.
- **Same origin only.** `app/security/origin.py` refuses requests whose `Origin`, `Sec-Fetch-Site` or `Referer` is another site, and (in production) unknown `Host` headers. The API sends no CORS headers; never add CORS middleware. Exempt only health checks. Cookies are `SameSite=Strict`.
- **Validate at the edge.** Every string, list and integer in a request schema has a maximum (`Field(max_length=...)`, `le=MAX_INT` for versions). Emails go through `services/users.EMAIL_RE`, at sign-in too. Match frontend `maxLength` to the server limit.
- **Faculty see only their own tickets**, and never staff messages, staff documents, costs, worker names or staff names. Return 404, not 403, for objects a user may not see.
- **Messages are staff-only** (facility manager, management, principal, Team OSSC). Every staff role can also report a problem and add photos and documents.
- **Spending figures** (approved amounts, actual costs in reports, the expenditure report and its exports) are for `cost.principal` and `cost.approve` only, never the facility manager. The facility manager enters the actual cost when marking a ticket fixed and sees it on that ticket; faculty never see it.
- **No free-form status changes.** State changes go through `services/lifecycle.py` or `services/workflow.py` with `expected_version`.
- **Nobody approves their own spending** (`workflow.decide`): not the requester and not the reporter. `workflow.create_proposal` starts a principal-reported request at the `management` stage for this reason.
- **Removed tickets** (`ticket.deleted_at`, Team OSSC via `lifecycle.remove_ticket`, capability `admin.tickets`) must stay hidden: every ticket query filters `deleted_at IS NULL`. Report queries get it from `reporting.ticket_filters` and `reporting.raw_scope`; use them for any new query.
- **History is append-only** (triggers on `ticket_event`, `ticket_comment`, `decision`, `delivery_attempt`, `audit_event`). Every change writes `audit.record(...)`.
- **Notifications go through the outbox** (`services/notify.py`) in the same transaction. Web push is the only channel (no email, SMS or WhatsApp since 4 November 2026); `notify_user` queues a push only for people with a device subscribed. Never call a push service from a request handler (`/push/test` is the one exception). Shorten text with `notify.clip` (word boundary, `...`), never a bare slice. The app re-saves each device's subscription on every open (`frontend/src/lib/push.ts`, `startPushSync`).
- **Uploads** go through `services/media.py` (real type detection, re-encoding, quarantine). Never serve files from a public path.
  Photos and video are the reporter's (`purpose=evidence`); staff add `purpose=document` files. A facility
  manager's documents are seen only by that manager, the principal, management and Team OSSC (`tickets.document_visible`).
- **Translation** of typed text is for the facility manager only (`services/translate.py`, `tickets.wants_translations`).
  Only the worker calls the translators (MyMemory, then Google via `googletrans-curl`); never call them from a request handler.
  Never replace the original text.
- **Money** is integer paise. **Times** are stored in UTC and shown in Asia/Kolkata.
- **No secrets in git.** Settings come from `PCMS_*` environment variables (`app/config.py`). `check_production()` must keep blocking unsafe production settings.
- **No demo data** in seeds or migrations. Test data lives in `tests/` and the dev-only CLI commands (`create-test-accounts`, `create-smoke-accounts`), which refuse to run in production.
- **Migrations:** autogenerate with `alembic revision --autogenerate --rev-id 000N -m "..."`, then review. Give new NOT NULL columns a server default.
- **Dependencies** are pinned exactly (`uv.lock`, `package-lock.json`). Check upstream docs before using an API; do not guess config keys.
- **Writing style:** plain ASCII hyphens and quotes, no em or en dashes, in code, comments, docs and commits.
- **Git:** work on a branch and open a pull request explaining the root cause. Do not push to `main`.

## Where things are

| Need | Look in |
|---|---|
| Roles and capabilities | `backend/app/security/roles.py` and `frontend/src/lib/types.ts` (keep in sync) |
| Same-origin and Host checks | `backend/app/security/origin.py`, settings `PCMS_PUBLIC_APP_URL`, `PCMS_ALLOWED_ORIGINS`, `PCMS_ALLOWED_HOSTS` |
| Ticket rules | `backend/app/services/lifecycle.py`, `workflow.py`, `tickets.py` |
| Reports (dashboard, department rows, expenditure, actual cost) | `backend/app/routers/admin_ops.py`, `services/reporting.py`, `frontend/src/pages/staff/Reports.tsx` |
| People import (department, position, generated passwords) | `backend/app/services/users.py` (`parse_import`), `services/xlsx.py`, `routers/admin_users.py` |
| Push notifications | `backend/app/services/notify.py`, `outbox.py`, `webpush.py`, `frontend/src/lib/push.ts`, `frontend/src/sw.ts` |
| Places and types seeded | `backend/app/seed.py` (new rows) and a data migration (existing databases) |
| Translation | `backend/app/services/translate.py`, `routers/translate.py`, `frontend/src/lib/translate.ts` |
| API calls from the PWA | `frontend/src/lib/api.ts` |
| Shared UI components | `frontend/src/components/ui.tsx`, `ticket.tsx`, `ActionDialog.tsx`, `Brand.tsx`, `Filters.tsx`, `CameraCapture.tsx`, `LanguageButtons.tsx` |
| Pages | `frontend/src/pages/` (`faculty/`, `staff/`, `Landing`, `Login`, `Settings`) |
| Service worker (shell cache, push) | `frontend/src/sw.ts` |
| Deployment | `docs/DEPLOYMENT.md`, `compose.prod.yml`, `.env.example` |
| The OSSC server (ports, folders, the `pcms` helper, adding more apps) | `docs/SERVER.md` |
| Setting up an environment on the server | `ops/deploy/setup-environment.sh <staging\|production>` |
| Continuous deployment (dev to staging, main to production) | `.github/workflows/deploy.yml`, `ops/deploy/deploy.sh`, `rollback.sh`, `*.conf.example`; staging server notes in `docs/pcms-deployment-2026-11-02.md` |
| What changed and when | `CHANGELOG.md` |
| How to contribute | `CONTRIBUTING.md` |
