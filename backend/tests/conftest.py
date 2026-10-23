import asyncio
import os

# Must run before app modules read settings.
os.environ["PCMS_ENV"] = "test"
os.environ["PCMS_DATABASE_URL"] = os.environ.get(
    "PCMS_TEST_DATABASE_URL", "postgresql+asyncpg://pcms:pcms_dev@db:5432/pcms_test"
)
os.environ.setdefault("PCMS_SECRET_KEY", "test-secret-key-0123456789")
os.environ.setdefault("PCMS_CREDENTIAL_KEY", "test-credential-key-0123456789abcdef")
os.environ["PCMS_CLAMAV_REQUIRED"] = "false"
# Uploads from tests go to a throwaway directory, never the dev media volume.
os.environ["PCMS_MEDIA_ROOT"] = __import__("tempfile").mkdtemp(prefix="pcms-test-media-")
os.environ["PCMS_MESSAGING_PROVIDER"] = "fake"
os.environ["PCMS_SIGNIN_MAX_ATTEMPTS"] = "5"

import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import sessionmaker  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import seed_all  # noqa: E402

KEEP_TABLES = {"alembic_version"}


def alembic_cfg() -> Config:
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.attributes["database_url"] = os.environ["PCMS_DATABASE_URL"]
    return cfg


async def run_alembic(fn, *args):
    # env.py calls asyncio.run(), so run it on a separate thread with its own loop.
    await asyncio.to_thread(fn, alembic_cfg(), *args)


@pytest.fixture(scope="session", autouse=True)
async def migrated_db():
    async with sessionmaker()() as s:
        await s.execute(text("DROP SCHEMA public CASCADE"))
        await s.execute(text("CREATE SCHEMA public"))
        await s.commit()
    await run_alembic(command.upgrade, "head")
    yield


@pytest.fixture(autouse=True)
async def clean_db(migrated_db):
    async with sessionmaker()() as s:
        rows = await s.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
        tables = [r[0] for r in rows if r[0] not in KEEP_TABLES]
        if tables:
            await s.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " RESTART IDENTITY CASCADE"))
        await s.commit()
    await seed_all()
    yield


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
