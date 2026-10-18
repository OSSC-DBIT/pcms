"""Outbox processing (plan section 13), shared by the worker process and tests.

  claim()   - takes due jobs with FOR UPDATE SKIP LOCKED, marks them 'sending', commits
  deliver() - sends each job with no database transaction open
  record()  - stores the outcome: sent, retry at 1/5/15/60 minutes, or action_required

A job whose worker crashed mid-send cannot be known to have failed, so WhatsApp
and SMS jobs found stuck in 'sending' go to action_required instead of being
re-sent blindly. Email and push are re-sent (a duplicate is harmless).
"""

import logging
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, select, text, update

from app import providers
from app.config import get_settings
from app.db import sessionmaker
from app.models.attachment import Attachment
from app.models.outbox import DeliveryAttempt, Outbox
from app.models.push import PushSubscription
from app.models.ticket import TERMINAL, Ticket
from app.models.user import User
from app.models.worker import Assignment, Worker
from app.security.sessions import now
from app.services import media, webpush

log = logging.getLogger("pcms.outbox")

BACKOFF_MINUTES = (1, 5, 15, 60)
LOCK = timedelta(minutes=3)


@dataclass
class Claimed:
    id: int
    channel: str
    template: str
    payload: dict
    user_id: object
    worker_id: object
    ticket_id: object
    assignment_id: object
    attempts: int


async def claim(limit: int = 20) -> list[Claimed]:
    async with sessionmaker()() as db:
        rows = (await db.execute(text("""
            UPDATE outbox SET state = 'sending', attempts = attempts + 1, locked_until = now() + interval '3 minutes'
            WHERE id IN (
                SELECT id FROM outbox WHERE state = 'pending' AND next_attempt_at <= now()
                ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT :limit)
            RETURNING id, channel, template, payload, user_id, worker_id, ticket_id, assignment_id, attempts
        """), {"limit": limit})).all()
        await db.commit()
    return [Claimed(*r) for r in rows]


async def recover_stuck() -> int:
    async with sessionmaker()() as db:
        stuck = (await db.scalars(select(Outbox).where(Outbox.state == "sending", Outbox.locked_until < now()))).all()
        for o in stuck:
            if o.channel in ("whatsapp", "sms"):
                o.state = "action_required"
                o.last_error = "Delivery outcome unknown after an interruption. Check the worker received it, or call."
            else:
                o.state = "pending"
                o.next_attempt_at = now()
        await db.commit()
        return len(stuck)


async def _job_target(db, c: Claimed) -> tuple[str | None, str | None, str | None]:
    """Returns (recipient, media_url, skip_reason)."""
    if c.channel in ("whatsapp", "sms"):
        w = await db.get(Worker, c.worker_id)
        a = await db.get(Assignment, c.assignment_id) if c.assignment_id else None
        t = await db.get(Ticket, c.ticket_id) if c.ticket_id else None
        # Expire obsolete messages: reassigned, accepted already, or ticket finished (plan 13).
        if w is None or not w.active:
            return None, None, "worker inactive"
        if a is not None and (a.released_at is not None or (c.template == "job_fallback" and a.accepted_at is not None)):
            return None, None, "assignment no longer current"
        if t is not None and (t.status in TERMINAL or t.status == "Resolved"):
            return None, None, "ticket finished"
        media_url = None
        if c.channel == "whatsapp" and t is not None:
            photo = await db.scalar(select(Attachment).where(Attachment.ticket_id == t.id, Attachment.kind == "photo",
                                                             Attachment.state == "available").order_by(Attachment.created_at).limit(1))
            if photo:
                media_url = get_settings().public_base_url.rstrip("/") + "/media/public/" + media.public_token(photo.id)
        return w.phone_e164, media_url, None
    if c.channel == "email":
        u = await db.get(User, c.user_id)
        if u is None or not u.active or not u.email:
            return None, None, "no email"
        return u.email, None, None
    return None, None, None


async def deliver(c: Claimed) -> providers.SendResult | str:
    """Returns a SendResult, or a string reason when the job should expire unsent."""
    async with sessionmaker()() as db:
        to, media_url, skip = await _job_target(db, c)
        subs = []
        if c.channel == "webpush":
            subs = [(s.id, s.endpoint, s.p256dh, s.auth) for s in
                    (await db.scalars(select(PushSubscription).where(PushSubscription.user_id == c.user_id))).all()]
    # Session closed: no transaction is held during provider calls.
    if skip:
        return skip
    if c.channel == "email":
        return await providers.send_email(to, c.payload.get("subject", "PCMS update"),
                                          f"{c.payload.get('body', '')}\n\nOpen PCMS: {get_settings().public_app_url.rstrip('/')}{c.payload.get('url', '/')}\n")
    if c.channel == "webpush":
        if not subs or not webpush.is_configured():
            return "no push subscription"
        ok = False
        retry = False
        gone = []
        for sid, endpoint, p256dh, auth in subs:
            r = await webpush.send(endpoint, p256dh, auth, c.payload)
            ok |= r.ok
            retry |= r.retryable
            if r.gone:
                gone.append(sid)
        if gone:
            async with sessionmaker()() as db:
                await db.execute(delete(PushSubscription).where(PushSubscription.id.in_(gone)))
                await db.commit()
        return providers.SendResult(ok=ok, retryable=retry and not ok, error=None if ok else "push failed")
    provider = providers.messaging()
    if provider is None:
        return providers.SendResult(ok=False, retryable=False, error="Worker messaging is turned off; call the worker or use a job card.")
    return await provider.send(providers.Job(c.channel, to, c.template, c.payload, media_url))


async def record(c: Claimed, result: providers.SendResult | str) -> None:
    async with sessionmaker()() as db:
        o = await db.get(Outbox, c.id, with_for_update=True)
        if isinstance(result, str):
            o.state = "expired"
            o.last_error = result
        else:
            db.add(DeliveryAttempt(outbox_id=o.id, ok=result.ok, status_code=result.status_code,
                                   error=result.error, provider_id=result.provider_id))
            if result.ok:
                o.state = "sent"
                o.sent_at = now()
                o.provider_id = result.provider_id
                o.provider_status = "accepted"
                o.last_error = None
            elif result.retryable and o.attempts < len(BACKOFF_MINUTES) + 1:
                o.state = "pending"
                o.next_attempt_at = now() + timedelta(minutes=BACKOFF_MINUTES[o.attempts - 1])
                o.last_error = result.error
            else:
                o.state = "action_required"
                o.last_error = result.error
        o.locked_until = None
        if c.assignment_id and c.channel in ("whatsapp", "sms") and c.template == "job_dispatch":
            delivery = {"sent": "sent", "action_required": "failed", "expired": None, "pending": "queued"}.get(o.state)
            if delivery:
                await db.execute(update(Assignment).where(Assignment.id == c.assignment_id).values(delivery=delivery))
        await db.commit()


async def run_once(limit: int = 20) -> int:
    jobs = await claim(limit)
    for c in jobs:
        try:
            result = await deliver(c)
        except Exception as exc:  # never lose the job on an unexpected error
            log.exception("outbox job %s failed", c.id)
            result = providers.SendResult(ok=False, retryable=True, error=f"{type(exc).__name__}: {exc}"[:300])
        await record(c, result)
    return len(jobs)
