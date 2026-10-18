from datetime import timedelta

import httpx
from sqlalchemy import select

from app.db import sessionmaker
from app.main import app
from app.models import AuditEvent, User
from app.security.sessions import now
from tests.factories import API, PASSWORD, make_user, sign_in, totp_code


async def _post_signin(client, emp, pw=PASSWORD):
    return await client.post(f"{API}/session", json={"employeeId": emp, "password": pw})


async def test_faculty_sign_in_me_and_sign_out(client):
    await make_user("DB2101", "faculty", "S. Deshmukh")
    s = await sign_in(client, " db2101 ")  # normalised
    me = (await client.get(f"{API}/me")).json()
    assert me["employeeId"] == "DB2101" and me["role"] == "faculty"
    assert me["capabilities"] == ["ticket.create", "ticket.track", "ticket.verify"]
    assert (await s.delete(f"{API}/session")).status_code == 204
    assert (await client.get(f"{API}/me")).status_code == 401


async def test_session_cookie_flags(client):
    await make_user("DB2101", "faculty")
    r = await _post_signin(client, "DB2101")
    cookies = r.headers.get_list("set-cookie")
    sess = next(c for c in cookies if c.startswith("pcms_session="))
    csrf = next(c for c in cookies if c.startswith("pcms_csrf="))
    assert "HttpOnly" in sess and "SameSite=lax" in sess
    assert "HttpOnly" not in csrf


async def test_wrong_password_and_unknown_user_look_the_same(client):
    await make_user("DB2101", "faculty")
    a = await _post_signin(client, "DB2101", "wrong-password")
    b = await _post_signin(client, "NOPE99", "wrong-password")
    assert a.status_code == b.status_code == 401
    assert a.json()["code"] == b.json()["code"] == "invalid_credentials"
    assert a.json()["message"] == b.json()["message"]


async def test_first_sign_in_forces_password_change(client):
    await make_user("DB2101", "faculty", password="Temp-Abcd-2345", temporary=True)
    r = await _post_signin(client, "DB2101", "Temp-Abcd-2345")
    body = r.json()
    assert body["next"] == "change_password"
    # The temporary password grants nothing else.
    assert (await client.get(f"{API}/me")).json()["code"] == "password_change_required"
    assert (await client.get(f"{API}/push/config")).status_code == 401

    h = {"X-CSRF-Token": body["csrfToken"]}
    weak = await client.post(f"{API}/session/password", json={"currentPassword": "Temp-Abcd-2345", "newPassword": "short"}, headers=h)
    assert weak.status_code == 400 and "newPassword" in weak.json()["field_errors"]
    same = await client.post(f"{API}/session/password", json={"currentPassword": "Temp-Abcd-2345", "newPassword": "Temp-Abcd-2345"}, headers=h)
    assert same.status_code == 400
    has_id = await client.post(f"{API}/session/password", json={"currentPassword": "Temp-Abcd-2345", "newPassword": "my-db2101-pass"}, headers=h)
    assert has_id.status_code == 400
    ok = await client.post(f"{API}/session/password", json={"currentPassword": "Temp-Abcd-2345", "newPassword": "Monsoon-Lake-77"}, headers=h)
    assert ok.status_code == 200 and ok.json()["next"] == "done"
    assert (await client.get(f"{API}/me")).status_code == 200
    # The temporary password no longer works.
    assert (await _post_signin(client, "DB2101", "Temp-Abcd-2345")).status_code == 401
    assert (await _post_signin(client, "DB2101", "Monsoon-Lake-77")).json()["next"] == "done"


async def test_expired_temporary_password_rejected(client):
    u = await make_user("DB2101", "faculty", password="Temp-Abcd-2345", temporary=True)
    async with sessionmaker()() as db:
        (await db.get(User, u.id)).temp_password_expires_at = now() - timedelta(minutes=1)
        await db.commit()
    r = await _post_signin(client, "DB2101", "Temp-Abcd-2345")
    assert r.status_code == 401 and r.json()["code"] == "temp_password_expired"


async def test_facility_manager_has_no_second_factor(client):
    await make_user("DB0001", "facility_manager", password="Temp-Abcd-2345", temporary=True)
    body = (await _post_signin(client, "DB0001", "Temp-Abcd-2345")).json()
    assert body["next"] == "change_password"
    body = (await client.post(f"{API}/session/password", json={"currentPassword": "Temp-Abcd-2345", "newPassword": "Monsoon-Lake-77"},
                              headers={"X-CSRF-Token": body["csrfToken"]})).json()
    assert body["next"] == "done"
    assert (await client.get(f"{API}/me")).json()["role"] == "facility_manager"


async def test_new_admin_changes_password_then_enrols_totp(client):
    await make_user("DB0001", "ossc", password="Temp-Abcd-2345", temporary=True)
    body = (await _post_signin(client, "DB0001", "Temp-Abcd-2345")).json()
    assert body["next"] == "change_password" and body["enrolment"] is None
    h = {"X-CSRF-Token": body["csrfToken"]}
    # Cannot skip ahead to TOTP.
    assert (await client.post(f"{API}/session/totp", json={"code": "123456"}, headers=h)).status_code == 409
    body = (await client.post(f"{API}/session/password", json={"currentPassword": "Temp-Abcd-2345", "newPassword": "Monsoon-Lake-77"}, headers=h)).json()
    assert body["next"] == "enrol_totp"
    assert body["enrolment"]["uri"].startswith("otpauth://totp/")
    assert (await client.get(f"{API}/me")).json()["code"] == "mfa_required"
    h = {"X-CSRF-Token": body["csrfToken"]}
    assert (await client.post(f"{API}/session/totp", json={"code": "000000"}, headers=h)).status_code == 401
    done = await client.post(f"{API}/session/totp", json={"code": totp_code(body["enrolment"]["secret"])}, headers=h)
    assert done.status_code == 200 and done.json()["next"] == "done"
    assert len(done.json()["recoveryCodes"]) == 10
    assert done.json()["csrfToken"] != body["csrfToken"]  # rotated
    assert (await client.get(f"{API}/me")).json()["role"] == "ossc"


