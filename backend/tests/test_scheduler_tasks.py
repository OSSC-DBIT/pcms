"""Scheduler tasks: auto-close, update chases, and the retention prune.

The prune is the only code allowed to delete history, so these tests pin both
halves of that: it removes what is past its window, and the append-only
triggers still refuse a delete from anywhere else.
"""

from datetime import timedelta

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from app.config import get_settings
from app.db import sessionmaker
from app.models import AuditEvent, Outbox, Ticket, TicketComment, TicketEvent
from app.security.sessions import now
from app.services import scheduler
from tests.factories import API, make_user, new_client, sign_in, ticket_body


async def _resolved_ticket(client):
    """A ticket taken to Resolved by the manager, awaiting the reporter."""
    await make_user("faculty@dbit.edu", "faculty", "Reporter")
    await make_user("manager@dbit.edu", "facility_manager", "Manager One")
    fac = await sign_in(client, "faculty@dbit.edu")
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    mc = new_client()
    mgr = await sign_in(mc, "manager@dbit.edu")

    async def tr(s, **body):
        v = (await s.get(f"{API}/tickets/{created['id']}")).json()["version"]
        return await s.post(f"{API}/tickets/{created['id']}/transitions", json={"expectedVersion": v, **body})

    await tr(mgr, action="triage", priority="P2", flag="I")
    await tr(mgr, action="assign", workerName="Ramesh K")
    await tr(mgr, action="resolve", note="Fixed")
    return fac, mgr, mc, created["id"]


# ---------- auto close ----------

async def test_auto_close_is_off_by_default(client):
    fac, _mgr, mc, tid = await _resolved_ticket(client)
    try:
        async with sessionmaker()() as db:
            t = await db.get(Ticket, tid)
            t.resolved_at = now() - timedelta(days=99)
            await db.commit()
        assert await scheduler.auto_close() == 0
        assert (await fac.get(f"{API}/tickets/{tid}")).json()["status"] == "Resolved"
    finally:
        await mc.aclose()


async def test_auto_close_waits_the_full_window(client, monkeypatch):
    fac, _mgr, mc, tid = await _resolved_ticket(client)
    try:
        get_settings.cache_clear()
        monkeypatch.setenv("PCMS_AUTO_CLOSE_ENABLED", "true")
        get_settings.cache_clear()
        days = get_settings().auto_close_days
        # One hour short of the window: a manager could not close it yet either.
        async with sessionmaker()() as db:
            t = await db.get(Ticket, tid)
            t.resolved_at = now() - timedelta(days=days) + timedelta(hours=1)
            await db.commit()
        assert await scheduler.auto_close() == 0
        assert (await fac.get(f"{API}/tickets/{tid}")).json()["status"] == "Resolved"

        async with sessionmaker()() as db:
            t = await db.get(Ticket, tid)
            t.resolved_at = now() - timedelta(days=days, hours=1)
            await db.commit()
        assert await scheduler.auto_close() == 1

        detail = (await fac.get(f"{API}/tickets/{tid}")).json()
        assert detail["status"] == "Closed"
        # Not verified: nobody confirmed the repair, so this must not read as
        # a reporter confirmation in the reports.
        assert detail["verifiedByReporter"] is False
        assert any("Auto-closed" in (e.get("detail") or "") for e in detail["events"])

        async with sessionmaker()() as db:
            acts = (await db.scalars(select(AuditEvent.action).where(AuditEvent.entity_id == tid))).all()
            assert "ticket.close_unverified" in acts
            # The reporter is told, and can still rate or dispute.
            assert await db.scalar(select(func.count()).select_from(Outbox).where(
                Outbox.ticket_id == tid, Outbox.template == "status_closed"))

        # Running again finds nothing: it is no longer Resolved.
        assert await scheduler.auto_close() == 0
    finally:
        get_settings.cache_clear()
        await mc.aclose()


async def test_auto_closed_ticket_can_still_be_rated(client, monkeypatch):
    fac, _mgr, mc, tid = await _resolved_ticket(client)
    try:
        get_settings.cache_clear()
        monkeypatch.setenv("PCMS_AUTO_CLOSE_ENABLED", "true")
        get_settings.cache_clear()
        async with sessionmaker()() as db:
            t = await db.get(Ticket, tid)
            t.resolved_at = now() - timedelta(days=get_settings().auto_close_days + 1)
            await db.commit()
        assert await scheduler.auto_close() == 1
        r = await fac.post(f"{API}/tickets/{tid}/rating", json={"stars": 3, "comment": None})
        assert r.status_code == 200, r.text
        assert r.json()["rating"]["stars"] == 3
    finally:
        get_settings.cache_clear()
        await mc.aclose()


# ---------- update chases ----------

async def test_update_chase_notifies_once_per_day(client):
    await make_user("faculty@dbit.edu", "faculty")
    await make_user("manager@dbit.edu", "facility_manager")
    fac = await sign_in(client, "faculty@dbit.edu")
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()

    # Not yet due: a fresh P2 has four hours.
    assert await scheduler.update_due_chases() == 0

    async with sessionmaker()() as db:
        t = await db.get(Ticket, created["id"])
        t.next_update_due = now() - timedelta(hours=1)
        await db.commit()

    assert await scheduler.update_due_chases() == 1
    # Same day again: the event key dedupes, so no second message is queued.
    await scheduler.update_due_chases()
    async with sessionmaker()() as db:
        n = await db.scalar(select(func.count()).select_from(Outbox).where(
            Outbox.ticket_id == created["id"], Outbox.template == "update_overdue"))
        assert n == 1


