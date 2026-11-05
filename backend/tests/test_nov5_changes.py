"""DBIT changes of 2026-11-05.

  - No building has a 3rd floor any more.
  - Once spending on a Critical ticket is approved, the decision is final: the facility
    manager can only finish the work. Sending it as Critical again or postponing it is refused.
"""

from datetime import date, timedelta

from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _get(s, tid):
    return (await s.get(f"{API}/tickets/{tid}")).json()


async def _tr(s, tid, **body):
    v = (await _get(s, tid))["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions", json={"expectedVersion": v, **body})


async def _propose(mgr, tid, remedy="Replace the pump"):
    v = (await _get(mgr, tid))["version"]
    return await mgr.post(f"{API}/tickets/{tid}/proposals", json={
        "lines": [], "requestedDate": date.today().isoformat(), "remedy": remedy, "expectedVersion": v})


async def test_no_building_has_a_third_floor(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    buildings = (await fac.get(f"{API}/catalogs")).json()["buildings"]
    assert buildings
    for b in buildings:
        assert "3" not in b["floors"], b["code"]
    block_a = next(b for b in buildings if b["code"] == "BLOCK_A")
    assert block_a["floors"] == ["Ground", "1", "2", "Terrace"]
    r = await fac.post(f"{API}/tickets", json=ticket_body(location={
        "building": "BLOCK_A", "department": "Computer Science and Engineering (CSE)", "floor": "3", "room": "301"}))
    assert r.status_code == 400, r.text


async def test_approved_spending_cannot_be_sent_again_or_postponed(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("principal@dbit.edu", "principal", "Principal")
    fac = await sign_in(client, "faculty@dbit.edu")
    mc, pc = new_client(), new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        prin = await sign_in(pc, "principal@dbit.edu")
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        assert (await _tr(mgr, tid, action="triage")).status_code == 200
        assert (await _tr(mgr, tid, action="assign")).status_code == 200
        r = await _propose(mgr, tid)
        assert r.status_code == 200, r.text
        p = r.json()["proposal"]
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions", json={"kind": "approved", "proposalVersion": 1})
        assert r.status_code == 200 and r.json()["status"] == "InProgress"

        again = await _propose(mgr, tid, remedy="More money")
        assert again.status_code == 409 and again.json()["code"] == "spending_approved", again.text
        hold = await _tr(mgr, tid, action="hold", reason="Later", owner="Manager", nextAction="Review",
                         reviewDate=(date.today() + timedelta(days=3)).isoformat())
        assert hold.status_code == 409 and hold.json()["code"] == "spending_approved", hold.text

        t = await _get(mgr, tid)
        assert t["status"] == "InProgress" and t["flag"] == "C" and t["proposal"]["version"] == 1
        done = await _tr(mgr, tid, action="resolve", note="Pump replaced")
        assert done.status_code == 200 and done.json()["status"] == "Resolved"
    finally:
        await mc.aclose()
        await pc.aclose()


async def test_rejected_spending_can_still_be_sent_again(client):
    """Only an approval is final; after a rejection the manager may send a revised request."""
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager")
    await make_user("principal@dbit.edu", "principal", "Principal")
    fac = await sign_in(client, "faculty@dbit.edu")
    mc, pc = new_client(), new_client()
    try:
        mgr = await sign_in(mc, "manager@dbit.edu")
        prin = await sign_in(pc, "principal@dbit.edu")
        tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        await _tr(mgr, tid, action="triage")
        await _tr(mgr, tid, action="assign")
        p = (await _propose(mgr, tid)).json()["proposal"]
        r = await prin.post(f"{API}/proposals/{p['id']}/decisions",
                            json={"kind": "rejected", "proposalVersion": 1, "reason": "Use the spare"})
        assert r.status_code == 200 and r.json()["status"] == "OnHold"
        again = await _propose(mgr, tid, remedy="Spare is broken, replace")
        assert again.status_code == 200 and again.json()["proposal"]["version"] == 2
    finally:
        await mc.aclose()
        await pc.aclose()
