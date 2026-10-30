"""Reports: shared department filter validation, the annual overview and the three export formats.

Every test sees only its own data (the suite truncates tables per test), so
report counts and the `years` list can be asserted exactly.
"""

from datetime import datetime
from zoneinfo import ZoneInfo
from sqlalchemy import update

from app.config import get_settings
from app.db import sessionmaker
from app.models import Ticket
from tests.factories import API, make_user, new_client, sign_in, ticket_body

DEPT = "Computer Science and Engineering (CSE)"
OTHER_DEPT = "Cybersecurity and IoT"


def ist_year() -> int:
    return datetime.now(ZoneInfo(get_settings().timezone)).year


def ist_time(month: int, day: int, hour: int = 3) -> str:
    """A pinned instant, given in campus-local terms with an explicit offset."""
    return f"{ist_year():04d}-{month:02d}-{day:02d}T{hour:02d}:30:00+05:30"


async def move_ticket(token: str, **over) -> None:
    """Rewrite the history of a ticket after creation (month bucketing tests)."""
    stamps = ("created_at", "resolved_at", "closed_at", "next_update_due")
    over = {k: (datetime.fromisoformat(v) if k in stamps else v) for k, v in over.items()}
    async with sessionmaker()() as s:
        await s.execute(update(Ticket).where(Ticket.token == token).values(**over))
        await s.commit()


async def staff_signups():
    """A reporter and a manager, each with its own client. Tests close both clients."""
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    fac_c, mgr_c = new_client(), new_client()
    fac = await sign_in(fac_c, "faculty@dbit.edu")
    mgr = await sign_in(mgr_c, "manager@dbit.edu")
    return fac, fac_c, mgr, mgr_c


