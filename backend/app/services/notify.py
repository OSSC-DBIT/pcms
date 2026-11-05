"""Notification intents, written in the caller's transaction (plan section 13).

Web push is the only channel (DBIT, 2026-11-04: email and Twilio were removed). Nothing
here talks to a push service. The outbox worker sends later; if the business transaction
rolls back, the intent disappears with it.

Payloads hold only a title, a short line, an in-app link and the ticket token (the
notification tag). They never include internal notes, costs or phone numbers, because
they pass through browser vendors' push services.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.outbox import Outbox
from app.models.push import PushSubscription
from app.models.ticket import Ticket
from app.models.user import User
from app.security.sessions import now


async def _enqueue(db: AsyncSession, *, event_key: str, template: str, payload: dict,
                   user_id, ticket_id=None, not_before: datetime | None = None) -> None:
    stmt = insert(Outbox).values(
        event_key=event_key[:200], channel="webpush", template=template, payload=payload,
        user_id=user_id, ticket_id=ticket_id,
        state="pending", attempts=0, next_attempt_at=not_before or now(), acknowledged=False,
    ).on_conflict_do_nothing(index_elements=["event_key"])
    await db.execute(stmt)


def clip(text: str, limit: int) -> str:
    """Shorten text for a notification at a word boundary, with "..." so a cut is visible."""
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 3]
    space = cut.rfind(" ")
    if space >= limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,.;:-") + "..."


async def notify_user(db: AsyncSession, user: User, ticket: Ticket, *, template: str, title: str, body: str,
                      url: str, key_suffix: str = "") -> None:
    """A push notification to every device the person turned notifications on for.
    The ticket status in the app is authoritative; a person without notifications on
    still sees every change there."""
    has_push = await db.scalar(select(PushSubscription.id).where(PushSubscription.user_id == user.id).limit(1))
    if not has_push:
        return
    await _enqueue(db, event_key=f"{template}:{ticket.id}:{ticket.version}:{user.id}{key_suffix}:webpush",
                   template=template, user_id=user.id, ticket_id=ticket.id,
                   payload={"title": clip(title, 100), "body": clip(body, 240), "url": url, "tag": ticket.token})


async def notify_reporter(db: AsyncSession, ticket: Ticket, *, template: str, title: str, body: str) -> None:
    reporter = await db.get(User, ticket.reporter_id)
    if reporter and reporter.active:
        await notify_user(db, reporter, ticket, template=template, title=title, body=body, url=f"/t/{ticket.id}")


async def notify_role(db: AsyncSession, role: str, ticket: Ticket, *, template: str, title: str, body: str,
                      exclude_user=None, key_suffix: str = "") -> None:
    users = (await db.scalars(select(User).where(User.role == role, User.active))).all()
    for u in users:
        if exclude_user is not None and u.id == exclude_user:
            continue
        await notify_user(db, u, ticket, template=template, title=title, body=body, url=f"/staff/t/{ticket.id}",
                          key_suffix=key_suffix)
