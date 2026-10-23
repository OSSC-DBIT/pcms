"""Manual worker coordination and the spending approval workflow (plan sections 10 and 11).

Facility managers contact workers themselves and record the state on the ticket.
The legacy assignment helpers below are kept only for WhatsApp messages that
were sent before worker dispatch was retired.
"""

import uuid
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ApiError, conflict, forbidden, not_found, validation
from app.models.proposal import Decision, Proposal, ProposalLine
from app.models.ticket import Ticket
from app.models.user import User
from app.models.worker import Assignment, Worker
from app.schemas.ticket import AssessmentIn, DecisionIn, ProposalIn
from app.security.deps import Principal
from app.security.sessions import now
from app.services import audit, notify
from app.services.tickets import add_event, bump, check_version


# ---------- legacy assignments (Twilio webhooks only) ----------

async def get_assignment(db: AsyncSession, t: Ticket, assignment_id: uuid.UUID) -> Assignment:
    a = await db.get(Assignment, assignment_id, with_for_update=True)
    if a is None or a.ticket_id != t.id:
        raise not_found("Assignment not found.")
    return a


async def accept(db: AsyncSession, t: Ticket, a: Assignment, *, via: str, actor: User | None, worker: Worker) -> bool:
    """Record acceptance for a pre-cutover WhatsApp message. Returns False if nothing changed."""
    if a.released_at is not None or a.accepted_at is not None or t.status != "Assigned":
        return False
    a.accepted_at = now()
    a.accepted_via = via
    t.status = "InProgress"
    bump(t)
    label = "Entered by manager on behalf of worker" if actor else "Accepted with the WhatsApp button"
    add_event(db, t, actor, "The worker accepted the job", detail=f"{label} ({via})", public=True,
              from_status="Assigned", to_status="InProgress", delegated_worker=worker.name,
              actor_label=None if actor else worker.name)
    audit.record(db, actor_id=actor.id if actor else None, actor_label=actor.name if actor else f"worker:{worker.name}",
                 action="assignment.accepted", entity_type="assignment", entity_id=a.id, delegated_worker=worker.name,
                 after={"via": via})
    await notify.notify_reporter(db, t, template="status_inprogress", title=f"{t.token}: work started", body=t.title)
    return True


async def record_assessment(db: AsyncSession, p: Principal, t: Ticket, body: AssessmentIn) -> None:
    check_version(t, body.expected_version)
    if t.status not in ("Assigned", "InProgress"):
        raise ApiError(409, "invalid_transition", "Assessments are recorded while work is assigned or in progress.")
    t.assessments = sorted(set(body.assessments))
    bump(t)
    add_event(db, t, p.user, "Assessment recorded", detail=f"{', '.join(t.assessments)}: {body.note} (via {body.via})",
              public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.assessed", entity_type="ticket",
                 entity_id=t.id, after={"assessments": t.assessments, "via": body.via}, reason=body.note)


# ---------- proposals and decisions ----------

async def create_proposal(db: AsyncSession, p: Principal, t: Ticket, body: ProposalIn) -> None:
    """Flag C (critical): send the ticket to management. A cost estimate is optional."""
    check_version(t, body.expected_version)
    if t.status not in ("Assigned", "InProgress", "OnHold"):
        raise ApiError(409, "invalid_transition",
                       "A ticket can be sent to management while it is Assigned, In progress or On hold.")
    if body.requested_date < date.today():
        raise validation("The needed-by date cannot be in the past.", {"requestedDate": "Past date"})
    if await db.scalar(select(Proposal.id).where(Proposal.ticket_id == t.id, Proposal.state == "pending")):
        raise conflict("proposal_pending", "This ticket is already waiting for management.")
    total = sum(ln.paise for ln in body.lines)
    version = (await db.scalar(select(func.max(Proposal.version)).where(Proposal.ticket_id == t.id)) or 0) + 1
    pr = Proposal(ticket_id=t.id, version=version, remedy=body.remedy.strip(), total_paise=total,
                  requested_date=body.requested_date, requested_by=p.user.id, state="pending")
    db.add(pr)
    await db.flush()
    for i, ln in enumerate(body.lines):
        db.add(ProposalLine(proposal_id=pr.id, position=i, label=ln.label, paise=ln.paise))
    old = t.status
    t.status = "AwaitingApproval"
    t.flag = "C"
    bump(t)
    add_event(db, t, p.user, "Sent to management", from_status=old, to_status="AwaitingApproval")
    add_event(db, t, p.user, f"Critical (request v{version})",
              detail=(f"Rs {total / 100:,.2f}: " if total else "") + pr.remedy, public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="proposal.created", entity_type="proposal",
                 entity_id=pr.id, after={"ticket": t.token, "version": version, "total_paise": total})
    await notify.notify_role(db, "management", t, template="approval_needed",
                             title=f"Approval needed: {t.token}", body=f"Cost proposal v{version} for {t.title}", exclude_user=p.user.id)


