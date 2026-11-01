"""Settings from the environment file: the database login and the Team OSSC admins."""

import os

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app import cli
from app.config import Settings
from app.db import sessionmaker
from app.models.user import User


def test_database_url_is_built_from_parts_with_the_password_escaped():
    s = Settings(database_url="", db_host="db", db_port=6543, db_name="campus", db_user="ossc",
                 db_password="p@ss:w/rd#1 x")
    url = make_url(s.database_url)
    assert (url.host, url.port, url.database, url.username, url.password) == (
        "db", 6543, "campus", "ossc", "p@ss:w/rd#1 x")


def test_production_refuses_a_missing_or_placeholder_database_password():
    common = dict(env="prod", secret_key="x" * 40, credential_key="y" * 40, cookie_secure=True,
                  clamav_required=True, messaging_provider="none", database_url="")
    assert "PCMS_DB_PASSWORD is not set" in Settings(**common, db_password="").check_production()
    assert any("placeholder" in p for p in Settings(**common, db_password="CHANGE_ME").check_production())
    assert Settings(**common, db_password="a-real-password-123").check_production() == []


def _only_these_admins(monkeypatch, values: dict[str, str]) -> None:
    # The dev stack loads .env into the container, so clear any real admin slots first.
    for key in list(os.environ):
        if key.startswith("PCMS_ADMIN_"):
            monkeypatch.delenv(key)
    for key, value in values.items():
        monkeypatch.setenv(key, value)


async def test_every_admin_in_the_environment_is_created_once(monkeypatch, capsys):
    _only_these_admins(monkeypatch, {
        "PCMS_ADMIN_1_EMAIL": "One@dbit.edu", "PCMS_ADMIN_1_NAME": "Admin One",
        "PCMS_ADMIN_1_PASSWORD": "Campus-Desk-2026",
        "PCMS_ADMIN_2_EMAIL": "two@dbit.edu", "PCMS_ADMIN_2_NAME": "Admin Two",
        # A blank group, as left in the template, is ignored.
        "PCMS_ADMIN_3_EMAIL": "", "PCMS_ADMIN_3_NAME": "", "PCMS_ADMIN_3_PASSWORD": "",
    })
    assert await cli._create_admin_from_env(None) == 0
    out = capsys.readouterr().out
    assert out.count("created ") == 2
    assert "Campus-Desk-2026" not in out  # a password from the file is never printed
    async with sessionmaker()() as db:
        admins = (await db.scalars(select(User).order_by(User.email))).all()
    assert [(u.email, u.role, u.must_change_password) for u in admins] == [
        ("one@dbit.edu", "ossc", True), ("two@dbit.edu", "ossc", True)]

    # Running it again changes nothing.
    assert await cli._create_admin_from_env(None) == 0
    assert capsys.readouterr().out.count("already exists") == 2


async def test_incomplete_or_weak_admin_groups_are_reported(monkeypatch, capsys):
    _only_these_admins(monkeypatch, {"PCMS_ADMIN_1_EMAIL": "half@dbit.edu"})
    assert await cli._create_admin_from_env(None) == 2
    assert "PCMS_ADMIN_1_EMAIL and PCMS_ADMIN_1_NAME are both required" in capsys.readouterr().err

    _only_these_admins(monkeypatch, {"PCMS_ADMIN_1_EMAIL": "weak@dbit.edu", "PCMS_ADMIN_1_NAME": "Weak",
                                     "PCMS_ADMIN_1_PASSWORD": "short"})
    assert await cli._create_admin_from_env(None) == 2
    assert "PCMS_ADMIN_1: password: Use at least 10 characters." in capsys.readouterr().err

    _only_these_admins(monkeypatch, {})
    assert await cli._create_admin_from_env(None) == 2
    assert "no admins set" in capsys.readouterr().err
    async with sessionmaker()() as db:
        assert (await db.scalars(select(User))).all() == []