async def test_closed_tickets_are_never_chased(client):
    fac, _mgr, mc, tid = await _resolved_ticket(client)
    try:
        await fac.post(f"{API}/tickets/{tid}/transitions",
                       json={"expectedVersion": (await fac.get(f"{API}/tickets/{tid}")).json()["version"],
                             "action": "verify"})
        async with sessionmaker()() as db:
            t = await db.get(Ticket, tid)
            t.next_update_due = now() - timedelta(days=5)
            await db.commit()
        assert await scheduler.update_due_chases() == 0
    finally:
        await mc.aclose()


# ---------- retention ----------

async def test_history_delete_is_still_blocked_outside_the_prune(client):
    """The retention opt-in is per transaction; without it DELETE still fails."""
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())
    for table in ("audit_event", "ticket_event"):
        with pytest.raises(DBAPIError):
            async with sessionmaker()() as db:
                await db.execute(text(f"DELETE FROM {table}"))
                await db.commit()


async def test_history_update_is_blocked_even_during_retention(client):
    """Retention permits DELETE only. An UPDATE to history is never allowed."""
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())
    with pytest.raises(DBAPIError):
        async with sessionmaker()() as db:
            await db.execute(text("SET LOCAL pcms.retention = 'on'"))
            await db.execute(text("UPDATE audit_event SET action = 'tampered'"))
            await db.commit()


async def test_retention_keeps_recent_history(client):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())
    async with sessionmaker()() as db:
        before = await db.scalar(select(func.count()).select_from(AuditEvent))
    assert await scheduler.retention_prune() == 0
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(AuditEvent)) == before


async def test_retention_prunes_old_audit_and_closed_ticket_history(client):
    fac, _mgr, mc, tid = await _resolved_ticket(client)
    try:
        await fac.post(f"{API}/tickets/{tid}/comments", json={"body": "Thanks", "internal": False})
        await fac.post(f"{API}/tickets/{tid}/transitions",
                       json={"expectedVersion": (await fac.get(f"{API}/tickets/{tid}")).json()["version"],
                             "action": "verify"})
        s = get_settings()
        async with sessionmaker()() as db:
            # Age the audit trail and the ticket's closure past their windows.
            await db.execute(text("SET LOCAL pcms.retention = 'on'"))
            await db.execute(text("UPDATE ticket SET closed_at = :c WHERE id = :i"),
                            {"c": now() - timedelta(days=s.retention_ticket_history_days + 10), "i": tid})
            await db.commit()
        # audit_event blocks UPDATE outright, so insert an already-old row
        # the same way the prune will find it.
        async with sessionmaker()() as db:
            await db.execute(text("""
                INSERT INTO audit_event (at, actor_label, action, entity_type, entity_id)
                VALUES (:at, 'old', 'ticket.created', 'ticket', :i)
            """), {"at": now() - timedelta(days=s.retention_audit_days + 10), "i": tid})
            await db.commit()
            old_audit = await db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.at < now() - timedelta(days=s.retention_audit_days)))
            assert old_audit == 1

        removed = await scheduler.retention_prune()
        assert removed > 0

        async with sessionmaker()() as db:
            # The old audit row and the closed ticket's timeline and messages go.
            assert await db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.at < now() - timedelta(days=s.retention_audit_days))) == 0
            assert await db.scalar(select(func.count()).select_from(TicketEvent).where(
                TicketEvent.ticket_id == tid)) == 0
            assert await db.scalar(select(func.count()).select_from(TicketComment).where(
                TicketComment.ticket_id == tid)) == 0
            # The ticket itself, its token and its rating are never pruned.
            t = await db.get(Ticket, tid)
            assert t is not None and t.token
    finally:
        await mc.aclose()


async def test_retention_keeps_history_of_open_tickets_however_old(client):
    """An open ticket keeps its whole timeline no matter how old it is."""
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    created = (await fac.post(f"{API}/tickets", json=ticket_body())).json()
    async with sessionmaker()() as db:
        await db.execute(text("SET LOCAL pcms.retention = 'on'"))
        # Old, but never closed: closed_at stays NULL.
        await db.execute(text("UPDATE ticket SET created_at = :c WHERE id = :i"),
                         {"c": now() - timedelta(days=4000), "i": created["id"]})
        await db.commit()
    await scheduler.retention_prune()
    async with sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(TicketEvent).where(
            TicketEvent.ticket_id == created["id"])) > 0


async def test_retention_disabled_by_zero(client, monkeypatch):
    await make_user("faculty@dbit.edu", "faculty")
    fac = await sign_in(client, "faculty@dbit.edu")
    await fac.post(f"{API}/tickets", json=ticket_body())
    async with sessionmaker()() as db:
        await db.execute(text("""
            INSERT INTO audit_event (at, actor_label, action, entity_type, entity_id)
            VALUES (:at, 'old', 'x', 'ticket', 'x')
        """), {"at": now() - timedelta(days=5000)})
        await db.commit()
    try:
        get_settings.cache_clear()
        for k in ("AUDIT", "TICKET_HISTORY", "OUTBOX", "PROVIDER_EVENT"):
            monkeypatch.setenv(f"PCMS_RETENTION_{k}_DAYS", "0")
        get_settings.cache_clear()
        assert await scheduler.retention_prune() == 0
        async with sessionmaker()() as db:
            assert await db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.at < now() - timedelta(days=4000))) == 1
    finally:
        get_settings.cache_clear()
