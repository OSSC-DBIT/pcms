"""Web push subscription management for the signed-in user.

GET    /push/config          VAPID public key (applicationServerKey) and whether push is enabled
POST   /push/subscriptions   register or refresh this browser's subscription
DELETE /push/subscriptions   remove this browser's subscription (by endpoint)
POST   /push/test            send a test notification to the caller's devices
"""

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError, validation
from app.models.push import PushSubscription
from app.schemas import CamelModel
from app.security.deps import Principal, current_principal
from app.services import webpush

router = APIRouter(prefix="/push", tags=["push"])

MAX_SUBSCRIPTIONS_PER_USER = 10


class PushConfigOut(CamelModel):
    enabled: bool
    public_key: str | None


class SubscriptionKeys(CamelModel):
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=100)


class SubscriptionIn(CamelModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: SubscriptionKeys


class EndpointIn(CamelModel):
    endpoint: str = Field(min_length=10, max_length=2000)


class TestOut(CamelModel):
    sent: int
    failed: int


def _check_endpoint(url: str) -> None:
    # Push services are always HTTPS. Rejecting anything else prevents the
    # server being used to make requests to internal hosts.
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme != "https" or not host or host == "localhost" or host.replace(".", "").isdigit() or ":" in host:
        raise validation("This push endpoint is not supported.", {"endpoint": "Invalid"})


@router.get("/config", response_model=PushConfigOut)
async def push_config(_: Principal = Depends(current_principal)) -> PushConfigOut:
    s = get_settings()
    return PushConfigOut(enabled=webpush.is_configured(), public_key=s.vapid_public_key if webpush.is_configured() else None)


@router.post("/subscriptions", status_code=204)
async def subscribe(body: SubscriptionIn, request: Request, p: Principal = Depends(current_principal),
                    db: AsyncSession = Depends(get_session)) -> Response:
    if not webpush.is_configured():
        raise ApiError(409, "push_disabled", "Notifications are not enabled on this server.")
    _check_endpoint(body.endpoint)
    stmt = insert(PushSubscription).values(
        user_id=p.user.id, endpoint=body.endpoint, p256dh=body.keys.p256dh, auth=body.keys.auth,
        user_agent=(request.headers.get("user-agent") or "")[:255], failure_count=0,
    )
    # Same endpoint again (refresh, or another user on a shared device): take it over.
    stmt = stmt.on_conflict_do_update(
        index_elements=["endpoint"],
        set_={"user_id": stmt.excluded.user_id, "p256dh": stmt.excluded.p256dh, "auth": stmt.excluded.auth,
              "user_agent": stmt.excluded.user_agent, "failure_count": 0},
    )
    await db.execute(stmt)
    # Cap devices per user; drop the oldest.
    rows = (await db.scalars(
        select(PushSubscription.id).where(PushSubscription.user_id == p.user.id)
        .order_by(PushSubscription.created_at.desc()).offset(MAX_SUBSCRIPTIONS_PER_USER)
    )).all()
    if rows:
        await db.execute(delete(PushSubscription).where(PushSubscription.id.in_(rows)))
    await db.commit()
    return Response(status_code=204)


@router.delete("/subscriptions", status_code=204)
async def unsubscribe(body: EndpointIn, p: Principal = Depends(current_principal),
                      db: AsyncSession = Depends(get_session)) -> Response:
    await db.execute(delete(PushSubscription).where(
        PushSubscription.user_id == p.user.id, PushSubscription.endpoint == body.endpoint))
    await db.commit()
    return Response(status_code=204)


@router.post("/test", response_model=TestOut)
async def test_push(p: Principal = Depends(current_principal), db: AsyncSession = Depends(get_session)) -> TestOut:
    if not webpush.is_configured():
        raise ApiError(409, "push_disabled", "Notifications are not enabled on this server.")
    subs = (await db.scalars(select(PushSubscription).where(PushSubscription.user_id == p.user.id))).all()
    sent = failed = 0
    for sub in subs:
        r = await webpush.send(sub.endpoint, sub.p256dh, sub.auth,
                               {"title": "PCMS", "body": "Notifications are working on this device.", "url": "/settings", "tag": "pcms-test"},
                               ttl=300)
        if r.ok:
            sent += 1
        else:
            failed += 1
            if r.gone:
                await db.delete(sub)
    await db.commit()
    return TestOut(sent=sent, failed=failed)