async def decide(db: AsyncSession, p: Principal, proposal_id: uuid.UUID, body: DecisionIn) -> Ticket:
    pr = await db.get(Proposal, proposal_id, with_for_update=True)
    if pr is None:
        raise not_found("Proposal not found.")
    t = await db.get(Ticket, pr.ticket_id, with_for_update=True)
    if pr.version != body.proposal_version or pr.state != "pending":
        raise conflict("stale_version", "This proposal was already decided or replaced by a newer version. Refresh.")
    latest = await db.scalar(select(func.max(Proposal.version)).where(Proposal.ticket_id == t.id))
    if latest != pr.version or t.status != "AwaitingApproval":
        raise conflict("stale_version", "This proposal is no longer the one awaiting decision. Refresh.")
    # Separation of duty (plan 11): the requester never approves their own spending.
    if pr.requested_by == p.user.id or t.reporter_id == p.user.id:
        raise forbidden("You requested this or reported the issue, so another approver must decide it.")

    errors = {}
    if body.kind == "approved":
        if pr.total_paise > 0 and (body.ceiling_paise is None or body.ceiling_paise < pr.total_paise):
            errors["ceilingPaise"] = "The approved ceiling must cover the estimate."
    elif not body.reason:
        errors["reason"] = "Give a reason or question."
    if body.kind == "defer" and body.review_date is None:
        errors["reviewDate"] = "Give a review date."
    if errors:
        raise validation("Some details are missing for this decision.", errors)

    db.add(Decision(proposal_id=pr.id, kind=body.kind, decided_by=p.user.id,
                    ceiling_paise=body.ceiling_paise if body.kind == "approved" else None,
                    conditions=body.conditions if body.kind == "approved" else None,
                    reason=body.reason, review_date=body.review_date))
    pr.state = body.kind
    requester = await db.get(User, pr.requested_by)
    old = t.status
    if body.kind == "approved":
        t.status = "InProgress"
        public_label = "Spending approved"
    else:
        # Rejection never erases the issue: it waits on hold with an owner and review date (plan 9).
        t.status = "OnHold"
        t.hold_reason = {"rejected": "Spending rejected", "clarify": "Approver asked for clarification",
                         "defer": "Spending deferred"}[body.kind] + f": {body.reason}"
        t.hold_owner = requester.name if requester else "Facilities"
        t.hold_next_action = "Facilities decides the next step" if body.kind == "rejected" else "Answer the approver and send a new version"
        t.hold_review_date = body.review_date or (date.today() + timedelta(days=3 if body.kind == "clarify" else 7))
        public_label = "Waiting on a spending decision"
    bump(t)
    add_event(db, t, p.user, public_label, from_status=old, to_status=t.status)
    add_event(db, t, p.user, f"Proposal v{pr.version} {body.kind}",
              detail=(body.reason if body.kind != "approved"
                      else f"ceiling Rs {body.ceiling_paise / 100:,.2f}" if body.ceiling_paise else "approved"), public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action=f"proposal.{body.kind}", entity_type="proposal",
                 entity_id=pr.id, after={"ceiling_paise": body.ceiling_paise, "version": pr.version}, reason=body.reason)
    if requester:
        await notify.notify_user(db, requester, t, template=f"decision_{body.kind}", title=f"{t.token}: proposal v{pr.version} {body.kind}",
                                 body=body.reason or body.conditions or "Approved.", url=f"/staff/t/{t.id}")
    return t
