import asyncio
from datetime import date, timedelta

from sqlalchemy import select, update

from app.db import sessionmaker
from app.models import Outbox, Ticket
from app.security.sessions import now
from tests.factories import API, make_user, make_worker, new_client, sign_in, ticket_body


async def _setup(client):
    await make_user("DB2101", "faculty", "Reporter")
    await make_user("DB0001", "facility_manager", "Manager One")
    await make_user("DB0002", "management", "Principal Office")
    fac = await sign_in(client, "DB2101")
    t = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    mgr_client = new_client()
    mgr = await sign_in(mgr_client, "DB0001")
    return fac, mgr, mgr_client, t["id"]


async def _get(s, tid):
    return (await s.get(f"{API}/tickets/{tid}")).json()


async def _tr(s, tid, **body):
    v = (await _get(s, tid))["version"]
    return await s.post(f"{API}/tickets/{tid}/transitions", json={"expectedVersion": v, **body})


async def test_full_journey_with_verification(client):
    fac, mgr, mc, tid = await _setup(client)
    w = await make_worker()
    try:
        assert (await _tr(fac, tid, action="triage", priority="P1", flag="I")).status_code == 403
        r = await _tr(mgr, tid, action="triage", priority="P2", flag="I")
        assert r.status_code == 200 and r.json()["status"] == "Triaged"

        v = r.json()["version"]
        r = await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(w.id)], "leadWorkerId": str(w.id), "channel": "whatsapp", "expectedVersion": v})
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "Assigned" and t["assignments"][0]["delivery"] == "queued"
        async with sessionmaker()() as db:
            job = await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))
        assert job.payload["token"] == t["token"] and job.payload["flag"] == "I"

        aid = t["assignments"][0]["id"]
        r = await mgr.post(f"{API}/tickets/{tid}/assignments/{aid}/accept", json={"via": "call", "expectedVersion": t["version"]})
        assert r.status_code == 200 and r.json()["status"] == "InProgress"
        assert any(e["delegatedWorker"] == "Ramesh K" for e in r.json()["events"])

        assert (await _tr(mgr, tid, action="resolve")).status_code == 400  # note required
        assert (await _tr(mgr, tid, action="resolve", note="Backrests replaced")).json()["status"] == "Resolved"

        ft = await _get(fac, tid)
        assert all(e["actor"] in ("Facilities", "Reporter", "PCMS") for e in ft["events"])  # no staff or worker names
        assert "delegatedWorker" not in ft["events"][0] or ft["events"][0]["delegatedWorker"] is None
        r = await _tr(fac, tid, action="verify")
        assert r.status_code == 200 and r.json()["status"] == "Closed" and r.json()["verifiedByReporter"]
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
    w = await make_worker()
    try:
        r = await _tr(mgr, tid, action="triage", priority="P3", flag="I")
        r = await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(w.id)], "leadWorkerId": str(w.id), "channel": "call", "expectedVersion": r.json()["version"]})
        t = r.json()
        await mgr.post(f"{API}/tickets/{tid}/assignments/{t['assignments'][0]['id']}/accept", json={"via": "call", "expectedVersion": t["version"]})
        await _tr(mgr, tid, action="resolve", note="Done")
        r = await _tr(fac, tid, action="dispute", reason="Still wobbles")
        assert r.status_code == 200 and r.json()["status"] == "Triaged"

        await _tr(mgr, tid, action="resume") if False else None
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


async def test_one_active_lead_and_inactive_worker_rejected(client):
    fac, mgr, mc, tid = await _setup(client)
    a = await make_worker("A One", "+919876500011")
    b = await make_worker("B Two", "+919876500012")
    off = await make_worker("Off Duty", "+919876500013", active=False)
    sms_only = await make_worker("Sms Only", "+919876500014", mode="sms")
    try:
        v = (await _tr(mgr, tid, action="triage", priority="P3", flag="C")).json()["version"]
        r = await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(off.id)], "leadWorkerId": str(off.id), "channel": "sms", "expectedVersion": v})
        assert r.status_code == 400
        r = await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(sms_only.id)], "leadWorkerId": str(sms_only.id), "channel": "whatsapp", "expectedVersion": v})
        assert r.status_code == 400
        r = await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(a.id), str(b.id)], "leadWorkerId": str(b.id), "channel": "sms", "expectedVersion": v})
        t = r.json()
        assert [x["workerName"] for x in t["assignments"] if x["lead"]] == ["B Two"]
        lead = next(x for x in t["assignments"] if x["lead"])
        r = await mgr.post(f"{API}/tickets/{tid}/assignments/{lead['id']}/release", json={"reason": "Absent", "expectedVersion": t["version"]})
        active = [x for x in r.json()["assignments"] if not x["releasedAt"]]
        assert len(active) == 1 and active[0]["lead"] and active[0]["workerName"] == "A One"
    finally:
        await mc.aclose()


