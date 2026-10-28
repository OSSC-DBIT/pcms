"""Periodic work run by the scheduler process (and callable from tests).

  - remind reporters to verify resolved work (plan 9.1)
  - close resolved work the reporter never answered (opt-in)
  - chase tickets that passed their next-update target
  - flag holds whose review date has arrived (plan 8, weekly review)
  - scan quarantined uploads with ClamAV and release or reject them (plan 18.1)
  - housekeeping: expired sessions and old throttle records
  - retention: prune history past its keep window (the only path that deletes it)
"""

import logging
from datetime import date, timedelta

from sqlalchemy import delete, select, text

from app.config import get_settings
from app.db import sessionmaker
from app.models.attachment import Attachment
from app.models.session import ThrottleEvent, UserSession
from app.models.ticket import TERMINAL, Ticket
from app.security.sessions import now
from app.services import audit, media, notify
from app.services.tickets import add_event, bump

log = logging.getLogger("pcms.scheduler")


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


async def auto_close() -> int:
    """Close Resolved tickets the reporter never answered.

    Mirrors the `close_unverified` transition a manager can click by hand, and
    keeps the same waiting period, so the scheduler can never close a ticket
    earlier than a person could. Off unless PCMS_AUTO_CLOSE_ENABLED is true.
    """
    s = get_settings()
    if not s.auto_close_enabled:
        return 0
    n = 0
    cutoff = now() - timedelta(days=s.auto_close_days)
    async with sessionmaker()() as db:
        due = (await db.scalars(select(Ticket).where(
            Ticket.status == "Resolved", Ticket.resolved_at < cutoff).with_for_update(skip_locked=True))).all()
        for t in due:
            reason = f"No reply from the reporter for {s.auto_close_days} days."
            before = {"status": t.status}
            t.status = "Closed"
            t.verified_by_reporter = False
            t.closed_at = now()
            t.next_update_due = None
            bump(t)
            add_event(db, t, None, "Closed", detail=f"Auto-closed without reporter verification: {reason}",
                      public=True, from_status="Resolved", to_status="Closed")
            audit.record(db, actor_id=None, actor_label="PCMS scheduler", action="ticket.close_unverified",
                         entity_type="ticket", entity_id=t.id, before=before, after={"status": "Closed"},
                         reason=reason)
            # The reporter can still rate it, and can still dispute inside the
            # dispute window, so say so rather than just announcing closure.
            await notify.notify_reporter(
                db, t, template="status_closed", title=f"{t.token}: closed",
                body=f"{t.title}. We did not hear back, so this is closed. "
                     f"Tell us within {s.dispute_window_days} days if it is still broken.")
            n += 1
        await db.commit()
    if n:
        log.info("auto-closed %d resolved ticket(s) with no reporter reply", n)
    return n


async def update_due_chases() -> int:
    """Tell facility managers about open tickets past their next-update target.

    NEXT_UPDATE in services/tickets.py sets the target per priority (30 minutes
    for P1, 5 days for P4). The reports dashboard already counts these; this
    pushes the same thing so nobody has to watch the screen. The event key
    includes the date, so one ticket chases at most once a day.
    """
    n = 0
    today = date.today()
    async with sessionmaker()() as db:
        due = (await db.scalars(select(Ticket).where(
            Ticket.status.not_in(TERMINAL), Ticket.status != "Resolved",
            Ticket.next_update_due.is_not(None), Ticket.next_update_due < now()))).all()
        for t in due:
            await notify.notify_role(
                db, "facility_manager", t, template="update_overdue",
                key_suffix=f":{today.isoformat()}",
                title=f"{t.token}: update overdue ({t.priority})",
                body=f"{t.title}. This has passed its next-update target.")
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


# ---------- retention ----------

# Each entry: (setting name, human label, SQL that deletes one batch).
# Every statement is bounded by a batch limit so one nightly pass can never
# hold a long transaction over a history table.
RETENTION_BATCH = 5000

