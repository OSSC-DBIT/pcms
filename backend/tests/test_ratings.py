"""Reporter ratings for closed repairs: permissions, immutability, audit and reports."""

from sqlalchemy import select

from app.db import sessionmaker
from app.models import AuditEvent, Outbox, User
from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _closed_ticket(client, *, stars: int | None = None, comment: str | None = None,
                         reporter_email: str | None = None, manager_email: str | None = None):
    """Run a ticket through the manual flow to Closed, optionally rating it."""
    fac_user = await make_user("DB2101", "faculty", "Reporter")
    await make_user("DB0001", "facility_manager", "Manager One")
    await make_user("DB0002", "management", "Principal Office")
    async with sessionmaker()() as db:
        if reporter_email:
            (await db.get(User, fac_user.id)).email = reporter_email
        if manager_email:
            mgr_user = await db.scalar(select(User).where(User.employee_id == "DB0001"))
            mgr_user.email = manager_email
        await db.commit()

    fac = await sign_in(client, "DB2101")
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    mc = new_client()
    mgr = await sign_in(mc, "DB0001")

    async def tr(s, **body):
        v = (await s.get(f"{API}/tickets/{created['id']}")).json()["version"]
        return await s.post(f"{API}/tickets/{created['id']}/transitions", json={"expectedVersion": v, **body})

    await tr(mgr, action="triage", priority="P2", flag="I")
    await tr(mgr, action="assign", workerName="Ramesh K")
    await tr(mgr, action="start")
    await tr(mgr, action="resolve", note="Fixed")
    await tr(fac, action="verify")
    detail = (await fac.get(f"{API}/tickets/{created['id']}")).json()

    rating = None
    if stars is not None:
        r = await fac.post(f"{API}/tickets/{created['id']}/rating", json={"stars": stars, "comment": comment})
        assert r.status_code == 200, r.text
        detail = r.json()
        rating = detail["rating"]
    return fac, mgr, mc, created["id"], detail, rating


async def test_reporter_rates_a_closed_ticket(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=4, comment="Tidy work")
    try:
        assert detail["status"] == "Closed" and detail["verifiedByReporter"] is True
        assert rating["stars"] == 4 and rating["comment"] == "Tidy work" and rating["createdAt"]
        again = (await fac.get(f"{API}/tickets/{tid}")).json()
        assert again["rating"]["stars"] == 4
    finally:
        await mc.aclose()


async def test_a_second_rating_is_refused(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=3)
    try:
        r = await fac.post(f"{API}/tickets/{tid}/rating", json={"stars": 1, "comment": "Changed my mind"})
        assert r.status_code == 409 and r.json()["code"] == "already_rated"
        assert (await fac.get(f"{API}/tickets/{tid}")).json()["rating"]["stars"] == 3
    finally:
        await mc.aclose()


async def test_resolved_but_not_closed_cannot_be_rated(client):
    await make_user("DB2101", "faculty")
    await make_user("DB0001", "facility_manager")
    fac = await sign_in(client, "DB2101")
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    mc = new_client()
    try:
        mgr = await sign_in(mc, "DB0001")
        async def tr(s, **body):
            v = (await s.get(f"{API}/tickets/{created['id']}")).json()["version"]
            return await s.post(f"{API}/tickets/{created['id']}/transitions", json={"expectedVersion": v, **body})

        await tr(mgr, action="triage", priority="P3", flag="I")
        await tr(mgr, action="assign")
        await tr(mgr, action="resolve", note="Done")
        r = await fac.post(f"{API}/tickets/{created['id']}/rating", json={"stars": 5})
        assert r.status_code == 409 and r.json()["code"] == "invalid_transition"
    finally:
        await mc.aclose()


async def test_other_faculty_get_404_and_staff_get_403(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client)
    try:
        async with new_client() as other:
            await make_user("DB2102", "faculty", "Someone Else")
            s = await sign_in(other, "DB2102")
            assert (await s.post(f"{API}/tickets/{tid}/rating", json={"stars": 1})).status_code == 404

        assert (await mgr.post(f"{API}/tickets/{tid}/rating", json={"stars": 1})).status_code == 403
        async with new_client() as c:
            await sign_in(c, "DB0002")
            assert (await c.post(f"{API}/tickets/{tid}/rating", json={"stars": 1})).status_code == 403
    finally:
        await mc.aclose()


async def test_rating_values_are_validated(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client)
    try:
        for bad in ({"stars": 0}, {"stars": 6}, {"stars": 3, "comment": "x" * 1001}):
            r = await fac.post(f"{API}/tickets/{tid}/rating", json=bad)
            assert r.status_code == 400 and r.json()["code"] == "validation", (bad, r.status_code)
    finally:
        await mc.aclose()


