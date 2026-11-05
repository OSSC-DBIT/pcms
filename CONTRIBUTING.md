# Contributing to PCMS

PCMS is maintained by the Open Source Student Club, DBIT, for Don Bosco Institute of Technology,
Bengaluru. It is proprietary (see `LICENSE`): contributions come from club members and people DBIT
invites. By contributing you agree that your work is covered by that licence.
Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Read [AGENTS.md](AGENTS.md) first. It holds the rules that must not break (server-side permissions,
append-only history, spending visibility, same-origin requests, the outbox) and where things are.
The same rules apply to people and to AI coding agents.

## Before you start

- Open or pick an issue that says what DBIT asked for, or what is broken and how to see it.
- Changes to the ticket flow, roles or who sees what need a confirmation from DBIT. Record the date in
  the code comment and in `CHANGELOG.md`, as the existing `DBIT, 2026-11-04` notes do.
- Ask before adding a dependency. Pin it exactly (`uv.lock`, `package-lock.json`) and check its upstream docs.

## Set up

Docker Desktop is the only requirement. From the repository folder (PowerShell or bash):

```sh
docker compose -f compose.dev.yml --profile jobs --profile nginx up -d --build
docker compose -f compose.dev.yml exec api python -m app.cli create-test-accounts
```

See [README.md](README.md) for the addresses and test accounts.

## Make the change

- Work on a branch named for the change, for example `feat/actual-cost` or `fix/push-truncation`,
  started from `dev`. Never push to `dev` or `main` directly: both deploy (`dev` to staging, `main` to
  production). Open the pull request into `dev`; when staging looks right, a pull request from `dev` to
  `main` releases it.
- Keep the change to what was asked. Suggest refactors separately.
- Follow the existing style: type hints and `ruff` conventions in Python, TypeScript strict mode and
  the shared components in `frontend/src/components/` in the PWA.
- Every permission check goes in the API. A hidden button is not a permission check.
- Every request field gets a maximum length or value; frontend `maxLength` matches it.
- New screen text goes into all three locale files (`frontend/src/lib/locales/en.ts`, `hi.ts`, `kn.ts`).
  The type check fails if a key is missing.
- Roles and capabilities change in `backend/app/security/roles.py` and `frontend/src/lib/types.ts` together.
- Database changes need a migration: `alembic revision --autogenerate --rev-id 000N -m "..."`, then read
  and fix the generated file. New NOT NULL columns need a server default. Catalog data goes in both
  `app/seed.py` (new databases) and a data migration (existing ones), changing only rows that still hold
  the seeded values.
- Plain ASCII hyphens and quotes everywhere: no em or en dashes, no smart quotes.
- No secrets, real personal data or demo data in commits. Test data lives in `backend/tests/`.

## Test it

Run all three before you ask for review, and say in the pull request what you ran:

```sh
docker compose -f compose.dev.yml exec -T api pytest -q
cd frontend && npm run lint && npm run build
```

and the browser test (see the command in [AGENTS.md](AGENTS.md#run-and-test)). Rebuild nginx first if you
changed the PWA.

- Fixing a bug: add a test that fails before the fix.
- New behaviour: add backend tests for the rules (who may, who may not, 404 versus 403), and extend
  `e2e/smoke.spec.ts` when a screen flow changes.
- "It compiles" is not "it works". If something could not be checked (a real phone, push delivery, the campus
  hostname), say so.

## Document it

- Add an entry to `CHANGELOG.md` under **Unreleased**: what changed for people, and **Action needed**
  for operators (new settings, migrations, rebuilds).
- Update the guide for the people affected (`docs/USER-GUIDE.md`), the flow or data
  (`docs/ARCHITECTURE.md`), the controls (`docs/SECURITY.md`) and settings (`docs/DEPLOYMENT.md`,
  `.env.example`), as they apply.
- Update `AGENTS.md` if a rule or location changed.
- Regenerate the API contract when the API changed:
  `docker compose -f compose.dev.yml exec api python -m app.cli export-openapi`.

## Commit and open a pull request

- Commit messages: a short imperative summary line, then the why.
- The pull request description explains the **root cause** (for a bug) or the **request** (for a feature),
  what changed, how it was tested, and anything not verified.
- CI (`.github/workflows/ci.yml`) runs the backend tests, the frontend lint and build, the compose files
  check and the browser test. It must pass before merging.
- At least one other maintainer reviews. Changes to `app/security/`, `services/lifecycle.py`,
  `services/workflow.py`, migrations or nginx need a reviewer who knows those rules.

## Reporting a security problem

Do not open a public issue. Tell Team OSSC directly, with steps to reproduce.
