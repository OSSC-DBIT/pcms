"""Lifecycle, manual worker coordination and the spending workflow.

Facility managers contact workers directly. There is no worker directory, no
dispatch message and no acceptance step; the manager records the worker name
and moves the ticket through the normal state machine.
"""

import asyncio
from datetime import date, timedelta

from sqlalchemy import select, update

from app.db import sessionmaker
from app.models import Outbox, Ticket
from app.security.sessions import now
from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _setup(client):
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager One")
    await make_user("management@dbit.edu", "management", "Principal Office")
    fac = await sign_in(client, "faculty@dbit.edu")
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    mgr_client = new_client()
    mgr = await sign_in(mgr_client, "manager@dbit.edu")
    return fac, mgr, mgr_client, t["id"]


async def _get(s, tid):
    return (await s.get(f"{API}/tickets/{tid}")).json()


async def _tr(s, tid, **body):
    v = (await _get(s, tid))["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions", json={"expectedVersion": v, **body})


async def test_full_journey_without_a_worker_directory(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        assert (await _tr(fac, tid, action="triage", priority="P1", flag="I")).status_code == 403
        r = await _tr(mgr, tid, action="triage", priority="P2", flag="I")
        assert r.status_code == 200 and r.json()["status"] == "Triaged"

        r = await _tr(mgr, tid, action="assign", workerName="Ramesh K")
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "Assigned" and t["workerName"] == "Ramesh K"

        # The manager records the worker by hand; nothing is queued for delivery.
        async with sessionmaker()() as db:
            jobs = (await db.scalars(select(Outbox).where(
                Outbox.template.in_(("job_dispatch", "job_fallback"))))).all()
        assert jobs == []

        r = await _tr(mgr, tid, action="start")
        assert r.status_code == 200 and r.json()["status"] == "InProgress"

        assert (await _tr(mgr, tid, action="resolve")).status_code == 400  # note required
        assert (await _tr(mgr, tid, action="resolve", note="Backrests replaced")).json()["status"] == "Resolved"

        ft = await _get(fac, tid)
        assert "assignments" not in ft
        assert ft["workerName"] is None
        assert all(e["actor"] in ("Facilities", "Reporter", "PCMS") for e in ft["events"])
        assert all(e.get("delegatedWorker") is None for e in ft["events"])
        assert all("Ramesh" not in (e["detail"] or "") for e in ft["events"])

        r = await _tr(fac, tid, action="verify")
        assert r.status_code == 200 and r.json()["status"] == "Closed" and r.json()["verifiedByReporter"]

        r = await fac.post(f"{API}/tickets/{tid}/rating", json={"stars": 5, "comment": "Quick and tidy"})
        assert r.status_code == 200, r.text
        assert r.json()["rating"]["stars"] == 5 and r.json()["rating"]["comment"] == "Quick and tidy"
    finally:
        await mc.aclose()


async def test_worker_name_is_staff_only_and_does_not_change_status(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        r = await _tr(mgr, tid, action="triage", priority="P3", flag="I")
        t = (await _tr(mgr, tid, action="assign", workerName="Suresh")).json()
        assert t["status"] == "Assigned"

        r = await _tr(mgr, tid, action="set_worker", workerName="Manju")
        assert r.status_code == 200
        t = r.json()
        assert t["status"] == "Assigned" and t["workerName"] == "Manju"

        r = await _tr(mgr, tid, action="set_worker", workerName="")
        t = r.json()
        assert t["status"] == "Assigned" and t["workerName"] is None

        # The change is only visible to staff.
        assert (await _get(fac, tid))["workerName"] is None
        # Assignment is not possible before triage.
        tid2 = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        assert (await _tr(mgr, tid2, action="assign")).status_code == 409
    finally:
        await mc.aclose()


async def test_resume_and_assessment_need_no_assignment(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        await _tr(mgr, tid, action="triage", priority="P2", flag="C")
        assert (await _tr(mgr, tid, action="resolve", note="Temporary fix")).status_code == 409  # not assigned
        await _tr(mgr, tid, action="assign", workerName="Ramesh K")

        v = (await _get(mgr, tid))["version"]
        r = await mgr.post(f"{API}/tickets/{tid}/assessments", json={
            "assessments": ["parts"], "via": "in_person", "note": "Seat frame is bent", "expectedVersion": v})
        assert r.status_code == 200, r.text

        r = await _tr(mgr, tid, action="hold", reason="Parts", owner="Store", nextAction="Order",
                      reviewDate=(date.today() + timedelta(days=3)).isoformat())
        assert r.json()["status"] == "OnHold"
        r = await _tr(mgr, tid, action="resume")
        assert r.json()["status"] == "Assigned"
        assert r.json()["workerName"] == "Ramesh K"
    finally:
        await mc.aclose()


async def test_stale_version_conflicts_and_invalid_transitions(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        r = await mgr.post(f"{API}/tickets/{tid}/transitions", json={"action": "triage", "priority": "P3", "flag": "I", "expectedVersion": 1})
        assert r.status_code == 200
        stale = await mgr.post(f"{API}/tickets/{tid}/transitions", json={"action": "set_flag", "flag": "C", "expectedVersion": 1})
        assert stale.status_code == 409 and stale.json()["code"] == "stale_version"
        bad = await _tr(mgr, tid, action="resolve", note="x")
        assert bad.status_code == 409 and bad.json()["code"] == "invalid_transition"
        assert (await _tr(fac, tid, action="verify")).status_code == 409
        assert (await _tr(mgr, tid, action="hold", reason="Parts", owner="Store", nextAction="Order")).status_code == 400
        past = (date.today() - timedelta(days=1)).isoformat()
        assert (await _tr(mgr, tid, action="hold", reason="Parts", owner="Store", nextAction="Order", reviewDate=past)).status_code == 400
        ok = await _tr(mgr, tid, action="hold", reason="Parts", owner="Store", nextAction="Order", reviewDate=(date.today() + timedelta(days=3)).isoformat())
        assert ok.json()["status"] == "OnHold" and ok.json()["holdReason"] == "Parts"
    finally:
        await mc.aclose()


async def test_dispute_within_window_reopens_and_after_window_fails(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        await _tr(mgr, tid, action="triage", priority="P3", flag="I")
        await _tr(mgr, tid, action="assign", workerName="Ramesh K")
        await _tr(mgr, tid, action="start")
        await _tr(mgr, tid, action="resolve", note="Done")
        r = await _tr(fac, tid, action="dispute", reason="Still wobbles")
        assert r.status_code == 200 and r.json()["status"] == "Triaged"

        async with sessionmaker()() as db:
            await db.execute(update(Ticket).where(Ticket.id == tid).values(status="Resolved", resolved_at=now() - timedelta(days=8)))
            await db.commit()
        r = await _tr(fac, tid, action="dispute", reason="Again")
        assert r.status_code == 409 and r.json()["code"] == "dispute_window_closed"
    finally:
        await mc.aclose()


async def test_internal_notes_hidden_from_faculty(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        await mgr.post(f"{API}/tickets/{tid}/comments", json={"body": "Vendor quote pending", "internal": True})
        await mgr.post(f"{API}/tickets/{tid}/comments", json={"body": "We will visit tomorrow", "internal": False})
        assert (await fac.post(f"{API}/tickets/{tid}/comments", json={"body": "x", "internal": True})).status_code == 403
        ft = await _get(fac, tid)
        assert [c["body"] for c in ft["comments"]] == ["We will visit tomorrow"]
        assert len((await _get(mgr, tid))["comments"]) == 2
    finally:
        await mc.aclose()


async def _to_awaiting_approval(mgr, tid):
    await _tr(mgr, tid, action="triage", priority="P2", flag="C")
    await _tr(mgr, tid, action="assign", workerName="Ramesh K")
    v = (await _get(mgr, tid))["version"]
    t = (await mgr.post(f"{API}/tickets/{tid}/assessments", json={
        "assessments": ["parts", "expenditure"], "via": "call",
        "note": "HDMI port needs replacement", "expectedVersion": v})).json()
    r = await mgr.post(f"{API}/tickets/{tid}/proposals", json={
        "lines": [{"label": "HDMI port assembly", "paise": 185000}, {"label": "Labour", "paise": 50000}],
        "requestedDate": (date.today() + timedelta(days=3)).isoformat(), "remedy": "Replace port", "expectedVersion": t["version"]})
    assert r.status_code == 200, r.text
    return r.json()


async def test_approval_separation_of_duty_and_concurrency(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        t = await _to_awaiting_approval(mgr, tid)
        p = t["proposal"]
        assert t["status"] == "AwaitingApproval" and p["totalPaise"] == 235000 and p["state"] == "pending"
        assert (await _get(fac, tid))["proposal"] is None  # faculty never see costs

        # The manager cannot approve (no capability), and an approver who requested it cannot either.
        assert (await mgr.post(f"{API}/proposals/{p['id']}/decisions", json={"kind": "approved", "proposalVersion": 1, "ceilingPaise": 235000})).status_code == 403

        async with new_client() as c1, new_client() as c2:
            a1 = await sign_in(c1, "management@dbit.edu")
            await make_user("dean@dbit.edu", "management", "Dean Office")
            a2 = await sign_in(c2, "dean@dbit.edu")
            low = await a1.post(f"{API}/proposals/{p['id']}/decisions", json={"kind": "approved", "proposalVersion": 1, "ceilingPaise": 100})
            assert low.status_code == 400
            r1, r2 = await asyncio.gather(
                a1.post(f"{API}/proposals/{p['id']}/decisions", json={"kind": "approved", "proposalVersion": 1, "ceilingPaise": 250000}),
                a2.post(f"{API}/proposals/{p['id']}/decisions", json={"kind": "rejected", "proposalVersion": 1, "reason": "No budget"}),
            )
            codes = sorted([r1.status_code, r2.status_code])
            assert codes == [200, 409], (r1.text, r2.text)
    finally:
        await mc.aclose()


async def test_rejection_keeps_ticket_on_hold_with_next_action(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        t = await _to_awaiting_approval(mgr, tid)
        async with new_client() as c1:
            a1 = await sign_in(c1, "management@dbit.edu")
            r = await a1.post(f"{API}/proposals/{t['proposal']['id']}/decisions", json={"kind": "rejected", "proposalVersion": 1, "reason": "Use spare from store"})
            t = r.json()
            assert t["status"] == "OnHold" and "Use spare" in t["holdReason"] and t["holdReviewDate"]
        # A new version can be sent after a rejection.
        r = await mgr.post(f"{API}/tickets/{tid}/proposals", json={
            "lines": [{"label": "Cable only", "paise": 40000}], "requestedDate": date.today().isoformat(),
            "remedy": "Cable swap", "expectedVersion": t["version"]})
        assert r.status_code == 200 and r.json()["proposal"]["version"] == 2
    finally:
        await mc.aclose()


async def test_dbit_flow_manual_assignment_then_critical_to_management(client):
    """Faculty reports -> FM accepts -> assigns by hand -> flags Critical -> management decides."""
    fac, mgr, mc, tid = await _setup(client)
    try:
        r = await _tr(mgr, tid, action="triage", priority="P2")  # accept: no flag needed yet
        assert r.status_code == 200 and r.json()["status"] == "Triaged" and r.json()["flag"] is None
        t = (await _tr(mgr, tid, action="assign", workerName="Call Only")).json()
        assert t["status"] == "Assigned", t
        async with sessionmaker()() as db:
            sms = await db.scalar(select(Outbox).where(Outbox.template.in_(("job_dispatch", "job_fallback"))))
        assert sms is None

        r = await mgr.post(f"{API}/tickets/{tid}/proposals", json={"lines": [], "requestedDate": date.today().isoformat(),
                                                                  "remedy": "Ceiling cracked, needs a structural check", "expectedVersion": t["version"]})
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "AwaitingApproval" and t["flag"] == "C" and t["proposal"]["totalPaise"] == 0
        async with new_client() as c:
            m = await sign_in(c, "management@dbit.edu")
            r = await m.post(f"{API}/proposals/{t['proposal']['id']}/decisions", json={"kind": "approved", "proposalVersion": 1})
            assert r.status_code == 200 and r.json()["status"] == "InProgress"
    finally:
        await mc.aclose()


async def test_reject_with_reason_and_postpone_sets_flag(client):
    fac, mgr, mc, tid = await _setup(client)
    try:
        assert (await _tr(mgr, tid, action="reject")).status_code == 400  # reason required
        r = await _tr(mgr, tid, action="reject", reason="Not a facilities issue")
        assert r.json()["status"] == "Rejected"
        tid2 = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
        await _tr(mgr, tid2, action="triage", priority="P4")
        r = await _tr(mgr, tid2, action="hold", reason="Parts after exams", owner="Store", nextAction="Order",
                      reviewDate=(date.today() + timedelta(days=10)).isoformat())
        assert r.json()["status"] == "OnHold" and r.json()["flag"] == "P"
    finally:
        await mc.aclose()
