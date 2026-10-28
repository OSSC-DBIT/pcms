"""Assessment recording, catalog editing, audit paging and report fields.

These endpoints already existed but had no test and, in the assessment case, no UI.
"""

from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def test_assessment_is_recorded_and_shown_but_hidden_from_the_reporter(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    mc = new_client()
    try:
        await make_user("manager@dbit.edu", "facility_manager", "Manager")
        mgr = await sign_in(mc, "manager@dbit.edu")
        v = (await mgr.post(f"{API}/tickets/{t['id']}/transitions",
                            json={"action": "triage", "priority": "P2", "expectedVersion": 1})).json()["version"]
        assigned = (await mgr.post(f"{API}/tickets/{t['id']}/transitions", json={
            "action": "assign", "workerName": "Ramesh K", "expectedVersion": v})).json()

        r = await mgr.post(f"{API}/tickets/{t['id']}/assessments", json={
            "assessments": ["parts", "expenditure"],
            "via": "in_person", "note": "Needs a new seat frame and a vendor visit", "expectedVersion": assigned["version"]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["assessments"] == ["expenditure", "parts"]  # stored sorted and de-duplicated
        assert any(e["action"] == "Assessment recorded" for e in body["events"])

        # The reporter sees the summary field but never the internal note.
        ft = (await fac.get(f"{API}/tickets/{t['id']}")).json()
        assert ft["assessments"] == ["expenditure", "parts"]
        assert all("seat frame" not in (e["detail"] or "") for e in ft["events"])
    finally:
        await mc.aclose()


async def test_assessment_needs_an_assigned_ticket(client):
    """Assessing before a worker is on the job is a 409, not a silent write."""
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    mc = new_client()
    try:
        await make_user("manager@dbit.edu", "facility_manager", "Manager")
        mgr = await sign_in(mc, "manager@dbit.edu")
        r = await mgr.post(f"{API}/tickets/{t['id']}/assessments", json={
            "assessments": ["simple"], "via": "call",
            "note": "Not assigned yet", "expectedVersion": 1})
        assert r.status_code == 409 and r.json()["code"] == "invalid_transition"
    finally:
        await mc.aclose()


async def test_catalogs_hides_retired_but_admin_can_still_see_them(client):
    """A retired type must vanish from the report form yet stay restorable."""
    await make_user("admin@dbit.edu", "ossc", "Super Admin")
    o = await sign_in(client, "admin@dbit.edu")

    active_before = (await client.get(f"{API}/catalogs")).json()
    assert "civil" in {c["code"] for c in active_before["categories"]}

    assert (await o.patch(f"{API}/admin/categories/civil", json={"active": False})).status_code == 204

    active = (await client.get(f"{API}/catalogs")).json()
    assert "civil" not in {c["code"] for c in active["categories"]}

    # The admin view still shows it, flagged inactive, so it can be restored.
    for_admin = (await client.get(f"{API}/catalogs", params={"includeInactive": True})).json()
    retired = next(c for c in for_admin["categories"] if c["code"] == "civil")
    assert retired["active"] is False

    # Every row now carries active, for both kinds.
    assert all("active" in c for c in active["categories"])
    assert all("active" in b for b in active["buildings"])

    assert (await o.patch(f"{API}/admin/categories/civil", json={"active": True})).status_code == 204
    back = (await client.get(f"{API}/catalogs")).json()
    assert "civil" in {c["code"] for c in back["categories"]}


async def test_last_active_category_cannot_be_retired(client):
    from app.db import sessionmaker
    from app.models import Category
    from sqlalchemy import update

    await make_user("admin@dbit.edu", "ossc", "Super Admin")
    o = await sign_in(client, "admin@dbit.edu")
    async with sessionmaker()() as s:
        await s.execute(update(Category).values(active=False).where(Category.code != "civil"))
        await s.commit()
    r = await o.patch(f"{API}/admin/categories/civil", json={"active": False})
    assert r.status_code == 409 and r.json()["code"] == "last_category"


async def test_building_rename_and_retire(client):
    await make_user("admin@dbit.edu", "ossc", "Super Admin")
    o = await sign_in(client, "admin@dbit.edu")
    r = await o.patch(f"{API}/admin/buildings/BLOCK_A", json={"nameEn": "Computing Block", "nameHi": "कंप्यूटिंग ब्लॉक"})
    assert r.status_code == 204
    buildings = (await client.get(f"{API}/catalogs")).json()["buildings"]
    assert next(b for b in buildings if b["code"] == "BLOCK_A")["nameEn"] == "Computing Block"

    assert (await o.patch(f"{API}/admin/buildings/BLOCK_A", json={"active": False})).status_code == 204
    assert "BLOCK_A" not in {b["code"] for b in (await client.get(f"{API}/catalogs")).json()["buildings"]}
    assert "BLOCK_A" in {b["code"] for b in (await client.get(f"{API}/catalogs", params={"includeInactive": True})).json()["buildings"]}

    assert (await o.patch(f"{API}/admin/buildings/nope", json={"nameEn": "Nothing"})).status_code == 404


async def test_report_shows_the_fields_the_dashboard_renders(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    mc = new_client()
    try:
        await make_user("manager@dbit.edu", "facility_manager", "Manager")
        mgr = await sign_in(mc, "manager@dbit.edu")
        await mgr.post(f"{API}/tickets/{t['id']}/transitions",
                       json={"action": "triage", "priority": "P3", "expectedVersion": 1})
        r = (await mgr.get(f"{API}/reports")).json()
        assert r["openByStatus"] == {"Triaged": 1}
        assert r["openByPriority"] == {"P3": 1}
        assert r["ratings"] == {"count": 0, "average": None,
                                "distribution": {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}, "low": []}
        assert r["overdueUpdates"] == 0
        assert r["disputes"] == 0
        assert r["failedNotifications"] == 0
        assert r["triageTime"]["count"] == 1 and r["triageTime"]["medianHours"] is not None
        assert r["resolutionTime"]["count"] == 0 and r["resolutionTime"]["medianHours"] is None
        assert r["approvedPaise"] == 0
        assert r["holdsByReason"] == []
        assert r["days"] == 30 and r["generatedAt"]

        # Filters narrow the same numbers.
        assert (await mgr.get(f"{API}/reports", params={"building": "BLOCK_B"})).json()["openByStatus"] == {}
        assert (await mgr.get(f"{API}/reports", params={"category": "civil"})).json()["openByStatus"] == {"Triaged": 1}
    finally:
        await mc.aclose()


async def test_audit_log_cursors_backwards(client):
    """The audit screen pages with beforeId, so rows must not repeat or vanish."""
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    fac = await sign_in(client, "faculty@dbit.edu")
    for i in range(5):
        await fac.post(f"{API}/tickets", json=ticket_body(title=f"Broken chair {i}"))

    await make_user("admin@dbit.edu", "ossc", "Super Admin")
    o = await sign_in(new_client(), "admin@dbit.edu")

    page1 = (await o.get(f"{API}/admin/audit", params={"limit": 5})).json()
    assert len(page1) == 5
    ids = [e["id"] for e in page1]
    assert ids == sorted(ids, reverse=True)

    page2 = (await o.get(f"{API}/admin/audit", params={"limit": 5, "beforeId": ids[-1]})).json()
    assert page2 and all(e["id"] < ids[-1] for e in page2)
    assert not ({e["id"] for e in page1} & {e["id"] for e in page2})

    # Every entry carries the fields the viewer renders.
    assert all({"at", "actorLabel", "action", "entityType", "entityId"} <= set(e) for e in page1)
