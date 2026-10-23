# PCMS backend

FastAPI, async SQLAlchemy 2, Alembic, PostgreSQL 17. Dependencies are pinned in `uv.lock`.

| Path | Contents |
|---|---|
| `app/main.py` | App factory. Refuses to start in production with unsafe settings |
| `app/routers/` | HTTP endpoints (`session`, `tickets`, `directory`, `attachments`, `admin_*`, `push`, `webhooks`) |
| `app/services/` | Business rules: tokens, lifecycle, workflow, media, outbox, scheduler, notifications |
| `app/models/` | Tables. History tables are append-only (database triggers) |
| `app/jobs/` | `worker` (sends the outbox) and `scheduler` (reminders, virus scans) |
| `app/cli.py` | Operator commands; run `python -m app.cli --help` |
| `alembic/versions/` | Migrations |
| `tests/` | pytest suite, run against a real database |

Common commands (inside the `api` container):

```sh
alembic upgrade head
python -m app.cli seed
python -m app.cli create-admin --email ossc@dbit.edu --name "Full Name"
python -m app.cli reset-password --email ossc@dbit.edu [--reset-mfa]
python -m app.cli vapid-keys
python -m app.cli push-test-all
python -m app.cli check-config
python -m app.cli export-openapi --out openapi/openapi.json
pytest -q
```

After changing `pyproject.toml`, regenerate the lockfile:

```sh
docker run --rm -v "$PWD:/w" -w /w ghcr.io/astral-sh/uv:0.13.1-python3.13-trixie-slim uv lock
```
