import csv
import io

import httpx
from sqlalchemy import func, select

from app.db import sessionmaker
from app.main import app
from app.models import AuditEvent, User
from tests.factories import API, make_user, sign_in


async def _ossc(client):
    await make_user("DB0000", "ossc", "OSSC Lead")
    return await sign_in(client, "DB0000")


def _csv(text: str):
    return {"file": ("people.csv", text.encode("utf-8"), "text/csv")}


def _rows(resp) -> list[dict]:
    return list(csv.DictReader(io.StringIO(resp.text.lstrip("\ufeff"))))


async def test_only_ossc_can_manage_users(client):
    await make_user("DB2101", "faculty")
    s = await sign_in(client, "DB2101")
    assert (await s.get(f"{API}/admin/users")).status_code == 403
    assert (await s.post(f"{API}/admin/users/import", files=_csv("employee_id,name\nX1,Y Z\n"))).status_code == 403


async def test_csv_import_returns_credentials_and_forces_change(client):
    s = await _ossc(client)
    await make_user("DB2101", "faculty", "Existing Person")
    text = (
        "Employee ID,Name,Role,Email\n"
        "db3001,Priya Nair,faculty,priya@example.edu\n"
        "DB3002,राहुल पाटील,,\n"
        "DB3003,=HYPERLINK(\"x\"),facility_manager,\n"
        "DB2101,Existing Person,faculty,\n"
        "\n"
    )
    r = await s.post(f"{API}/admin/users/import", files=_csv(text))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "no-store" in r.headers["cache-control"]
    assert r.headers["x-pcms-created"] == "3" and r.headers["x-pcms-existing"] == "1"
    rows = {row["employee_id"]: row for row in _rows(r)}
    assert rows["DB3001"]["status"] == "created" and len(rows["DB3001"]["temporary_password"]) == 14
    assert rows["DB3002"]["role"] == "faculty" and rows["DB3002"]["name"] == "राहुल पाटील"
    assert rows["DB3003"]["name"].startswith("'=")  # formula neutralised in the export
    assert rows["DB2101"]["status"] == "already_exists" and rows["DB2101"]["temporary_password"] == ""
    assert len({row["temporary_password"] for row in rows.values() if row["temporary_password"]}) == 3

    # Plaintext passwords are not stored anywhere.
    async with sessionmaker()() as db:
        u = await db.scalar(select(User).where(User.employee_id == "DB3001"))
        assert u.must_change_password and u.password_hash.startswith("$argon2id$")
        assert rows["DB3001"]["temporary_password"] not in u.password_hash
        audits = (await db.scalars(select(AuditEvent).where(AuditEvent.action == "user.imported"))).all()
        assert len(audits) == 1 and rows["DB3001"]["temporary_password"] not in str(audits[0].after)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as person:
        r = await person.post(f"{API}/session", json={"employeeId": "DB3001", "password": rows["DB3001"]["temporary_password"]})
        assert r.json()["next"] == "change_password"


async def test_csv_import_is_all_or_nothing(client):
    s = await _ossc(client)
    text = "employee_id,name,role\nDB4001,Good Row,faculty\nDB4002,X,faculty\nDB4001,Dup,faculty\nDB4003,Bad Role,ossc\n"
    r = await s.post(f"{API}/admin/users/import", files=_csv(text))
    assert r.status_code == 400
    errs = r.json()["field_errors"]
    assert set(errs) == {"line 3", "line 4", "line 5"}
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(User)) == 1  # only the OSSC account


async def test_csv_import_rejects_bad_files(client):
    s = await _ossc(client)
    assert (await s.post(f"{API}/admin/users/import", files=_csv("id,full_name\n1,2\n"))).status_code == 400
    assert (await s.post(f"{API}/admin/users/import", files={"file": ("x.csv", b"\xff\xfe\x00bad", "text/csv")})).status_code == 400
    assert (await s.post(f"{API}/admin/users/import", files=_csv("employee_id,name,salary\nA1,Bb,3\n"))).status_code == 400
    big = "employee_id,name\n" + "".join(f"E{i:05d},Person {i}\n" for i in range(1001))
    assert (await s.post(f"{API}/admin/users/import", files=_csv(big))).status_code == 400