async def test_department_filter_needs_a_building_and_must_belong_to_it(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    mgr = await sign_in(new_client(), "manager@dbit.edu")

    r = await mgr.get(f"{API}/reports", params={"department": DEPT})
    assert r.status_code == 400 and r.json()["code"] == "validation"
    r = await mgr.get(f"{API}/reports", params={"building": "BLOCK_B", "department": DEPT})
    assert r.status_code == 400
    r = await mgr.get(f"{API}/reports", params={"building": "BLOCK_A", "department": "Not a department"})
    assert r.status_code == 400
    r = await mgr.get(f"{API}/reports/annual", params={"department": DEPT})
    assert r.status_code == 400
    r = await mgr.get(f"{API}/reports/tickets.csv", params={"department": DEPT})
    assert r.status_code == 400
    r = await mgr.get(f"{API}/reports/export.xlsx", params={"department": DEPT})
    assert r.status_code == 400
    r = await mgr.get(f"{API}/reports/export.pdf", params={"department": DEPT})
    assert r.status_code == 400

    ok = await mgr.get(f"{API}/reports", params={"building": "BLOCK_A", "department": DEPT})
    assert ok.status_code == 200 and ok.json()["openByStatus"] == {"Submitted": 1}


async def test_annual_overview_buckets_local_months(client):
    fac, fac_c, mgr, mgr_c = await staff_signups()
    try:
        t1 = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
        t2 = (await fac.post(f"{API}/tickets", json=ticket_body(title="Fan is noisy", room="205"))).json()
        t3 = (await fac.post(f"{API}/tickets", json=ticket_body(title="Prior year tap", room="206"))).json()
        prior = ist_year() - 1

        # t1: raised this March, fixed this June. t2: raised this August and overdue.
        await move_ticket(t1["token"], created_at=ist_time(3, 1), resolved_at=ist_time(6, 10, 12),
                          status="Resolved")
        await move_ticket(t2["token"], created_at=ist_time(8, 5), status="Triaged",
                          next_update_due=f"{prior}-01-01T00:00:00+05:30", priority="P4")
        await move_ticket(t3["token"], created_at=f"{prior}-03-02T03:00:00+05:30",
                          resolved_at=f"{prior}-03-05T03:00:00+05:30",
                          closed_at=f"{prior}-03-06T03:00:00+05:30", status="Resolved")

        r = await mgr.get(f"{API}/reports/annual")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["years"] == [prior, ist_year()]
        assert body["year"] == ist_year()  # defaults to the latest year with tickets
        assert len(body["months"]) == 12

        march, june, august = body["months"][2], body["months"][5], body["months"][7]
        assert march["created"] == 1 and march["avgResolutionHours"] is None
        assert june["resolved"] == 1 and june["avgResolutionHours"] is not None and june["avgResolutionHours"] > 0
        assert august["created"] == 1 and august["pending"] == 1 and august["overdue"] == 1
        assert sum(m["created"] for m in body["months"]) == 2  # t3 was moved to the prior year
        assert sum(m["overdue"] for m in body["months"]) == 1

        r = await mgr.get(f"{API}/reports/annual", params={"year": prior})
        body = r.json()
        assert body["year"] == prior and body["months"][2]["created"] == 1 and body["months"][2]["resolved"] == 1
        assert body["previousCreated"] == [0] * 12 and body["previousResolved"] == [0] * 12

        # Place and type scopes narrow the same chart.
        r = await mgr.get(f"{API}/reports/annual", params={"building": "BLOCK_B"})
        assert r.json()["months"][2]["created"] == 0
        r = await mgr.get(f"{API}/reports/annual", params={"building": "BLOCK_A", "department": DEPT})
        assert r.json()["months"][2]["created"] == 1
    finally:
        await fac_c.aclose()
        await mgr_c.aclose()


async def test_department_scope_works_on_the_annual_chart_and_exports(client):
    fac, fac_c, mgr, mgr_c = await staff_signups()
    try:
        t1 = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
        t2 = (await fac.post(f"{API}/tickets", json=ticket_body(
            title="Elsewhere",
            location={"building": "BLOCK_B", "department": OTHER_DEPT, "floor": "1", "room": "301"},
        ))).json()

        r = await mgr.get(f"{API}/reports/annual", params={"building": "BLOCK_A", "department": DEPT})
        assert r.status_code == 200 and sum(m["created"] for m in r.json()["months"]) == 1

        csv = await mgr.get(f"{API}/reports/tickets.csv", params={"building": "BLOCK_A", "department": DEPT})
        assert csv.status_code == 200
        lines = [line for line in csv.text.splitlines() if line]
        assert "department" in lines[0] and "rating" in lines[0] and "subtype" in lines[0]
        assert t1["token"] in lines[1]
        assert len(lines) == 2 and t2["token"] not in csv.text

        wide = await mgr.get(f"{API}/reports/tickets.csv", params={"days": 7})
        assert t1["token"] in wide.text and t2["token"] in wide.text

        xlsx = await mgr.get(f"{API}/reports/export.xlsx", params={"building": "BLOCK_A", "department": DEPT})
        assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"
        assert "PCMS_Report_" in xlsx.headers["content-disposition"]

        pdf = await mgr.get(f"{API}/reports/export.pdf")
        assert pdf.status_code == 200 and pdf.content[:8] == b"%PDF-1.4"
        assert b"%%EOF" in pdf.content and pdf.headers["content-type"].startswith("application/pdf")

        filtered = await mgr.get(f"{API}/reports/export.pdf", params={"building": "BLOCK_B", "department": OTHER_DEPT})
        assert filtered.status_code == 200 and filtered.content[:8] == b"%PDF-1.4"
    finally:
        await fac_c.aclose()
        await mgr_c.aclose()


async def test_exports_reporting_needs_queue_view(client):
    """A faculty reporter gets a 404-style refusal on the reports page and downloads."""
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    for path, params in ((f"{API}/reports", {}), (f"{API}/reports/annual", {}), (f"{API}/reports/tickets.csv", {}),
                         (f"{API}/reports/export.xlsx", {}), (f"{API}/reports/export.pdf", {})):
        r = await fac.get(path, params=params)
        assert r.status_code == 403, f"{path} leaked to a reporter"