_PRUNE_SQL: dict[str, tuple[str, str]] = {
    "retention_audit_days": ("audit_event", """
        DELETE FROM audit_event WHERE id IN (
            SELECT id FROM audit_event WHERE at < :cutoff ORDER BY id LIMIT :batch)
    """),
    # Timeline and messages are pruned only for tickets that are closed and
    # whose closure is itself older than the window, so an open ticket never
    # loses its history no matter how old it is.
    "retention_ticket_history_days": ("ticket_event", """
        DELETE FROM ticket_event WHERE id IN (
            SELECT e.id FROM ticket_event e JOIN ticket t ON t.id = e.ticket_id
            WHERE t.status IN ('Closed', 'Cancelled', 'Rejected', 'Duplicate')
              AND t.closed_at IS NOT NULL AND t.closed_at < :cutoff
            ORDER BY e.id LIMIT :batch)
    """),
    "retention_outbox_days": ("outbox", """
        DELETE FROM outbox WHERE id IN (
            SELECT id FROM outbox
            WHERE state IN ('sent', 'cancelled', 'expired') AND created_at < :cutoff
            ORDER BY id LIMIT :batch)
    """),
    "retention_provider_event_days": ("provider_event", """
        DELETE FROM provider_event WHERE key IN (
            SELECT key FROM provider_event WHERE received_at < :cutoff
            ORDER BY received_at LIMIT :batch)
    """),
}


async def retention_prune() -> int:
    """Delete history past its keep window. The only code that may do this.

    History tables block DELETE through the pcms_block_mutation trigger. This
    opts in with `SET LOCAL pcms.retention = 'on'`, which the trigger checks
    and which expires when the transaction ends, so nothing outside this
    function (an application bug, a stray psql DELETE) can remove history.

    Order matters: ticket_comment before ticket_event is not required, but
    delivery_attempt must go before its outbox parent, and outbox rows are
    only removed once they are finished.
    """
    s = get_settings()
    total = 0
    async with sessionmaker()() as db:
        await db.execute(text("SET LOCAL pcms.retention = 'on'"))

        # Comments and delivery attempts hang off rows pruned below, so clear
        # them first to keep the foreign keys satisfied.
        hist_days = s.retention_ticket_history_days
        if hist_days > 0:
            cutoff = now() - timedelta(days=hist_days)
            removed = (await db.execute(text("""
                DELETE FROM ticket_comment WHERE id IN (
                    SELECT c.id FROM ticket_comment c JOIN ticket t ON t.id = c.ticket_id
                    WHERE t.status IN ('Closed', 'Cancelled', 'Rejected', 'Duplicate')
                      AND t.closed_at IS NOT NULL AND t.closed_at < :cutoff
                    ORDER BY c.id LIMIT :batch)
            """), {"cutoff": cutoff, "batch": RETENTION_BATCH})).rowcount
            total += removed
            if removed:
                log.info("retention: removed %d ticket_comment row(s)", removed)

        out_days = s.retention_outbox_days
        if out_days > 0:
            cutoff = now() - timedelta(days=out_days)
            removed = (await db.execute(text("""
                DELETE FROM delivery_attempt WHERE id IN (
                    SELECT a.id FROM delivery_attempt a JOIN outbox o ON o.id = a.outbox_id
                    WHERE o.state IN ('sent', 'cancelled', 'expired') AND o.created_at < :cutoff
                    ORDER BY a.id LIMIT :batch)
            """), {"cutoff": cutoff, "batch": RETENTION_BATCH})).rowcount
            total += removed
            if removed:
                log.info("retention: removed %d delivery_attempt row(s)", removed)

        for setting, (label, sql) in _PRUNE_SQL.items():
            days = getattr(s, setting)
            if days <= 0:
                continue
            removed = (await db.execute(
                text(sql), {"cutoff": now() - timedelta(days=days), "batch": RETENTION_BATCH})).rowcount
            total += removed
            if removed:
                log.info("retention: removed %d %s row(s)", removed, label)
        await db.commit()
    return total
