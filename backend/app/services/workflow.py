"""Work assessments and the spending approval workflow (plan sections 10 and 11).

Facility managers contact workers themselves and record the state on the ticket.

Spending (DBIT, 2026-10-30): a ticket marked Critical goes to the principal
first. The principal approves it, rejects it, or escalates it to institute
management, the higher authority, who makes the final decision.
"""

import uuid
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ApiError, conflict, forbidden, not_found, validation
from app.models.proposal import Decision, Proposal, ProposalLine
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.ticket import AssessmentIn, DecisionIn, ProposalIn
from app.security.deps import Principal
from app.services import audit, notify
from app.services.tickets import add_event, bump, check_version


async def record_assessment(db: AsyncSession, p: Principal, t: Ticket, body: AssessmentIn) -> None:
    check_version(t, body.expected_version)
    if t.status not in ("Assigned", "InProgress"):
        raise ApiError(409, "invalid_transition", "Work requirements can be recorded while work is assigned or in progress.")
    t.assessments = sorted(set(body.assessments))
    bump(t)
    add_event(db, t, p.user, "Work requirements recorded",
              detail=f"{', '.join(t.assessments)}: {body.note} (via {body.via})", public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.assessed", entity_type="ticket",
                 entity_id=t.id, after={"assessments": t.assessments, "via": body.via}, reason=body.note)


# ---------- proposals and decisions ----------

# Who decides at each stage, and the decisions available to them.
STAGE_CAPABILITY = {"principal": "cost.principal", "management": "cost.approve"}
STAGE_KINDS = {"principal": ("approved", "rejected", "escalated"),
               "management": ("approved", "rejected", "clarify", "defer")}
STAGE_LABEL = {"principal": "the principal", "management": "institute management"}
HOLD_REASON = {"rejected": "Expenditure not approved", "clarify": "Clarification requested by the approver",
               "defer": "Expenditure deferred"}
HOLD_NEXT_ACTION = {"rejected": "The facility manager decides the next step",
                    "clarify": "Respond to the approver and submit a revised request",
                    "defer": "Respond to the approver and submit a revised request"}
HOLD_DAYS = {"rejected": 7, "clarify": 3, "defer": 7}


async def create_proposal(db: AsyncSession, p: Principal, t: Ticket, body: ProposalIn) -> None:
    """Flag C (critical): send the ticket to the principal for approval. A cost estimate is optional."""
    check_version(t, body.expected_version)
    if t.status not in ("Assigned", "InProgress", "OnHold"):
        raise ApiError(409, "invalid_transition",
                       "A ticket can be marked critical while it is Assigned, In progress or On hold.")
    if body.requested_date < date.today():
        raise validation("The required-by date cannot be in the past.", {"requestedDate": "Past date"})
    if await db.scalar(select(Proposal.id).where(Proposal.ticket_id == t.id, Proposal.state == "pending")):
        raise conflict("proposal_pending", "This ticket is already awaiting an approval decision.")
    total = sum(ln.paise for ln in body.lines)
    version = (await db.scalar(select(func.max(Proposal.version)).where(Proposal.ticket_id == t.id)) or 0) + 1
    # Nobody decides spending on a problem they reported. When the principal reported it, the
    # principal stage is skipped and the request goes straight to institute management.
    reporter = await db.get(User, t.reporter_id)
    stage = "management" if reporter is not None and reporter.role == "principal" else "principal"
    pr = Proposal(ticket_id=t.id, version=version, remedy=body.remedy.strip(), total_paise=total,
                  requested_date=body.requested_date, requested_by=p.user.id, state="pending", stage=stage)
    db.add(pr)
    await db.flush()
    for i, ln in enumerate(body.lines):
        db.add(ProposalLine(proposal_id=pr.id, position=i, label=ln.label, paise=ln.paise))
    old = t.status
    t.status = "AwaitingApproval"
    t.flag = "C"
    bump(t)
    add_event(db, t, p.user, "Sent for approval", from_status=old, to_status="AwaitingApproval")
    add_event(db, t, p.user, f"Critical: expenditure request v{version} sent to {STAGE_LABEL[stage]}",
              detail=(f"Rs {total / 100:,.2f}: " if total else "") + pr.remedy, public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="proposal.created", entity_type="proposal",
                 entity_id=pr.id, after={"ticket": t.token, "version": version, "total_paise": total, "stage": stage})
    await notify.notify_role(db, "principal" if stage == "principal" else "management", t, template="approval_needed",
                             title=f"Approval required: {t.token}",
                             body=f"Expenditure request v{version} for {t.title}", exclude_user=p.user.id)


