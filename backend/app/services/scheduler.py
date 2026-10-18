"""Periodic work run by the scheduler process (and callable from tests).

  - no Accept within the deadline: SMS fallback, then ask managers to call (plan 12, 13)
  - remind reporters to verify resolved work (plan 9.1)
  - flag holds whose review date has arrived (plan 8, weekly review)
  - scan quarantined uploads with ClamAV and release or reject them (plan 18.1)
  - housekeeping: expired sessions and old throttle records
"""

import logging
from datetime import date, timedelta

from sqlalchemy import delete, select

from app.config import get_settings
from app.db import sessionmaker
from app.models.attachment import Attachment
from app.models.catalog import Building, Category
from app.models.session import ThrottleEvent, UserSession
from app.models.ticket import Ticket
from app.models.worker import Assignment, Worker
from app.security.sessions import now
from app.services import media, notify
from app.services.tickets import add_event, location_text

log = logging.getLogger("pcms.scheduler")


async def acceptance_fallbacks() -> int:
    n = 0
    async with sessionmaker()() as db:
        rows = (await db.execute(
            select(Assignment, Ticket, Worker).join(Ticket, Ticket.id == Assignment.ticket_id).join(Worker, Worker.id == Assignment.worker_id)
            .where(Assignment.released_at.is_(None), Assignment.accepted_at.is_(None), Assignment.fallback_sent_at.is_(None),
                   Assignment.ack_due_at < now(), Ticket.status == "Assigned")
            .with_for_update(of=Assignment, skip_locked=True))).all()
        for a, t, w in rows:
            a.fallback_sent_at = now()
            if a.channel == "whatsapp" and w.mode in ("whatsapp", "sms"):
                cat = await db.get(Category, t.category_id)
                b = await db.scalar(select(Building).where(Building.code == t.building_code)) if t.building_code else None
                await notify.dispatch_worker(db, t, a, w, cat.name_en if cat else "", location_text(t, {b.code: b} if b else None),
                                             channel="sms", template="job_fallback")
                detail = f"No Accept from {w.name} in {get_settings().accept_timeout_minutes} min: SMS sent; call to confirm"
            else:
                detail = f"No acceptance recorded from {w.name}: call to confirm"
            add_event(db, t, None, "Acceptance overdue", detail=detail, public=False)
            await notify.notify_role(db, "facility_manager", t, template="ack_overdue", key_suffix=f":{a.id}",
                                     title=f"{t.token}: worker has not accepted", body=detail)
            n += 1
        await db.commit()
    return n


async def verification_reminders() -> int:
    s = get_settings()
    n = 0
    async with sessionmaker()() as db:
        due = (await db.scalars(select(Ticket).where(
            Ticket.status == "Resolved", Ticket.resolved_at < now() - timedelta(days=s.verify_reminder_days)))).all()
        for t in due:
            # The event key includes the ticket version, so each resolution reminds once.
            await notify.notify_reporter(db, t, template="verify_reminder", title=f"{t.token}: is it fixed?",
                                         body="Please check the work and verify it, or tell us what is still wrong.")
            n += 1
        await db.commit()
    return n


async def hold_reviews() -> int:
    n = 0
    today = date.today()
    async with sessionmaker()() as db:
        due = (await db.scalars(select(Ticket).where(Ticket.status == "OnHold", Ticket.hold_review_date <= today))).all()
        for t in due:
            await notify.notify_role(db, "facility_manager", t, template="hold_review", key_suffix=f":{today.isoformat()}",
                                     title=f"{t.token}: hold review due", body=t.hold_reason or "Review this hold.")
            n += 1
        await db.commit()
    return n


async def scan_quarantine(limit: int = 10) -> int:
    """Scan uploads in quarantine. If ClamAV is down, files simply wait (never released unscanned)."""
    n = 0
    async with sessionmaker()() as db:
        pending = (await db.scalars(select(Attachment).where(Attachment.state == "scanning")
                                    .order_by(Attachment.created_at).limit(limit).with_for_update(skip_locked=True))).all()
        for att in pending:
            src = media.quarantine_path(att.storage_key)
            if not src.exists():
                att.state, att.failure_reason = "failed", "File missing"
                continue
            try:
                clean, detail = await media.clamav_scan(src)
            except OSError as exc:
                log.warning("clamav unavailable: %s", exc)
                break
            if clean:
                dst = media.store_path(att.storage_key)
                dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                src.replace(dst)
                att.state = "available"
            else:
                src.unlink(missing_ok=True)
                att.state, att.failure_reason = "failed", "Blocked by the virus scanner"
                log.warning("attachment %s rejected: %s", att.id, detail)
            n += 1
        await db.commit()
    return n


async def housekeeping() -> None:
    async with sessionmaker()() as db:
        await db.execute(delete(UserSession).where(UserSession.expires_at < now() - timedelta(days=30)))
        await db.execute(delete(ThrottleEvent).where(ThrottleEvent.at < now() - timedelta(days=1)))
        await db.commit()
