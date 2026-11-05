"""Outbox processing (plan section 13), shared by the worker process and tests.

Web push is the only notification channel (DBIT, 2026-11-04: email and Twilio removed).

  claim()   - takes due jobs with FOR UPDATE SKIP LOCKED, marks them 'sending', commits
  deliver() - sends each job to every device of the person, with no database transaction open
  record()  - stores the outcome: sent, retry at 1/5/15/60 minutes, or action_required

A push job found stuck in 'sending' (the worker crashed mid-send) is sent again; a duplicate
notification is harmless because it carries the same tag and replaces the first one.
Rows of retired channels (email, whatsapp, sms) are expired, never sent.
"""

import logging
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, select, text

from app.db import sessionmaker
from app.models.outbox import DeliveryAttempt, Outbox
from app.models.push import PushSubscription
from app.security.sessions import now
from app.services import webpush

log = logging.getLogger("pcms.outbox")

BACKOFF_MINUTES = (1, 5, 15, 60)


@dataclass
class SendResult:
    ok: bool
    retryable: bool = False
    error: str | None = None
    status_code: int | None = None


@dataclass
class Claimed:
    id: int
    channel: str
    template: str
    payload: dict
    user_id: object
    attempts: int


async def claim(limit: int = 20) -> list[Claimed]:
    async with sessionmaker()() as db:
        rows = (await db.execute(text("""
            UPDATE outbox SET state = 'sending', attempts = attempts + 1, locked_until = now() + interval '3 minutes'
            WHERE id IN (
                SELECT id FROM outbox WHERE state = 'pending' AND next_attempt_at <= now()
                ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT :limit)
            RETURNING id, channel, template, payload, user_id, attempts
        """), {"limit": limit})).all()
        await db.commit()
    return [Claimed(*r) for r in rows]


async def recover_stuck() -> int:
    async with sessionmaker()() as db:
        stuck = (await db.scalars(select(Outbox).where(Outbox.state == "sending", Outbox.locked_until < now()))).all()
        for o in stuck:
            o.state = "pending"
            o.next_attempt_at = now()
        await db.commit()
        return len(stuck)


async def deliver(c: Claimed) -> SendResult | str:
    """Returns a SendResult, or a string reason when the job should expire unsent."""
    if c.channel != "webpush":
        return f"{c.channel} notifications are no longer sent"
    if not webpush.is_configured():
        return "push is not configured on this server"
    async with sessionmaker()() as db:
        subs = [(s.id, s.endpoint, s.p256dh, s.auth) for s in
                (await db.scalars(select(PushSubscription).where(PushSubscription.user_id == c.user_id))).all()]
    # Session closed: no transaction is held while calling the push services.
    if not subs:
        return "no push subscription"
    ok = retry = False
    status = None
    errors, gone = [], []
    for sid, endpoint, p256dh, auth in subs:
        r = await webpush.send(endpoint, p256dh, auth, c.payload)
        ok |= r.ok
        retry |= r.retryable
        status = r.status if status is None else status
        if r.gone:
            gone.append(sid)
        elif not r.ok and r.error:
            errors.append(r.error)
    if gone:
        async with sessionmaker()() as db:
            await db.execute(delete(PushSubscription).where(PushSubscription.id.in_(gone)))
            await db.commit()
    if not ok and len(gone) == len(subs):
        # Every device unsubscribed or was reset: nothing to retry.
        return "push subscriptions expired"
    return SendResult(ok=ok, retryable=retry and not ok, status_code=status,
                      error=None if ok else ("push failed: " + "; ".join(errors))[:300])


async def record(c: Claimed, result: SendResult | str) -> None:
    async with sessionmaker()() as db:
        o = await db.get(Outbox, c.id, with_for_update=True)
        if isinstance(result, str):
            o.state = "expired"
            o.last_error = result
        else:
            db.add(DeliveryAttempt(outbox_id=o.id, ok=result.ok, status_code=result.status_code, error=result.error))
            if result.ok:
                o.state = "sent"
                o.sent_at = now()
                o.last_error = None
            elif result.retryable and o.attempts < len(BACKOFF_MINUTES) + 1:
                o.state = "pending"
                o.next_attempt_at = now() + timedelta(minutes=BACKOFF_MINUTES[o.attempts - 1])
                o.last_error = result.error
            else:
                o.state = "action_required"
                o.last_error = result.error
        o.locked_until = None
        await db.commit()


async def run_once(limit: int = 20) -> int:
    jobs = await claim(limit)
    for c in jobs:
        try:
            result = await deliver(c)
        except Exception as exc:  # never lose the job on an unexpected error
            log.exception("outbox job %s failed", c.id)
            result = SendResult(ok=False, retryable=True, error=f"{type(exc).__name__}: {exc}"[:300])
        await record(c, result)
    return len(jobs)