async def test_reset_admin_with_totp_must_pass_totp_before_password_change(client):
    await make_user("DB0002", "ossc")
    s = await sign_in(client, "DB0002")
    async with sessionmaker()() as db:
        u = await db.scalar(select(User).where(User.employee_id == "DB0002"))
        from app.services.accounts import issue_temporary_password
        temp = issue_temporary_password(u)
        await db.commit()
    body = (await _post_signin(client, "DB0002", temp)).json()
    assert body["next"] == "totp"
    h = {"X-CSRF-Token": body["csrfToken"]}
    r = await client.post(f"{API}/session/password", json={"currentPassword": temp, "newPassword": "Monsoon-Lake-77"}, headers=h)
    assert r.status_code == 401 and r.json()["code"] == "mfa_required"
    body = (await client.post(f"{API}/session/totp", json={"code": totp_code(s.totp_secret, 30)}, headers=h)).json()
    assert body["next"] == "change_password"


async def test_suspended_user_rejected_and_live_session_fails(client):
    u = await make_user("DB2101", "faculty")
    await sign_in(client, "DB2101")
    async with sessionmaker()() as db:
        (await db.get(User, u.id)).active = False
        await db.commit()
    r = await client.get(f"{API}/me")
    assert r.status_code == 401 and r.json()["code"] == "suspended"
    assert (await _post_signin(client, "DB2101")).status_code == 401


async def test_csrf_required_on_mutations(client):
    await make_user("DB2101", "faculty")
    await sign_in(client, "DB2101")
    r = await client.request("DELETE", f"{API}/session")
    assert r.status_code == 403 and r.json()["code"] == "csrf_failed"
    assert (await client.request("DELETE", f"{API}/session", headers={"X-CSRF-Token": "forged"})).status_code == 403
    assert (await client.get(f"{API}/me")).status_code == 200


async def test_sign_in_throttled_after_repeated_failures(client):
    await make_user("DB2101", "faculty")
    for _ in range(5):
        assert (await _post_signin(client, "DB2101", "bad-password")).status_code == 401
    r = await _post_signin(client, "DB2101")
    assert r.status_code == 429 and r.json()["code"] == "throttled"
    async with sessionmaker()() as db:
        n = len((await db.scalars(select(AuditEvent).where(AuditEvent.action == "signin.failed"))).all())
    assert n == 5


async def test_totp_replay_rejected(client):
    await make_user("DB0002", "ossc")
    s = await sign_in(client, "DB0002")
    used = totp_code(s.totp_secret)
    body = (await _post_signin(client, "DB0002")).json()
    assert body["next"] == "totp"
    r = await client.post(f"{API}/session/totp", json={"code": used}, headers={"X-CSRF-Token": body["csrfToken"]})
    assert r.status_code == 401
    body = (await _post_signin(client, "DB0002")).json()
    r = await client.post(f"{API}/session/totp", json={"code": totp_code(s.totp_secret, 30)}, headers={"X-CSRF-Token": body["csrfToken"]})
    assert r.status_code == 200


async def test_recovery_code_works_once(client):
    await make_user("DB0000", "ossc")
    body = (await _post_signin(client, "DB0000")).json()
    r = await client.post(f"{API}/session/totp", json={"code": totp_code(body["enrolment"]["secret"])},
                          headers={"X-CSRF-Token": body["csrfToken"]})
    code = r.json()["recoveryCodes"][0]
    for expected in (200, 401):
        body = (await _post_signin(client, "DB0000")).json()
        r = await client.post(f"{API}/session/totp", json={"code": code}, headers={"X-CSRF-Token": body["csrfToken"]})
        assert r.status_code == expected


async def test_change_password_revokes_other_sessions(client):
    await make_user("DB2101", "faculty")
    s1 = await sign_in(client, "DB2101")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        await sign_in(other, "DB2101")
        r = await s1.post(f"{API}/session/password", json={"currentPassword": PASSWORD, "newPassword": "Fresh-pass-2026"})
        assert r.status_code == 200
        assert (await other.get(f"{API}/me")).status_code == 401
    assert (await client.get(f"{API}/me")).status_code == 200


async def test_role_capabilities_follow_dbit_decisions():
    from app.security.roles import CAPABILITIES, capabilities_for, requires_second_factor

    assert "cost.approve" not in capabilities_for("facility_manager")
    assert "worker.manage" in capabilities_for("facility_manager")
    assert "ticket.assign" not in capabilities_for("management")
    assert set(capabilities_for("ossc")) == CAPABILITIES  # super admin: full access
    assert "worker.directory" not in capabilities_for("faculty")
    assert [r for r in ("faculty", "facility_manager", "management", "ossc") if requires_second_factor(r)] == ["ossc"]


async def test_management_has_no_second_factor(client):
    await make_user("DB0002", "management")
    body = (await _post_signin(client, "DB0002")).json()
    assert body["next"] == "done"


async def test_role_capabilities_follow_plan():
    from app.security.roles import capabilities_for

    assert "worker.directory" not in capabilities_for("faculty")
