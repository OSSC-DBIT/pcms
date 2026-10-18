from datetime import timedelta

from sqlalchemy import select, update

from app import providers
from app.config import get_settings
from app.db import sessionmaker
from app.models import Assignment, DeliveryAttempt, Outbox, Ticket
from app.security.sessions import now
from app.services import outbox, scheduler
from tests.factories import API, make_user, make_worker, new_client, sign_in, ticket_body

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


async def _dispatched(client, channel="whatsapp"):
    providers.FAKE.sent.clear()
    providers.FAKE.fail_next.clear()
    await make_user("DB2101", "faculty")
    await make_user("DB0001", "facility_manager")
    fac = await sign_in(client, "DB2101")
    tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
    mc = new_client()
    mgr = await sign_in(mc, "DB0001")
    w = await make_worker()
    t = (await mgr.get(f"{API}/tickets/{tid}")).json()
    t = (await mgr.post(f"{API}/tickets/{tid}/transitions", json={"action": "triage", "priority": "P2", "flag": "I", "expectedVersion": t["version"]})).json()
    t = (await mgr.post(f"{API}/tickets/{tid}/assignments", json={"workerIds": [str(w.id)], "leadWorkerId": str(w.id), "channel": channel, "expectedVersion": t["version"]})).json()
    return fac, mgr, mc, t, w


async def test_outbox_sends_job_and_records_provider_id(client):
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        assert await outbox.run_once() >= 1
        jobs = [j for j in providers.FAKE.sent if j.channel == "whatsapp"]
        assert len(jobs) == 1 and jobs[0].to == w.phone_e164 and jobs[0].payload["token"] == t["token"]
        async with sessionmaker()() as db:
            o = await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))
            a = await db.scalar(select(Assignment))
        assert o.state == "sent" and o.provider_id and a.delivery == "sent"
        # Running again sends nothing twice.
        await outbox.run_once()
        assert len([j for j in providers.FAKE.sent if j.channel == "whatsapp"]) == 1
    finally:
        await mc.aclose()


async def test_retry_backoff_then_action_required(client):
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        for _ in range(5):
            providers.FAKE.fail_next.append(providers.SendResult(ok=False, retryable=True, error="timeout"))
        for minutes in (1, 5, 15, 60):
            await outbox.run_once()
            async with sessionmaker()() as db:
                o = await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))
                assert o.state == "pending"
                assert timedelta(minutes=minutes - 0.5) < o.next_attempt_at - now() <= timedelta(minutes=minutes)
                o.next_attempt_at = now()
                await db.commit()
        await outbox.run_once()
        async with sessionmaker()() as db:
            o = await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))
            attempts = (await db.scalars(select(DeliveryAttempt))).all()
            a = await db.scalar(select(Assignment))
        assert o.state == "action_required" and len(attempts) == 5 and a.delivery == "failed"
    finally:
        await mc.aclose()


async def test_stuck_whatsapp_job_is_not_resent_blindly(client):
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        async with sessionmaker()() as db:
            await db.execute(update(Outbox).where(Outbox.channel == "whatsapp").values(state="sending", locked_until=now() - timedelta(minutes=1)))
            await db.commit()
        await outbox.recover_stuck()
        async with sessionmaker()() as db:
            assert (await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))).state == "action_required"
    finally:
        await mc.aclose()


async def test_reassignment_expires_old_job_message(client):
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        aid = t["assignments"][0]["id"]
        await mgr.post(f"{API}/tickets/{t['id']}/assignments/{aid}/release", json={"reason": "Sick", "expectedVersion": t["version"]})
        await outbox.run_once()
        assert not [j for j in providers.FAKE.sent if j.channel == "whatsapp"]
        async with sessionmaker()() as db:
            assert (await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))).state == "expired"
    finally:
        await mc.aclose()


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


async def test_delivered_and_read_are_not_acceptance_but_accept_button_is(client, monkeypatch):
    _twilio(monkeypatch)
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        await outbox.run_once()
        async with sessionmaker()() as db:
            sid = (await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))).provider_id
        for st in ("delivered", "read"):
            p = {"MessageSid": sid, "MessageStatus": st}
            await client.post("/webhooks/twilio/status", data=p, headers=_signed("/webhooks/twilio/status", p))
        tk = (await mgr.get(f"{API}/tickets/{t['id']}")).json()
        assert tk["status"] == "Assigned" and tk["assignments"][0]["delivery"] == "read" and not tk["assignments"][0]["accepted"]

        # A button tap from a different phone is ignored.
        spoof = {"MessageSid": "SMin1", "From": "whatsapp:+919999999999", "ButtonPayload": "accept", "OriginalRepliedMessageSid": sid}
        await client.post("/webhooks/twilio", data=spoof, headers=_signed("/webhooks/twilio", spoof))
        assert (await mgr.get(f"{API}/tickets/{t['id']}")).json()["status"] == "Assigned"

        tap = {"MessageSid": "SMin2", "From": f"whatsapp:{w.phone_e164}", "ButtonPayload": "accept", "ButtonText": "Accept", "OriginalRepliedMessageSid": sid}
        for _ in range(2):  # duplicate webhook delivery
            r = await client.post("/webhooks/twilio", data=tap, headers=_signed("/webhooks/twilio", tap))
            assert r.status_code == 200
        tk = (await mgr.get(f"{API}/tickets/{t['id']}")).json()
        assert tk["status"] == "InProgress" and tk["assignments"][0]["accepted"]
        assert sum(1 for e in tk["events"] if e["action"] == "The worker accepted the job") == 1
    finally:
        await mc.aclose()


async def test_no_accept_triggers_sms_fallback_and_manager_alert(client):
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        async with sessionmaker()() as db:
            await db.execute(update(Assignment).values(ack_due_at=now() - timedelta(minutes=1)))
            await db.commit()
        assert await scheduler.acceptance_fallbacks() == 1
        assert await scheduler.acceptance_fallbacks() == 0  # once only
        await outbox.run_once()
        sms = [j for j in providers.FAKE.sent if j.channel == "sms"]
        assert len(sms) == 1 and t["token"] in providers.sms_text(sms[0].payload)
        assert providers.sms_text(sms[0].payload).isascii()
        tk = (await mgr.get(f"{API}/tickets/{t['id']}")).json()
        assert any(e["action"] == "Acceptance overdue" for e in tk["events"])
    finally:
        await mc.aclose()


async def test_messaging_off_puts_jobs_in_action_required(client, monkeypatch):
    fac, mgr, mc, t, w = await _dispatched(client)
    try:
        monkeypatch.setattr(get_settings(), "messaging_provider", "none")
        await outbox.run_once()
        async with sessionmaker()() as db:
            o = await db.scalar(select(Outbox).where(Outbox.channel == "whatsapp"))
        assert o.state == "action_required" and "call" in o.last_error
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