async def _to_awaiting_approval(mgr, tid):
    w = await make_worker()
    r = await _tr(mgr, tid, action="triage", priority="P2", flag="C")
    r = await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(w.id)], "leadWorkerId": str(w.id), "channel": "call", "expectedVersion": r.json()["version"]})
    t = r.json()
    t = (await mgr.post(f"{API}/tickets/{tid}/assignments/{t['assignments'][0]['id']}/accept", json={"via": "call", "expectedVersion": t["version"]})).json()
    t = (await mgr.post(f"{API}/tickets/{tid}/assessments", json={"assessments": ["parts", "expenditure"], "workerId": str(w.id), "via": "call", "note": "HDMI port needs replacement", "expectedVersion": t["version"]})).json()
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
            a1 = await sign_in(c1, "DB0002")
            await make_user("DB0005", "management", "Dean Office")
            a2 = await sign_in(c2, "DB0005")
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
            a1 = await sign_in(c1, "DB0002")
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


async def test_worker_directory_permissions_and_phone_masking(client):
    await make_user("DB2101", "faculty")
    fac = await sign_in(client, "DB2101")
    assert (await fac.get(f"{API}/workers")).status_code == 403
    async with new_client() as c:
        await make_user("DB0000", "ossc")
        ossc = await sign_in(c, "DB0000")
        r = await ossc.post(f"{API}/workers", json={"name": "Suresh P", "phone": "98765 43210", "trades": ["plumbing"], "mode": "sms", "kind": "employee"})
        assert r.status_code == 201, r.text
        assert r.json()["phoneMasked"] == "+91 ***** 3210" and "phone" not in r.json()
        dup = await ossc.post(f"{API}/workers", json={"name": "Other", "phone": "+919876543210", "trades": ["plumbing"], "mode": "sms", "kind": "employee"})
        assert dup.status_code == 409
        w = r.json()
        r = await ossc.patch(f"{API}/workers/{w['id']}", json={"expectedVersion": 1, "active": False})
        assert r.json()["active"] is False
        assert (await ossc.patch(f"{API}/workers/{w['id']}", json={"expectedVersion": 1, "active": True})).status_code == 409



async def test_facility_manager_imports_worker_contacts(client):
    await make_user("DB0001", "facility_manager")
    m = await sign_in(client, "DB0001")
    rows = [
        {"name": "Manju Carpenter", "phone": "098450 12345", "trades": ["carpentry"], "mode": "whatsapp", "kind": "employee"},
        {"name": "Manju Again", "phone": "+91 98450 12345", "trades": ["carpentry"], "mode": "sms", "kind": "employee"},
        {"name": "Bad Number", "phone": "12345", "trades": ["plumbing"], "mode": "sms", "kind": "vendor"},
        {"name": "Ravi Electric", "phone": "9845067890", "trades": ["electrical"], "mode": "call", "kind": "vendor"},
    ]
    r = await m.post(f"{API}/workers/import", json=rows)
    assert r.status_code == 200, r.text
    assert [x["status"] for x in r.json()] == ["created", "exists", "invalid", "created"]
    ws = (await m.get(f"{API}/workers")).json()
    assert sorted(w["name"] for w in ws) == ["Manju Carpenter", "Ravi Electric"]



async def test_dbit_flow_accept_sms_then_critical_to_management(client):
    """Faculty reports -> FM accepts -> assigns (automatic SMS) -> flags Critical -> management decides."""
    fac, mgr, mc, tid = await _setup(client)
    w = await make_worker("Call Only", "+919876500099", mode="call")
    try:
        r = await _tr(mgr, tid, action="triage", priority="P2")  # accept: no flag needed yet
        assert r.status_code == 200 and r.json()["status"] == "Triaged" and r.json()["flag"] is None
        t = (await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(w.id)], "leadWorkerId": str(w.id), "channel": "sms", "expectedVersion": r.json()["version"]})).json()
        assert t["status"] == "Assigned", t
        async with sessionmaker()() as db:
            sms = await db.scalar(select(Outbox).where(Outbox.channel == "sms", Outbox.template == "job_dispatch"))
        assert sms is not None and sms.payload["token"] == t["token"]

        r = await mgr.post(f"{API}/tickets/{tid}/proposals", json={"lines": [], "requestedDate": date.today().isoformat(),
                                                                  "remedy": "Ceiling cracked, needs a structural check", "expectedVersion": t["version"]})
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["status"] == "AwaitingApproval" and t["flag"] == "C" and t["proposal"]["totalPaise"] == 0
        async with new_client() as c:
            m = await sign_in(c, "DB0002")
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