async def test_rating_is_audited_and_public_but_the_comment_is_not_in_audit(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=2, comment="Leaky again",
                                                            manager_email="mgr@example.edu")
    try:
        actions = [e["action"] for e in detail["events"]]
        assert "Rating submitted" in actions

        async with sessionmaker()() as db:
            a = await db.scalar(select(AuditEvent).where(AuditEvent.action == "ticket.rated"))
            low = await db.scalar(select(Outbox).where(Outbox.template == "low_rating"))
        assert a is not None and a.entity_id == str(tid)
        assert a.after == {"stars": 2, "has_comment": True}
        assert "Leaky again" not in str(a.after)
        # The manager is told about a low rating, but the comment stays on the ticket.
        assert low is not None and low.payload["subject"].endswith("low rating (2/5)")
        assert "Leaky again" not in str(low.payload)
    finally:
        await mc.aclose()


async def test_low_rating_notifies_managers(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=1, manager_email="mgr@example.edu")
    try:
        async with sessionmaker()() as db:
            rows = (await db.scalars(select(Outbox).where(Outbox.template == "low_rating"))).all()
        assert len(rows) == 1 and rows[0].channel == "email"
        assert "1/5" in rows[0].payload["subject"]
    finally:
        await mc.aclose()


async def test_high_rating_does_not_alert_managers(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=5, manager_email="mgr@example.edu")
    try:
        async with sessionmaker()() as db:
            rows = (await db.scalars(select(Outbox).where(Outbox.template == "low_rating"))).all()
        assert rows == []
    finally:
        await mc.aclose()


async def test_reports_aggregate_ratings_and_show_low_ones(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=2, comment="Still shaky")
    try:
        async with new_client() as c:
            await make_user("DB2102", "faculty", "Second Reporter")
            s = await sign_in(c, "DB2102")
            created = (await s.post(f"{API}/tickets", json=ticket_body())).json()
            v = (await mgr.get(f"{API}/tickets/{created['id']}")).json()["version"]
            v = (await mgr.post(f"{API}/tickets/{created['id']}/transitions",
                                json={"action": "triage", "priority": "P3", "flag": "I", "expectedVersion": v})).json()["version"]
            v = (await mgr.post(f"{API}/tickets/{created['id']}/transitions",
                                json={"action": "assign", "expectedVersion": v})).json()["version"]
            (await mgr.post(f"{API}/tickets/{created['id']}/transitions",
                            json={"action": "resolve", "note": "Done", "expectedVersion": v}))
            v = (await s.get(f"{API}/tickets/{created['id']}")).json()["version"]
            (await s.post(f"{API}/tickets/{created['id']}/transitions",
                          json={"action": "verify", "expectedVersion": v}))
            r = await s.post(f"{API}/tickets/{created['id']}/rating", json={"stars": 5})
            assert r.status_code == 200, r.text

        report = (await mgr.get(f"{API}/reports")).json()
        ratings = report["ratings"]
        assert ratings["count"] == 2 and ratings["average"] == 3.5
        assert ratings["distribution"] == {"1": 0, "2": 1, "3": 0, "4": 0, "5": 1}
        assert [x["token"] for x in ratings["low"]] == [detail["token"]]
        assert ratings["low"][0]["stars"] == 2 and ratings["low"][0]["comment"] == "Still shaky"
        assert "reporterName" not in ratings["low"][0]
        assert "unaccepted" not in report
    finally:
        await mc.aclose()


async def test_faculty_lists_stay_private_and_have_no_worker_data(client):
    fac, mgr, mc, tid, detail, rating = await _closed_ticket(client, stars=4)
    try:
        mine = (await fac.get(f"{API}/tickets", params={"scope": "mine"})).json()["items"]
        assert mine and "assignments" not in mine[0] and "rating" not in mine[0]
        assert mine[0]["workerName"] is None

        async with new_client() as other:
            await make_user("DB2102", "faculty", "Someone Else")
            s = await sign_in(other, "DB2102")
            assert (await s.get(f"{API}/tickets", params={"scope": "mine"})).json()["items"] == []
            assert (await s.get(f"{API}/tickets/{tid}")).status_code == 404

        staff = (await mgr.get(f"{API}/tickets", params={"scope": "queue"})).json()["items"]
        assert staff[0]["workerName"] == "Ramesh K"
    finally:
        await mc.aclose()
