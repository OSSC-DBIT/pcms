import csv
import io

from sqlalchemy import select

from app.db import sessionmaker
from app.models import AuditEvent
from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def test_report_counts_and_permissions(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    for _ in range(2):
        await fac.post(f"{API}/tickets", json=ticket_body())
    assert (await fac.get(f"{API}/reports")).status_code == 403
    async with new_client() as c:
        await make_user("management@dbit.edu", "management")
        m = await sign_in(c, "management@dbit.edu")
        r = (await m.get(f"{API}/reports")).json()
        assert r["untriaged"] == 2 and r["openByPriority"] == {"P2": 2}
        assert r["repeatFaults"][0]["count"] == 2 and r["repeatFaults"][0]["room"] == "203"


async def test_export_is_formula_safe_and_audited(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body(title='=HYPERLINK("http://x","y")'))
    async with new_client() as c:
        await make_user("manager@dbit.edu", "facility_manager")
        m = await sign_in(c, "manager@dbit.edu")
        r = await m.get(f"{API}/reports/tickets.csv")
        rows = list(csv.DictReader(io.StringIO(r.text.lstrip("\ufeff"))))
        assert rows[0]["title"].startswith("'=")
        assert rows[0]["reporter_email"] == "faculty@dbit.edu"
        assert "reporter_employee_id" not in rows[0]
    async with sessionmaker()() as db:
        assert await db.scalar(select(AuditEvent).where(AuditEvent.action == "export.tickets"))


async def test_audit_log_only_for_ossc(client):
    await make_user("manager@dbit.edu", "facility_manager")
    m = await sign_in(client, "manager@dbit.edu")
    assert (await m.get(f"{API}/admin/audit")).status_code == 403
    async with new_client() as c:
        await make_user("admin@dbit.edu", "ossc")
        o = await sign_in(c, "admin@dbit.edu")
        r = await o.get(f"{API}/admin/audit", params={"action": "signin"})
        assert r.status_code == 200 and all(e["action"].startswith("signin") for e in r.json())


async def test_category_letters_never_recycled_and_buildings_editable(client):
    await make_user("admin@dbit.edu", "ossc")
    o = await sign_in(client, "admin@dbit.edu")
    await o.patch(f"{API}/admin/categories/phone", json={"active": False})
    r = await o.post(f"{API}/admin/categories", json={"code": "glass", "letter": "T", "nameEn": "Glass", "nameHi": "काँच"})
    assert r.status_code == 409  # T belonged to Phone, even though Phone is inactive
    r = await o.post(f"{API}/admin/categories", json={"code": "glass", "letter": "G", "nameEn": "Glass", "nameHi": "काँच",
                                                       "subtypesEn": ["Window pane"], "subtypesHi": ["खिड़की का शीशा"]})
    assert r.status_code == 204
    assert (await o.post(f"{API}/admin/buildings", json={
        "code": "INC", "nameEn": "Incubation Centre", "nameHi": "इनक्यूबेशन केंद्र", "floors": ["Ground"],
        "departments": ["Startup Lab", "Mentor Room"]})).status_code == 204
    cats = (await client.get(f"{API}/catalogs")).json()
    codes = {c["code"] for c in cats["categories"]}
    assert "glass" in codes and "phone" not in codes
    inc = next(b for b in cats["buildings"] if b["code"] == "INC")
    assert inc["departments"] == ["Startup Lab", "Mentor Room"]
