"""Legacy Twilio delivery, webhook signatures and scheduled reminders.

Worker dispatch is retired, but messages sent before the cutover must still
drain and their Accept buttons must still work. Everything else here covers
the pieces that remain in use: outbox rollback and verification reminders.
"""

from datetime import timedelta

from sqlalchemy import select, update

from app.config import get_settings
from app.db import sessionmaker
from app.models import Assignment, Outbox, Ticket, User, Worker
from app.security.sessions import now
from app.services import outbox, scheduler
from tests.factories import API, make_user, new_client, sign_in, ticket_body

AUTH = "test-twilio-auth-token"
PUBLIC = "https://pcms-hooks.example.org"


def _twilio(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "twilio_auth_token", AUTH)
    monkeypatch.setattr(s, "twilio_validate_signature", True)
    monkeypatch.setattr(s, "public_base_url", PUBLIC)


def _signed(path: str, params: dict) -> dict:
    from twilio.request_validator import RequestValidator

    return {"X-Twilio-Signature": RequestValidator(AUTH).compute_signature(PUBLIC + path, params)}


async def test_rollback_drops_notification_intent(client):
    await make_user("DB2101", "faculty")
    fac = await sign_in(client, "DB2101")
    r = await fac.post(f"{API}/tickets", json=ticket_body(title="no"))
    assert r.status_code == 400
    async with sessionmaker()() as db:
        assert (await db.scalars(select(Outbox))).first() is None


async def test_webhook_signature_required(client, monkeypatch):
    _twilio(monkeypatch)
    params = {"MessageSid": "SM1", "MessageStatus": "delivered"}
    assert (await client.post("/webhooks/twilio/status", data=params)).status_code == 403
    bad = {"X-Twilio-Signature": "AAAA"}
    assert (await client.post("/webhooks/twilio/status", data=params, headers=bad)).status_code == 403
    ok = await client.post("/webhooks/twilio/status", data=params, headers=_signed("/webhooks/twilio/status", params))
    assert ok.status_code == 200 and ok.headers["content-type"].startswith("text/xml")


async def test_legacy_accept_button_still_works(client, monkeypatch):
    """A job sent before the cutover can still be accepted from WhatsApp."""
    _twilio(monkeypatch)
    await make_user("DB2101", "faculty")
    await make_user("DB0001", "facility_manager")
    fac = await sign_in(client, "DB2101")
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    mc = new_client()
    try:
        mgr = await sign_in(mc, "DB0001")
        t = (await mgr.post(f"{API}/tickets/{created['id']}/transitions",
                            json={"action": "triage", "priority": "P2", "flag": "I", "expectedVersion": 1})).json()
        t = (await mgr.post(f"{API}/tickets/{created['id']}/transitions",
                            json={"action": "assign", "workerName": "Legacy Worker", "expectedVersion": t["version"]})).json()
        async with sessionmaker()() as db:
            manager_id = await db.scalar(select(User.id).where(User.employee_id == "DB0001"))
            w = Worker(name="Legacy Worker", phone_e164="+919876500077", area="Campus", language="kn",
                       mode="whatsapp", kind="employee", active=True, version=1)
            db.add(w)
            await db.flush()
            a = Assignment(ticket_id=t["id"], worker_id=w.id, lead=True, channel="whatsapp", delivery="sent",
                           assigned_by=manager_id, ack_due_at=now() + timedelta(minutes=30))
            db.add(a)
            await db.flush()
            db.add(Outbox(event_key=f"job_dispatch:{a.id}:whatsapp", channel="whatsapp", template="job_dispatch",
                          worker_id=w.id, ticket_id=t["id"], assignment_id=a.id, payload={"token": t["token"]},
                          state="sent", attempts=1, next_attempt_at=now(), acknowledged=False, provider_id="SMlegacy1"))
            await db.commit()
            aid, phone = a.id, w.phone_e164

        params = {"MessageSid": "SMin-legacy", "From": f"whatsapp:{phone}", "ButtonPayload": "accept",
                  "ButtonText": "Accept", "OriginalRepliedMessageSid": "SMlegacy1"}
        for _ in range(2):  # duplicate webhook delivery is harmless
            r = await client.post("/webhooks/twilio", data=params, headers=_signed("/webhooks/twilio", params))
            assert r.status_code == 200
        tk = (await mgr.get(f"{API}/tickets/{t['id']}")).json()
        assert tk["status"] == "InProgress"
        async with sessionmaker()() as db:
            assert (await db.get(Assignment, aid)).accepted_at is not None
    finally:
        await mc.aclose()


async def test_verification_reminder_once_per_resolution(client):
    u = await make_user("DB2101", "faculty")
    async with sessionmaker()() as db:
        (await db.get(type(u), u.id)).email = "f@example.edu"
        await db.commit()
    fac = await sign_in(client, "DB2101")
    tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
    async with sessionmaker()() as db:
        await db.execute(update(Ticket).where(Ticket.id == tid).values(status="Resolved", resolved_at=now() - timedelta(days=3)))
        await db.commit()
    await scheduler.verification_reminders()
    await scheduler.verification_reminders()
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(Outbox).where(Outbox.template == "verify_reminder"))).all()
    assert len(rows) == 1
