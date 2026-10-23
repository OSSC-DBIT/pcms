"""Notification intents, written in the caller's transaction (plan section 13).

Nothing here talks to a provider. The outbox worker sends later; if the
business transaction rolls back, the intent disappears with it.

Payloads hold only what the message needs. Web push payloads never include
internal notes, costs or phone numbers because they pass through browser
vendors' push services.
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


async def _enqueue(db: AsyncSession, *, event_key: str, channel: str, template: str, payload: dict,
                   user_id=None, worker_id=None, ticket_id=None, assignment_id=None,
                   not_before: datetime | None = None) -> None:
    stmt = insert(Outbox).values(
        event_key=event_key[:200], channel=channel, template=template, payload=payload,
        user_id=user_id, worker_id=worker_id, ticket_id=ticket_id, assignment_id=assignment_id,
        state="pending", attempts=0, next_attempt_at=not_before or now(), acknowledged=False,
    ).on_conflict_do_nothing(index_elements=["event_key"])
    await db.execute(stmt)


async def notify_user(db: AsyncSession, user: User, ticket: Ticket, *, template: str, title: str, body: str,
                      url: str, email: bool = True, key_suffix: str = "") -> None:
    """In-app status is authoritative; push and email are courtesy channels."""
    base = f"{template}:{ticket.id}:{ticket.version}:{user.id}{key_suffix}"
    has_push = await db.scalar(select(PushSubscription.id).where(PushSubscription.user_id == user.id).limit(1))
    if has_push:
        await _enqueue(db, event_key=f"{base}:webpush", channel="webpush", template=template,
                       user_id=user.id, ticket_id=ticket.id,
                       payload={"title": title[:80], "body": body[:200], "url": url, "tag": ticket.token})
    if email and user.email:
        await _enqueue(db, event_key=f"{base}:email", channel="email", template=template,
                       user_id=user.id, ticket_id=ticket.id,
                       payload={"subject": f"[PCMS {ticket.token}] {title}"[:150], "body": body, "url": url})


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
