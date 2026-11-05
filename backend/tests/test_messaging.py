"""Notifications: web push is the only channel (DBIT, 2026-11-04: email and Twilio removed).

Covers the outbox transaction rule, push delivery to every device, dead subscriptions,
retries, the scheduled reminders, and that retired channels are never sent.
"""

from datetime import timedelta

from sqlalchemy import select, update

from app.config import get_settings
from app.db import sessionmaker
from app.models import DeliveryAttempt, Outbox, PushSubscription, Ticket
from app.security.sessions import now
from app.services import outbox, scheduler, webpush
from app.services.webpush import PushResult, generate_vapid_keys
from tests.factories import API, make_user, sign_in, subscribe_push, ticket_body


def _enable_push(monkeypatch, results: dict[str, PushResult] | None = None) -> list[tuple[str, dict]]:
    """Turn push on with a fake push service. Returns the list of (endpoint, payload) sent."""
    pub, priv = generate_vapid_keys()
    monkeypatch.setattr(get_settings(), "vapid_public_key", pub)
    monkeypatch.setattr(get_settings(), "vapid_private_key", priv)
    sent: list[tuple[str, dict]] = []

    async def fake_send(endpoint, p256dh, auth, payload, ttl=86_400):
        sent.append((endpoint, payload))
        return (results or {}).get(endpoint, PushResult(ok=True, status=201))

    monkeypatch.setattr(webpush, "send", fake_send)
    return sent


async def test_rollback_drops_notification_intent(client):
    u = await make_user("faculty@dbit.edu", "faculty")
    await subscribe_push(u)
    fac = await sign_in(client, "faculty@dbit.edu")
    r = await fac.post(f"{API}/tickets", json=ticket_body(title="no"))
    assert r.status_code == 400
    async with sessionmaker()() as db:
        assert (await db.scalars(select(Outbox))).first() is None


async def test_push_goes_to_every_device_and_records_the_attempt(client, monkeypatch):
    sent = _enable_push(monkeypatch)
    u = await make_user("faculty@dbit.edu", "faculty")
    await subscribe_push(u, "https://fcm.googleapis.com/fcm/send/phone")
    await subscribe_push(u, "https://updates.push.services.mozilla.com/wpush/v2/laptop")
    fac = await sign_in(client, "faculty@dbit.edu")
    token = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["token"]

    assert await outbox.run_once() == 1
    assert sorted(e for e, _ in sent) == ["https://fcm.googleapis.com/fcm/send/phone",
                                         "https://updates.push.services.mozilla.com/wpush/v2/laptop"]
    payload = sent[0][1]
    assert payload["title"] == f"Report received: {token}" and payload["tag"] == token
    assert payload["url"].startswith("/t/") and set(payload) == {"title", "body", "url", "tag"}
    async with sessionmaker()() as db:
        o = await db.scalar(select(Outbox))
        assert o.state == "sent" and o.channel == "webpush"
        attempts = (await db.scalars(select(DeliveryAttempt).where(DeliveryAttempt.outbox_id == o.id))).all()
        assert len(attempts) == 1 and attempts[0].ok


async def test_dead_subscriptions_are_removed_and_retries_back_off(client, monkeypatch):
    gone = "https://fcm.googleapis.com/fcm/send/gone"
    flaky = "https://fcm.googleapis.com/fcm/send/flaky"
    _enable_push(monkeypatch, {gone: PushResult(ok=False, gone=True, status=410),
                               flaky: PushResult(ok=False, retryable=True, status=503, error="busy")})
    u = await make_user("faculty@dbit.edu", "faculty")
    await subscribe_push(u, gone)
    await subscribe_push(u, flaky)
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())

    await outbox.run_once()
    async with sessionmaker()() as db:
        endpoints = (await db.scalars(select(PushSubscription.endpoint))).all()
        o = await db.scalar(select(Outbox))
    assert endpoints == [flaky]  # the 410 device was deleted
    assert o.state == "pending" and o.next_attempt_at > now() + timedelta(seconds=30) and "busy" in o.last_error


async def test_a_person_whose_every_device_is_gone_is_not_retried(client, monkeypatch):
    gone = "https://fcm.googleapis.com/fcm/send/gone"
    _enable_push(monkeypatch, {gone: PushResult(ok=False, gone=True, status=404)})
    u = await make_user("faculty@dbit.edu", "faculty")
    await subscribe_push(u, gone)
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())
    await outbox.run_once()
    async with sessionmaker()() as db:
        o = await db.scalar(select(Outbox))
    assert o.state == "expired" and o.last_error == "push subscriptions expired"


async def test_nothing_is_queued_for_people_without_push(client):
    await make_user("faculty@dbit.edu", "faculty")
    await make_user("manager@dbit.edu", "facility_manager")
    fac = await sign_in(client, "faculty@dbit.edu")
    assert (await fac.post(f"{API}/tickets", json=ticket_body())).status_code == 201
    async with sessionmaker()() as db:
        assert (await db.scalars(select(Outbox))).all() == []


async def test_old_email_and_whatsapp_rows_expire_unsent(client, monkeypatch):
    sent = _enable_push(monkeypatch)
    u = await make_user("faculty@dbit.edu", "faculty")
    async with sessionmaker()() as db:
        for ch in ("email", "sms"):
            db.add(Outbox(event_key=f"legacy:{ch}", channel=ch, template="receipt", user_id=u.id, payload={},
                          state="pending", attempts=0, next_attempt_at=now(), acknowledged=False))
        await db.commit()
    assert await outbox.run_once() == 2
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(Outbox))).all()
    assert {o.state for o in rows} == {"expired"} and sent == []
    assert all("no longer sent" in o.last_error for o in rows)


async def test_webhook_routes_are_gone(client):
    for path in ("/webhooks/twilio", "/webhooks/twilio/status"):
        assert (await client.post(path, data={"MessageSid": "SM1"})).status_code == 404


async def test_verification_reminder_once_per_resolution(client):
    u = await make_user("faculty@dbit.edu", "faculty")
    await subscribe_push(u)
    fac = await sign_in(client, "faculty@dbit.edu")
    tid = (await fac.post(f"{API}/tickets", json=ticket_body())).json()["id"]
    async with sessionmaker()() as db:
        await db.execute(update(Ticket).where(Ticket.id == tid).values(status="Resolved", resolved_at=now() - timedelta(days=3)))
        await db.commit()
    await scheduler.verification_reminders()
    await scheduler.verification_reminders()
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(Outbox).where(Outbox.template == "verify_reminder"))).all()
    assert len(rows) == 1 and rows[0].channel == "webpush"