async def decide(db: AsyncSession, p: Principal, proposal_id: uuid.UUID, body: DecisionIn) -> Ticket:
    pr = await db.get(Proposal, proposal_id, with_for_update=True)
    if pr is None:
        raise not_found("Proposal not found.")
    t = await db.get(Ticket, pr.ticket_id, with_for_update=True)
    if pr.version != body.proposal_version or pr.state != "pending":
        raise conflict("stale_version", "This request was already decided or replaced by a newer version. Refresh.")
    latest = await db.scalar(select(func.max(Proposal.version)).where(Proposal.ticket_id == t.id))
    if latest != pr.version or t.status != "AwaitingApproval":
        raise conflict("stale_version", "This request is no longer the one awaiting a decision. Refresh.")
    # Separation of duty (plan 11): the requester never approves their own spending.
    if pr.requested_by == p.user.id or t.reporter_id == p.user.id:
        raise forbidden("You submitted this request or reported the issue, so another approver must decide it.")
    stage = pr.stage
    if not p.can(STAGE_CAPABILITY[stage]):
        raise forbidden(f"This request is awaiting a decision by {STAGE_LABEL[stage]}.")
    if body.kind not in STAGE_KINDS[stage]:
        raise validation("That decision is not available at this stage.", {"kind": "Not allowed"})

    errors = {}
    if body.kind == "approved":
        if pr.total_paise > 0 and (body.ceiling_paise is None or body.ceiling_paise < pr.total_paise):
            errors["ceilingPaise"] = "The approved limit must cover the estimate."
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
    if body.kind == "escalated":
        await _escalate_to_management(db, p, t, pr, body.reason or "")
        if requester:
            await notify.notify_user(db, requester, t, template="decision_escalated",
                                     title=f"{t.token}: request v{pr.version} escalated to institute management",
                                     body=body.reason or "", url=f"/staff/t/{t.id}")
        return t

    old = t.status
    if body.kind == "approved":
        t.status = "InProgress"
        public_label = "Expenditure approved"
    else:
        # Rejection never erases the issue: it waits on hold with an owner and review date (plan 9).
        t.status = "OnHold"
        t.hold_reason = HOLD_REASON[body.kind] + f": {body.reason}"
        t.hold_owner = requester.name if requester else "Facilities"
        t.hold_next_action = HOLD_NEXT_ACTION[body.kind]
        t.hold_review_date = body.review_date or (date.today() + timedelta(days=HOLD_DAYS[body.kind]))
        public_label = "Placed on hold"
    bump(t)
    by = f" by {STAGE_LABEL[stage]}"
    add_event(db, t, p.user, public_label, from_status=old, to_status=t.status)
    add_event(db, t, p.user, f"Request v{pr.version} {body.kind}{by}",
              detail=(body.reason if body.kind != "approved"
                      else f"limit Rs {body.ceiling_paise / 100:,.2f}" if body.ceiling_paise else "approved"), public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action=f"proposal.{body.kind}", entity_type="proposal",
                 entity_id=pr.id, after={"ceiling_paise": body.ceiling_paise, "version": pr.version, "stage": stage},
                 reason=body.reason)
    if requester:
        await notify.notify_user(db, requester, t, template=f"decision_{body.kind}",
                                 title=f"{t.token}: request v{pr.version} {body.kind}{by}",
                                 body=body.reason or body.conditions or "Approved.", url=f"/staff/t/{t.id}")
    return t


async def _escalate_to_management(db: AsyncSession, p: Principal, t: Ticket, pr: Proposal, reason: str) -> None:
    """The principal passes the decision up. Management gets the same request as the next version."""
    # Free the one-pending-per-ticket slot before management's version is inserted.
    await db.flush()
    lines = (await db.scalars(select(ProposalLine).where(ProposalLine.proposal_id == pr.id)
                              .order_by(ProposalLine.position))).all()
    nxt = Proposal(ticket_id=t.id, version=pr.version + 1, remedy=pr.remedy, total_paise=pr.total_paise,
                   requested_date=pr.requested_date, requested_by=pr.requested_by, state="pending", stage="management")
    db.add(nxt)
    await db.flush()
    for ln in lines:
        db.add(ProposalLine(proposal_id=nxt.id, position=ln.position, label=ln.label, paise=ln.paise))
    bump(t)
    add_event(db, t, p.user, f"Request v{pr.version} escalated to institute management (v{nxt.version})",
              detail=reason, public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="proposal.escalated", entity_type="proposal",
                 entity_id=pr.id, after={"version": pr.version, "next_version": nxt.version, "stage": "management"},
                 reason=reason)
    await notify.notify_role(db, "management", t, template="management_approval_needed",
                             title=f"Decision required: {t.token}",
                             body=f"The principal escalated expenditure request v{nxt.version} for {t.title}",
                             exclude_user=p.user.id)
