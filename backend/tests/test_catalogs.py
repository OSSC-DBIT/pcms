import pytest
from alembic import command
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from app.db import sessionmaker
from app.models import AuditEvent, Category
from app.seed import seed_all
from tests.conftest import run_alembic

EXPECTED_LETTERS = {"it_services": "S", "civil": "V", "mechanical": "M"}


async def test_catalogs_shape_matches_frontend(client):
    r = await client.get("/api/v1/catalogs")
    assert r.status_code == 200
    body = r.json()
    cats = {c["code"]: c for c in body["categories"]}
    assert {k: v["letter"] for k, v in cats.items()} == EXPECTED_LETTERS
    assert set(cats["it_services"]) == {"code", "letter", "nameEn", "nameHi", "nameKn",
                                        "subtypesEn", "subtypesHi", "subtypesKn", "active"}
    assert cats["it_services"]["subtypesEn"][0] == "Computer / Laptop"
    assert cats["it_services"]["nameHi"]
    assert cats["it_services"]["nameKn"]
    codes = [b["code"] for b in body["buildings"]]
    assert codes[0] == "BLOCK_A" and {"BLOCK_B", "MBA", "PU", "HOSTEL", "ADMIN_BLOCK", "SPORTS"} <= set(codes)
    # Buildings carry active too, so the Places screen can show and restore a retired one.
    assert set(body["buildings"][0]) == {"code", "nameEn", "nameHi", "nameKn", "floors",
                                         "departments", "departmentsKn", "active"}
    assert all(b["active"] for b in body["buildings"])
    block_a = next(b for b in body["buildings"] if b["code"] == "BLOCK_A")
    assert "Computer Science and Engineering (CSE)" in block_a["departments"]
    assert block_a["floors"] == ["Ground", "1", "2", "3"]
    sports = next(b for b in body["buildings"] if b["code"] == "SPORTS")
    assert sports["nameEn"] == "Sports Department"
    assert sports["departments"] == [] and sports["departmentsKn"] == []
    assert codes.index("SPORTS") == len(codes) - 1


async def test_catalogs_include_inactive_is_for_admin_screens(client):
    """The default list stays active-only, so a retired type cannot be reported."""
    async with sessionmaker()() as s:
        await s.execute(text("UPDATE category SET active = false WHERE code = 'civil'"))
        await s.commit()
    assert "civil" not in {c["code"] for c in (await client.get("/api/v1/catalogs")).json()["categories"]}
    full = (await client.get("/api/v1/catalogs", params={"includeInactive": True})).json()["categories"]
    assert next(c for c in full if c["code"] == "civil")["active"] is False


async def test_seed_is_idempotent_and_keeps_admin_edits():
    async with sessionmaker()() as s:
        cat = await s.scalar(select(Category).where(Category.code == "other"))
        cat.name_en = "Miscellaneous"
        await s.commit()
    await seed_all()
    await seed_all()
    async with sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(Category)) == 12
        assert (await s.scalar(select(Category).where(Category.code == "other"))).name_en == "Miscellaneous"


async def test_inactive_category_hidden(client):
    async with sessionmaker()() as s:
        await s.execute(text("UPDATE category SET active = false WHERE code = 'civil'"))
        await s.commit()
    r = await client.get("/api/v1/catalogs")
    assert "civil" not in {c["code"] for c in r.json()["categories"]}


async def test_duplicate_letter_rejected():
    async with sessionmaker()() as s:
        s.add(Category(code="glass", letter="C", name_en="Glass", name_hi="x", name_kn="x",
                       subtypes_en=[], subtypes_hi=[], subtypes_kn=[]))
        with pytest.raises(DBAPIError):
            await s.commit()


async def test_audit_events_are_append_only():
    async with sessionmaker()() as s:
        s.add(AuditEvent(actor_label="t", action="x", entity_type="t", entity_id="1"))
        await s.commit()
    async with sessionmaker()() as s:
        with pytest.raises(DBAPIError, match="append-only"):
            await s.execute(text("UPDATE audit_event SET action = 'y'"))
    async with sessionmaker()() as s:
        with pytest.raises(DBAPIError, match="append-only"):
            await s.execute(text("DELETE FROM audit_event"))


async def test_upgrade_with_existing_users():
    """Regression: 0002 added NOT NULL columns without defaults and failed on populated tables."""
    await run_alembic(command.downgrade, "0001")
    async with sessionmaker()() as s:
        await s.execute(text(
            "INSERT INTO app_user (id, employee_id, name, role, active, totp_enabled, recovery_code_hashes) "
            "VALUES (gen_random_uuid(), 'DB9999', 'Existing', 'ossc', true, false, '{}')"
        ))
        await s.commit()
    await run_alembic(command.upgrade, "head")
    async with sessionmaker()() as s:
        row = (await s.execute(text(
            "SELECT must_change_password, version, email FROM app_user WHERE email='db9999@pcms.invalid'"
        ))).one()
        old_column = await s.scalar(text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name='app_user' AND column_name='employee_id'"
        ))
    assert row == (True, 1, "db9999@pcms.invalid")
    assert old_column == 0


async def test_migrations_downgrade_and_upgrade():
    await run_alembic(command.downgrade, "base")
    async with sessionmaker()() as s:
        n = await s.scalar(text("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> 'alembic_version'"))
        assert n == 0
    await run_alembic(command.upgrade, "head")
    await seed_all()
    async with sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(Category)) == 12
