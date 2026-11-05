"""DBIT changes of 2026-11-04, second round.

  - The facility manager no longer picks Immediate / Critical / Postpone up front. A ticket
    marked fixed without going Critical counts as Immediate, and the closing note is optional.
  - A ticket the principal reported follows the same flow; if it goes Critical, the principal
    cannot decide it, so it goes straight to institute management.
  - Team OSSC can remove any ticket. History stays; the ticket disappears everywhere.
  - Every request from another site is refused; malformed emails are refused at sign-in.
  - The people import takes department and position, and generates missing passwords.
"""

import io
from datetime import date, timedelta

import httpx
from openpyxl import load_workbook
from sqlalchemy import func, select

from app.config import Settings
from app.db import sessionmaker
from app.main import app
from app.models import AuditEvent, User
from app.models.outbox import Outbox
from app.models.session import ThrottleEvent
from app.security.origin import SameOriginMiddleware
from app.services.notify import clip
from tests.factories import API, make_user, new_client, sign_in, subscribe_push, ticket_body


async def _get(s, tid):
    return (await s.get(f"{API}/tickets/{tid}")).json()


async def _tr(s, tid, **body):
    v = (await _get(s, tid))["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions", json={"expectedVersion": v, **body})


async def _close(*clients):
    for c in clients:
        await c.aclose()


async def _assigned(reporter, mgr, **over):
    tid = (await reporter.post(f"{API}/tickets", json=ticket_body(**over))).json()["id"]
    assert (await _tr(mgr, tid, action="triage")).status_code == 200
    assert (await _tr(mgr, tid, action="assign")).status_code == 200
    return tid


# ---------- no up-front flag ----------

