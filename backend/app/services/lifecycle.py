"""Ticket lifecycle (plan sections 8 and 9).

Every state change goes through apply_transition: there is no free-form
status update. Each action declares who may perform it, from which states,
and which fields it needs. Every change bumps the ticket version, writes a
timeline entry and an audit event, and queues reporter notifications.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import ApiError, forbidden, validation
from app.models.catalog import Category
from app.models.rating import TicketRating
from app.models.ticket import TERMINAL, Ticket
from app.models.worker import Assignment
from app.schemas.ticket import TransitionIn
from app.security.deps import Principal
from app.security.sessions import now
from app.services import audit, notify
from app.services.tickets import NEXT_UPDATE, add_event, bump, check_version

OPEN = ("Submitted", "Triaged", "Assigned", "InProgress", "OnHold", "AwaitingApproval")


@dataclass(frozen=True)
class Rule:
    cap: str | None          # capability required (None: reporter-only action)
    from_states: tuple[str, ...]
    reporter: bool = False   # True: only the ticket's reporter


RULES: dict[str, Rule] = {
    "triage": Rule("ticket.triage", ("Submitted",)),
    "set_priority": Rule("ticket.triage", OPEN),
    "set_flag": Rule("ticket.triage", OPEN),
    "recategorise": Rule("ticket.triage", ("Submitted", "Triaged", "Assigned", "InProgress", "OnHold")),
    "hold": Rule("ticket.escalate", ("Triaged", "Assigned", "InProgress")),
    "resume": Rule("ticket.assign", ("OnHold",)),
    "assign": Rule("ticket.assign", ("Triaged", "OnHold")),
    "start": Rule("ticket.assign", ("Assigned",)),
    "set_worker": Rule("ticket.assign", ("Assigned", "InProgress", "OnHold")),
    "resolve": Rule("ticket.triage", ("Assigned", "InProgress")),
    "verify": Rule(None, ("Resolved",), reporter=True),
    "dispute": Rule(None, ("Resolved", "Closed"), reporter=True),
    "reopen": Rule("ticket.triage", ("Resolved", "Closed")),
    "duplicate": Rule("ticket.triage", ("Submitted", "Triaged")),
    "reject": Rule("ticket.triage", ("Submitted", "Triaged")),
    "cancel": Rule("ticket.triage", ("Submitted", "Triaged", "Assigned", "OnHold")),
    "close_unverified": Rule("ticket.close", ("Resolved",)),
}

LABEL = {"Triaged": "Facilities reviewed it", "Assigned": "A worker was assigned", "InProgress": "Work started",
         "OnHold": "Put on hold", "Resolved": "Work finished: please check it", "Closed": "Closed",
         "Cancelled": "Cancelled", "Rejected": "Not accepted", "Duplicate": "Linked to an existing report"}


def _need(**fields) -> None:
    missing = {k: "Required" for k, v in fields.items() if v in (None, "")}
    if missing:
        raise validation("Some details are missing for this action.", missing)


async def _release_all(db: AsyncSession, t: Ticket, reason: str) -> None:
    for a in (await db.scalars(select(Assignment).where(Assignment.ticket_id == t.id, Assignment.released_at.is_(None)))).all():
        a.released_at = now()
        a.release_reason = reason[:500]


async def apply_transition(db: AsyncSession, p: Principal, t: Ticket, body: TransitionIn) -> None:
    rule = RULES[body.action]
    is_reporter = t.reporter_id == p.user.id
    if rule.reporter:
        if not (is_reporter and p.can("ticket.verify")):
            raise forbidden("Only the person who reported this can do that.")
    elif not p.can(rule.cap):
        raise forbidden()
    check_version(t, body.expected_version)
    if t.status not in rule.from_states:
        raise ApiError(409, "invalid_transition", f"That action is not possible while the ticket is {t.status}.")

    s = get_settings()
    before = {"status": t.status, "priority": t.priority, "flag": t.flag, "category_id": t.category_id,
              "worker_name": t.worker_name}
    old = t.status
    new = old
    detail: str | None = None
    public = True
    reason = body.reason

    match body.action:
        case "triage":
            # Accepting a report: priority is required; the I/C/P flag comes later,
            # after a worker has looked at it.
            _need(priority=body.priority)
            t.priority, new = body.priority, "Triaged"
            if body.flag:
                t.flag = body.flag
            t.next_update_due = now() + NEXT_UPDATE[t.priority]
            detail = f"Accepted, priority {t.priority}"
        case "set_priority":
            _need(priority=body.priority, reason=reason)
            t.priority = body.priority
            t.next_update_due = now() + NEXT_UPDATE[t.priority]
            detail, public = f"Priority changed to {t.priority}", False
        case "set_flag":
            _need(flag=body.flag)
            t.flag = body.flag
            detail, public = f"Work type {t.flag}", False
        case "recategorise":
            _need(categoryCode=body.category_code)
            cat = await db.scalar(select(Category).where(Category.code == body.category_code, Category.active))
            if cat is None:
                raise validation("Unknown category.", {"categoryCode": "Unknown"})
            if cat.id == t.category_id:
                raise validation("The ticket already has that category.", {"categoryCode": "Unchanged"})
            # The token keeps its original letter; only the current category changes (plan 7.1).
            t.category_id = cat.id
            t.subtype = None
            detail = f"Type changed to {cat.name_en}"
        case "hold":
            _need(reason=reason, owner=body.owner, nextAction=body.next_action, reviewDate=body.review_date)
            if body.review_date < date.today():
                raise validation("The review date cannot be in the past.", {"reviewDate": "Past date"})
            t.hold_reason, t.hold_owner, t.hold_next_action, t.hold_review_date = reason, body.owner, body.next_action, body.review_date
            t.flag = "P"
            new, detail = "OnHold", f"Postponed: {reason}. Review on {body.review_date.isoformat()}"
        case "resume":
            new = "Assigned"
            t.hold_reason = t.hold_owner = t.hold_next_action = None
            t.hold_review_date = None
        case "assign":
            # The manager contacts the worker directly. The name is optional and internal.
            if body.worker_name is not None:
                t.worker_name = body.worker_name
            new = "Assigned"
            t.hold_reason = t.hold_owner = t.hold_next_action = None
            t.hold_review_date = None
        case "start":
            new = "InProgress"
        case "set_worker":
            t.worker_name = body.worker_name
            detail, public = (f"Worker: {t.worker_name}" if t.worker_name else "Worker name cleared"), False
        case "resolve":
            _need(note=body.note)
            new, detail = "Resolved", body.note
            t.resolved_at = now()
            t.verified_by_reporter = None
        case "verify":
            new = "Closed"
            t.verified_by_reporter = True
            t.closed_at = now()
            detail = "Verified by the reporter"
        case "dispute":
            _need(reason=reason)
            if t.resolved_at is None or now() - t.resolved_at > timedelta(days=s.dispute_window_days):
                raise ApiError(409, "dispute_window_closed",
                               f"Disputes are accepted within {s.dispute_window_days} days of resolution. Raise a new report or contact facilities.")
            # A rating is one immutable row per ticket, about one finished
            # repair. Reopening a rated ticket would leave that rating
            # describing work that is no longer the current state, and the
            # reporter could never rate the second repair (one per ticket).
            # So a rated ticket is final: the next problem is a new report.
            if await db.scalar(select(TicketRating.id).where(TicketRating.ticket_id == t.id)):
                raise ApiError(409, "already_rated",
                               "You already rated this repair, so this ticket is closed for good. "
                               "Please raise a new report for the problem.")
            new, detail = "Triaged", reason
            t.verified_by_reporter = False
            t.closed_at = None
        case "reopen":
            _need(reason=reason)
            new, detail = "Triaged", reason
            t.closed_at = None
            t.verified_by_reporter = None
        case "duplicate":
            _need(canonicalToken=body.canonical_token)
            canonical = await db.scalar(select(Ticket).where(Ticket.token == body.canonical_token.upper()))
            if canonical is None or canonical.id == t.id or canonical.status == "Duplicate":
                raise validation("No other open ticket carries that token.", {"canonicalToken": "Unknown token"})
            t.duplicate_of_id = canonical.id
            new, detail = "Duplicate", f"Same fault as {canonical.token}"
        case "reject" | "cancel":
            _need(reason=reason)
            new, detail = ("Rejected" if body.action == "reject" else "Cancelled"), reason
            await _release_all(db, t, f"Ticket {body.action}ed")
            t.closed_at = now()
        case "close_unverified":
            _need(reason=reason)
            if t.resolved_at is None or now() - t.resolved_at < timedelta(days=s.auto_close_days):
                raise ApiError(409, "too_early",
                               f"The reporter has {s.auto_close_days} days to verify before facilities may close it.")
            new, detail = "Closed", f"Auto-closed without reporter verification: {reason}"
            t.verified_by_reporter = False
            t.closed_at = now()

    t.status = new
    if new in TERMINAL or new == "Resolved":
        t.next_update_due = None
    bump(t)
    add_event(db, t, p.user, LABEL.get(new, "Updated") if new != old else _label(body.action),
              detail=detail, public=public, from_status=old, to_status=new)
    if body.action == "assign" and body.worker_name:
        add_event(db, t, p.user, "Worker assigned", detail=body.worker_name, public=False,
                  from_status=old, to_status=new)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action=f"ticket.{body.action}", entity_type="ticket",
                 entity_id=t.id, before=before,
                 after={"status": t.status, "priority": t.priority, "flag": t.flag, "category_id": t.category_id,
                        "worker_name": t.worker_name},
                 reason=reason)
    if public and new != old and not is_reporter:
        await notify.notify_reporter(db, t, template=f"status_{new.lower()}", title=f"{t.token}: {LABEL.get(new, new)}",
                                     body=t.title if new != "Resolved" else f"{t.title}. Check the work and verify it, or tell us what is still wrong.")
    if body.action == "dispute":
        await notify.notify_role(db, "facility_manager", t, template="disputed", title=f"{t.token} disputed by reporter", body=reason or "")


def _label(action: str) -> str:
    return {"set_priority": "Priority changed", "set_flag": "Work type set", "recategorise": "Type changed",
            "set_worker": "Worker updated"}.get(action, "Updated")
