from sqlalchemy import func, select

from app.config import get_settings
from app.db import sessionmaker
from app.models import PushSubscription
from app.services.webpush import generate_vapid_keys
from tests.factories import make_user, sign_in

API = "/api/v1"
SUB = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123", "keys": {"p256dh": "B" * 87, "auth": "a" * 22}}


def _enable_push(monkeypatch):
    pub, priv = generate_vapid_keys()
    s = get_settings()
    monkeypatch.setattr(s, "vapid_public_key", pub)
    monkeypatch.setattr(s, "vapid_private_key", priv)
    return pub


async def _count():
    async with sessionmaker()() as db:
        return await db.scalar(select(func.count()).select_from(PushSubscription))


async def test_push_disabled_without_vapid(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "vapid_public_key", None)
    monkeypatch.setattr(get_settings(), "vapid_private_key", None)
    await make_user("faculty@dbit.edu", "faculty")
    s = await sign_in(client, "faculty@dbit.edu")
    assert (await client.get(f"{API}/push/config")).json() == {"enabled": False, "publicKey": None}
    assert (await s.post(f"{API}/push/subscriptions", json=SUB)).status_code == 409


async def test_subscribe_resubscribe_unsubscribe(client, monkeypatch):
    pub = _enable_push(monkeypatch)
    await make_user("faculty@dbit.edu", "faculty")
    s = await sign_in(client, "faculty@dbit.edu")
    assert (await client.get(f"{API}/push/config")).json() == {"enabled": True, "publicKey": pub}
    assert (await s.post(f"{API}/push/subscriptions", json=SUB)).status_code == 204
    assert (await s.post(f"{API}/push/subscriptions", json=SUB)).status_code == 204
    assert await _count() == 1
    assert (await s.delete(f"{API}/push/subscriptions", json={"endpoint": SUB["endpoint"]})).status_code == 204
    assert await _count() == 0


async def test_rejects_non_https_and_internal_endpoints(client, monkeypatch):
    _enable_push(monkeypatch)
    await make_user("faculty@dbit.edu", "faculty")
    s = await sign_in(client, "faculty@dbit.edu")
    for bad in ("http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x"):
        r = await s.post(f"{API}/push/subscriptions", json={**SUB, "endpoint": bad})
        assert r.status_code == 400, bad


async def test_requires_sign_in_and_csrf(client, monkeypatch):
    _enable_push(monkeypatch)
    assert (await client.post(f"{API}/push/subscriptions", json=SUB)).status_code == 401
    await make_user("faculty@dbit.edu", "faculty")
    await sign_in(client, "faculty@dbit.edu")
    assert (await client.post(f"{API}/push/subscriptions", json=SUB)).status_code == 403


async def test_shared_device_endpoint_moves_to_new_user(client, monkeypatch):
    _enable_push(monkeypatch)
    await make_user("faculty@dbit.edu", "faculty")
    b = await make_user("faculty2@dbit.edu", "faculty")
    s = await sign_in(client, "faculty@dbit.edu")
    await s.post(f"{API}/push/subscriptions", json=SUB)
    await s.delete(f"{API}/session")
    s = await sign_in(client, "faculty2@dbit.edu")
    await s.post(f"{API}/push/subscriptions", json=SUB)
    async with sessionmaker()() as db:
        rows = (await db.scalars(select(PushSubscription))).all()
    assert len(rows) == 1 and rows[0].user_id == b.id