async def test_csv_dry_run_creates_nothing(client):
    s = await _ossc(client)
    r = await s.post(f"{API}/admin/users/import?dryRun=true", files=_csv("employee_id,name\nDB5001,Some One\nDB0000,Me\n"))
    assert r.status_code == 200
    assert r.json() == {"toCreate": 1, "alreadyExist": ["DB0000"]}
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(User)) == 1


async def test_create_and_reset_user(client):
    s = await _ossc(client)
    r = await s.post(f"{API}/admin/users", json={"employeeId": "db0001", "name": "R. Patil", "role": "facility_manager"})
    assert r.status_code == 201 and "no-store" in r.headers["cache-control"]
    created = r.json()
    assert created["user"]["employeeId"] == "DB0001" and created["user"]["mustChangePassword"]
    assert (await s.post(f"{API}/admin/users", json={"employeeId": "DB0001", "name": "Again", "role": "faculty"})).status_code == 409

    r = await s.post(f"{API}/admin/users/{created['user']['id']}/reset-password", json={"resetMfa": True})
    assert r.status_code == 200 and r.json()["temporaryPassword"] != created["temporaryPassword"]
    me_id = (await s.get(f"{API}/me")).json()["id"]
    assert (await s.post(f"{API}/admin/users/{me_id}/reset-password", json={})).status_code == 403


async def test_role_change_needs_reason_is_versioned_and_revokes_sessions(client):
    s = await _ossc(client)
    u = await make_user("DB2101", "faculty")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as person:
        await sign_in(person, "DB2101")
        r = await s.patch(f"{API}/admin/users/{u.id}", json={"expectedVersion": 1, "role": "facility_manager"})
        assert r.status_code == 400 and "reason" in r.json()["field_errors"]
        r = await s.patch(f"{API}/admin/users/{u.id}", json={"expectedVersion": 1, "role": "facility_manager", "reason": "Promoted"})
        assert r.status_code == 200 and r.json()["version"] == 2
        # Old faculty session must not carry over into an admin role without TOTP.
        assert (await person.get(f"{API}/me")).status_code == 401
    stale = await s.patch(f"{API}/admin/users/{u.id}", json={"expectedVersion": 1, "name": "New Name"})
    assert stale.status_code == 409
    async with sessionmaker()() as db:
        ev = await db.scalar(select(AuditEvent).where(AuditEvent.action == "user.role_changed"))
        assert ev.before["role"] == "faculty" and ev.after["role"] == "facility_manager" and ev.reason == "Promoted"


async def test_cannot_lock_out_last_admin_or_self(client):
    s = await _ossc(client)
    me = (await s.get(f"{API}/me")).json()
    r = await s.patch(f"{API}/admin/users/{me['id']}", json={"expectedVersion": 1, "active": False, "reason": "x"})
    assert r.status_code == 403
    other = await make_user("DB0009", "ossc")
    r = await s.patch(f"{API}/admin/users/{other.id}", json={"expectedVersion": 1, "active": False, "reason": "Left"})
    assert r.status_code == 200  # two admins existed


async def test_list_users_search_escapes_wildcards(client):
    s = await _ossc(client)
    await make_user("DB2101", "faculty", "Asha_Kumar")
    await make_user("DB2102", "faculty", "Ashok Rao")
    r = await s.get(f"{API}/admin/users", params={"q": "asha_"})
    assert [u["employeeId"] for u in r.json()["items"]] == ["DB2101"]
    body = r.json()["items"][0]
    assert "passwordHash" not in body and "totpSecret" not in body