async def test_marking_fixed_without_a_choice_counts_as_immediate(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    fac = await sign_in(client, "faculty@dbit.edu")
    mc = new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        tid = await _assigned(fac, mgr)
        assert (await _get(mgr, tid))["flag"] is None
        # No note, no cost, no set_flag: still accepted.
        r = await _tr(mgr, tid, action="resolve")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "Resolved" and r.json()["flag"] == "I"
        found = (await mgr.get(f"{API}/tickets", params={"scope": "queue", "flag": "I"})).json()
        assert [x["id"] for x in found["items"]] == [tid]
    finally:
        await _close(mc)


async def test_postponed_then_resumed_work_is_immediate_when_fixed(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    fac = await sign_in(client, "faculty@dbit.edu")
    mc = new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        tid = await _assigned(fac, mgr)
        r = await _tr(mgr, tid, action="hold", reason="Part on order", owner="Manager", nextAction="Fit it",
                      reviewDate=(date.today() + timedelta(days=3)).isoformat())
        assert r.json()["flag"] == "P"
        assert (await _tr(mgr, tid, action="resume")).json()["flag"] is None
        assert (await _tr(mgr, tid, action="resolve", note="Part fitted")).json()["flag"] == "I"
    finally:
        await _close(mc)


async def test_approved_critical_work_stays_critical_when_fixed(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("principal@dbit.edu", "principal", "Principal")
    fac = await sign_in(client, "faculty@dbit.edu")
    mc, pc = new_client(), new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        prin = await sign_in(pc, "principal@dbit.edu")
        tid = await _assigned(fac, mgr)
        v = (await _get(mgr, tid))["version"]
        p = (await mgr.post(f"{API}/tickets/{tid}/proposals", json={
            "lines": [], "requestedDate": date.today().isoformat(), "remedy": "New pump", "expectedVersion": v,
        })).json()["proposal"]
        assert (await prin.post(f"{API}/proposals/{p['id']}/decisions",
                                json={"kind": "approved", "proposalVersion": 1})).status_code == 200
        assert (await _tr(mgr, tid, action="resolve")).json()["flag"] == "C"
    finally:
        await _close(mc, pc)


# ---------- staff reporters ----------

async def test_a_principal_reported_ticket_follows_the_same_flow(client):
    await make_user("principal@dbit.edu", "principal", "Principal")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("management@dbit.edu", "management", "Management")
    prin = await sign_in(client, "principal@dbit.edu")
    mc, gc = new_client(), new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        mgmt = await sign_in(gc, "management@dbit.edu")
        tid = (await prin.post(f"{API}/tickets", json=ticket_body(title="Principal office AC"))).json()["id"]
        t = await _get(mgr, tid)
        assert t["status"] == "Submitted"  # waits for the facility manager like any other report
        # The principal cannot accept or assign their own report.
        assert (await _tr(prin, tid, action="triage")).status_code == 403
        assert (await _tr(mgr, tid, action="triage")).status_code == 200
        assert (await _tr(mgr, tid, action="assign")).status_code == 200

        v = (await _get(mgr, tid))["version"]
        r = await mgr.post(f"{API}/tickets/{tid}/proposals", json={
            "lines": [{"label": "Compressor", "paise": 900000}], "requestedDate": date.today().isoformat(),
            "remedy": "Replace the compressor", "expectedVersion": v})
        assert r.status_code == 200, r.text
        p = r.json()["proposal"]
        # The principal reported it, so institute management decides.
        assert p["stage"] == "management"
        assert (await prin.post(f"{API}/proposals/{p['id']}/decisions",
                                json={"kind": "approved", "proposalVersion": 1, "ceilingPaise": 900000})).status_code == 403
        r = await mgmt.post(f"{API}/proposals/{p['id']}/decisions",
                            json={"kind": "approved", "proposalVersion": 1, "ceilingPaise": 900000})
        assert r.status_code == 200 and r.json()["status"] == "InProgress", r.text
    finally:
        await _close(mc, gc)


async def test_a_facility_manager_is_not_alerted_about_their_own_report(client):
    me = await make_user("manager@dbit.edu", "facility_manager", "Manager")
    other = await make_user("manager2@dbit.edu", "facility_manager", "Second Manager")
    await subscribe_push(me)
    await subscribe_push(other)
    mgr = await sign_in(client, "manager@dbit.edu")
    assert (await mgr.post(f"{API}/tickets", json=ticket_body())).status_code == 201
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(Outbox).where(Outbox.template == "new_ticket"))).all()
    assert {o.user_id for o in rows} == {other.id}


# ---------- removal by Team OSSC ----------

async def test_team_ossc_removes_a_ticket_everywhere(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("principal@dbit.edu", "principal", "Principal")
    admin = await make_user("admin@dbit.edu", "ossc", "Super Admin")
    fac = await sign_in(client, "faculty@dbit.edu")
    mc, pc, ac = new_client(), new_client(), new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        prin = await sign_in(pc, "principal@dbit.edu")
        ossc = await sign_in(ac, "admin@dbit.edu")
        keep = (await fac.post(f"{API}/tickets", json=ticket_body(title="Keep this one"))).json()["id"]
        gone = await _assigned(fac, mgr, title="Test entry to remove")
        v = (await _get(ossc, gone))["version"]

        for s in (fac, mgr, prin):
            r = await s.post(f"{API}/tickets/{gone}/remove", json={"reason": "Test entry", "expectedVersion": v})
            assert r.status_code == 403, r.text
        assert (await ossc.post(f"{API}/tickets/{gone}/remove",
                                json={"reason": "", "expectedVersion": v})).status_code == 400
        assert (await ossc.post(f"{API}/tickets/{gone}/remove",
                                json={"reason": "Test entry", "expectedVersion": v + 5})).status_code == 409
        r = await ossc.post(f"{API}/tickets/{gone}/remove", json={"reason": "Test entry", "expectedVersion": v})
        assert r.status_code == 204, r.text

        for s in (fac, mgr, prin, ossc):
            assert (await s.get(f"{API}/tickets/{gone}")).status_code == 404
        assert [x["id"] for x in (await mgr.get(f"{API}/tickets", params={"scope": "queue"})).json()["items"]] == [keep]
        assert [x["id"] for x in (await fac.get(f"{API}/tickets")).json()["items"]] == [keep]
        report = (await prin.get(f"{API}/reports")).json()
        assert sum(d["total"] for d in report["byDepartment"]) == 1
        csv_text = (await mgr.get(f"{API}/reports/tickets.csv")).text
        assert "Keep this one" in csv_text and "Test entry to remove" not in csv_text

        async with sessionmaker()() as db:
            a = await db.scalar(select(AuditEvent).where(AuditEvent.action == "ticket.removed"))
            assert a is not None and a.actor_id == admin.id and a.reason == "Test entry"
    finally:
        await _close(mc, pc, ac)


# ---------- cross-origin and input limits ----------

async def test_requests_from_other_sites_are_refused(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    evil = {"Origin": "https://evil.example"}
    r = await fac.post(f"{API}/tickets", json=ticket_body(), headers=evil)
    assert r.status_code == 403 and r.json()["code"] == "cross_origin"
    assert (await client.get(f"{API}/me", headers=evil)).status_code == 403
    assert (await client.get(f"{API}/me", headers={"Sec-Fetch-Site": "cross-site"})).status_code == 403
    assert (await fac.post(f"{API}/tickets", json=ticket_body(), headers={"Origin": "null"})).status_code == 403
    assert (await fac.post(f"{API}/tickets", json=ticket_body(),
                           headers={"Referer": "https://evil.example/page"})).status_code == 403
    # Sign-in is covered too, before any credential check.
    r = await client.post(f"{API}/session", json={"email": "faculty@dbit.edu", "password": "x"}, headers=evil)
    assert r.status_code == 403

    # Our own origin, and plain same-origin requests, work.
    ok = {"Origin": "http://localhost:8080", "Sec-Fetch-Site": "same-origin"}
    assert (await fac.post(f"{API}/tickets", json=ticket_body(), headers=ok)).status_code == 201
    assert (await client.get(f"{API}/me", headers={"Sec-Fetch-Site": "same-origin"})).status_code == 200
    # Health checks are exempt. There are no webhooks any more.
    assert (await client.get(f"{API}/health/live", headers=evil)).status_code == 200
    assert (await client.post("/webhooks/twilio/status", data={})).status_code == 404


def _scope(method="GET", **headers):
    return {"type": "http", "method": method, "path": "/api/v1/me",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}


def test_production_accepts_only_our_origin_and_host():
    s = Settings(env="prod", public_app_url="https://pcms.dbit.edu.in")
    check = SameOriginMiddleware.check
    assert check(_scope(host="pcms.dbit.edu.in", origin="https://pcms.dbit.edu.in"), s) is None
    assert check(_scope(host="api:8000"), s) is None  # container health check
    assert check(_scope(host="evil.example"), s) == "Unknown host."
    assert check(_scope(host="pcms.dbit.edu.in", origin="http://localhost:5173"), s) is not None
    assert check(_scope(host="pcms.dbit.edu.in", origin="https://pcms.dbit.edu.in.evil.example"), s) is not None
    assert check(_scope("POST", host="pcms.dbit.edu.in", referer="https://evil.example/x"), s) is not None
    extra = Settings(env="prod", public_app_url="https://pcms.dbit.edu.in",
                     allowed_origins="https://maint.dbit.edu.in", allowed_hosts="maint.dbit.edu.in")
    assert check(_scope(host="maint.dbit.edu.in", origin="https://maint.dbit.edu.in"), extra) is None


def test_production_refuses_unsafe_public_url_and_missing_push_keys():
    common = dict(env="prod", secret_key="x" * 40, credential_key="y" * 40, cookie_secure=True,
                  clamav_required=True, translation_provider="none",
                  database_url="postgresql+asyncpg://pcms:real-pass@db:5432/pcms")
    bad = Settings(**common, public_app_url="http://localhost:8080", vapid_public_key=None, vapid_private_key=None,
                   vapid_subject="mailto:facilities@localhost").check_production()
    assert any("PCMS_PUBLIC_APP_URL" in p for p in bad)
    assert any("PCMS_VAPID_PUBLIC_KEY" in p for p in bad)  # push is the only channel
    assert any("PCMS_VAPID_SUBJECT" in p for p in bad)     # the default @localhost contact
    good = Settings(**common, public_app_url="https://pcms.dbit.edu.in", vapid_public_key="B" * 87,
                    vapid_private_key="k" * 43, vapid_subject="mailto:facilities@dbit.edu.in").check_production()
    assert good == []


async def test_sign_in_refuses_a_malformed_email_before_the_database(client):
    for email in ("not-an-email", "a@b", "x" * 250 + "@dbit.edu", "two..dots@dbit.edu", "a@dbit..edu", "a b@dbit.edu"):
        r = await client.post(f"{API}/session", json={"email": email, "password": "whatever-123"})
        assert r.status_code == 400 and r.json()["code"] == "validation", (email, r.text)
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(ThrottleEvent)) == 0


async def test_huge_version_numbers_are_bad_input_not_errors(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
    r = await fac.post(f"{API}/tickets/{tid}/transitions", json={"action": "verify", "expectedVersion": 10**30})
    assert r.status_code == 400


# ---------- people import ----------

async def test_import_takes_department_position_and_generates_passwords(client):
    await make_user("admin@dbit.edu", "ossc", "Super Admin")
    s = await sign_in(client, "admin@dbit.edu")
    text = (
        "Email ID,Full Name,Designation,Dept,Role,Password\n"
        "asha@dbit.edu,Asha Rao,Assistant Professor,Computer Science and Engineering (CSE),,\n"
        "vikram@dbit.edu,Vikram S,Estate Officer,Administration,facility_manager,Temp-Estate-7391\n"
    )
    r = await s.post(f"{API}/admin/users/import", files={"file": ("staff.csv", text.encode(), "text/csv")})
    assert r.status_code == 200, r.text
    ws = load_workbook(io.BytesIO(r.content))["Credentials"]
    it = ws.iter_rows(values_only=True)
    headers = next(it)
    rows = {row[0]: dict(zip(headers, row, strict=True)) for row in it if row[0]}
    asha = rows["asha@dbit.edu"]
    assert asha["position"] == "Assistant Professor" and asha["department"].startswith("Computer Science")
    assert asha["role"] == "faculty" and len(asha["password"]) >= 12 and "Generated" in asha["notes"]
    assert rows["vikram@dbit.edu"]["password"] == "Temp-Estate-7391"

    async with sessionmaker()() as db:
        u = await db.scalar(select(User).where(User.email == "asha@dbit.edu"))
        assert u.position == "Assistant Professor" and u.must_change_password
    listed = (await s.get(f"{API}/admin/users", params={"q": "asha"})).json()["items"][0]
    assert listed["department"].startswith("Computer Science") and listed["position"] == "Assistant Professor"

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as person:
        r = await person.post(f"{API}/session", json={"email": "asha@dbit.edu", "password": asha["password"]})
        assert r.status_code == 200 and r.json()["next"] == "change_password"


async def test_import_rejects_a_repeated_column(client):
    await make_user("admin@dbit.edu", "ossc", "Super Admin")
    s = await sign_in(client, "admin@dbit.edu")
    text = "email,Email ID,name\na@dbit.edu,a@dbit.edu,A Person\n"
    r = await s.post(f"{API}/admin/users/import", files={"file": ("x.csv", text.encode(), "text/csv")})
    assert r.status_code == 400 and "twice" in r.json()["message"]


# ---------- notifications ----------

def test_notification_text_is_cut_at_a_word_with_a_visible_marker():
    long = "Expenditure request v2 for the water tank liner in Block A terrace " * 5
    out = clip(long, 100)
    assert len(out) <= 100 and out.endswith("...") and not out[:-3].endswith(" ")
    assert long.startswith(out[:-3])
    assert clip("Short title", 100) == "Short title"
    assert clip("  spaced\n\ntext  ", 100) == "spaced text"
