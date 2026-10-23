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

## The flow (confirmed by DBIT, 18 October 2026)

1. Faculty submit a problem (type, part, "Other" needs a description, place, title, photos). The token is `<letter><yy>-<serial>`, for example `C26-0001`.
2. The facility manager reviews it: **accept** with a priority, or **reject** with a reason.
3. The facility manager **contacts a worker directly** (call, WhatsApp or in person), records an optional worker or vendor name, and marks the ticket Assigned. No message is sent by PCMS.
4. After the worker looks at it, the facility manager sets the flag:
   - **I Immediate**: fix it and mark it fixed.
   - **C Critical**: send it to institute management (reason, optional cost). Management approves, asks a question, defers or rejects.
   - **P Postpone**: on hold with a reason and review date.
5. The reporter confirms the fix, or disputes it within 7 days. After the ticket is closed, the reporter may rate the repair once (1-5 stars and an optional comment).

Future scope (not built): letting workers record progress themselves.

## Run and test

Use PowerShell or bash on the host. Everything runs in Docker.

```sh
docker compose -f compose.dev.yml --profile jobs --profile nginx up -d --build
docker compose -f compose.dev.yml exec -T api pytest -q
cd frontend && npm run lint && npm run build
```

The browser test needs the stack running; see `.github/workflows/ci.yml`, job `e2e`.

Before you say something works, run the tests above. Add a regression test for every bug you fix.

## Rules

- **Server decides.** Every permission check lives in the API (`app/security/deps.py`, `require(...)`). UI checks are cosmetic.
- **Faculty see only their own tickets**, and never internal notes, costs, worker names or staff names. Return 404, not 403, for objects a user may not see.
- **No free-form status changes.** State changes go through `services/lifecycle.py` or `services/workflow.py` with `expected_version`.
- **Nobody approves their own spending** (`workflow.decide`).
- **History is append-only** (triggers on `ticket_event`, `ticket_comment`, `decision`, `delivery_attempt`, `audit_event`). Every change writes `audit.record(...)`.
- **Notifications go through the outbox** (`services/notify.py`) in the same transaction. Never call Twilio, SMTP or push from a request handler.
- **Uploads** go through `services/media.py` (real type detection, re-encoding, quarantine). Never serve files from a public path.
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
| Ticket rules | `backend/app/services/lifecycle.py`, `workflow.py`, `tickets.py` |
| API calls from the PWA | `frontend/src/lib/api.ts` |
| Shared UI components | `frontend/src/components/ui.tsx`, `ticket.tsx`, `ActionDialog.tsx`, `Brand.tsx` |
| Pages | `frontend/src/pages/` (`faculty/`, `staff/`, `Landing`, `Login`, `Settings`) |
| Service worker (shell cache, push) | `frontend/src/sw.ts` |
| Deployment | `docs/DEPLOYMENT.md`, `compose.prod.yml`, `.env.example` |
