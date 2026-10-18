"""Worker dispatch and the spending approval workflow (plan sections 10 and 11)."""

import re
import uuid
from datetime import date, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import ApiError, conflict, forbidden, not_found, validation
from app.models.catalog import Building, Category
from app.models.proposal import Decision, Proposal, ProposalLine
from app.models.ticket import TERMINAL, Ticket
from app.models.user import User
from app.models.worker import Assignment, Worker, WorkerSkill
from app.schemas.ticket import AssessmentIn, AssignIn, DecisionIn, ProposalIn, WorkerIn, WorkerOut, WorkerPatch
from app.security.deps import Principal
from app.security.sessions import now
from app.services import audit, notify
from app.services.tickets import add_event, bump, check_version, location_text

E164 = re.compile(r"^\+[1-9]\d{7,14}$")


# ---------- workers ----------

def normalise_phone(raw: str) -> str:
    s = re.sub(r"[\s\-().]", "", raw)
    if s.startswith("00"):
        s = "+" + s[2:]
    if re.fullmatch(r"[6-9]\d{9}", s):
        s = "+91" + s
    elif re.fullmatch(r"0[6-9]\d{9}", s):
        s = "+91" + s[1:]
    elif re.fullmatch(r"91[6-9]\d{9}", s):
        s = "+" + s
    if not E164.match(s):
        raise validation("Enter a mobile number like +91 98765 43210.", {"phone": "Invalid number"})
    return s


def mask_phone(e164: str) -> str:
    return f"{e164[:3]} ***** {e164[-4:]}" if e164.startswith("+91") else f"{e164[:2]} *** {e164[-4:]}"


async def _trade_ids(db: AsyncSession, codes: list[str]) -> list[int]:
    cats = {c.code: c.id for c in (await db.scalars(select(Category).where(Category.code.in_(codes)))).all()}
    unknown = [c for c in codes if c not in cats]
    if unknown:
        raise validation("Unknown trade.", {"trades": ", ".join(unknown)})
    return [cats[c] for c in dict.fromkeys(codes)]


async def workers_out(db: AsyncSession, workers: list[Worker]) -> list[WorkerOut]:
    if not workers:
        return []
    ids = [w.id for w in workers]
    codes = {c.id: c.code for c in (await db.scalars(select(Category))).all()}
    skills: dict[uuid.UUID, list[str]] = {i: [] for i in ids}
    for s in (await db.scalars(select(WorkerSkill).where(WorkerSkill.worker_id.in_(ids)))).all():
        skills[s.worker_id].append(codes.get(s.category_id, ""))
    load = dict((await db.execute(
        select(Assignment.worker_id, func.count()).join(Ticket, Ticket.id == Assignment.ticket_id)
        .where(Assignment.worker_id.in_(ids), Assignment.released_at.is_(None), Ticket.status.not_in(TERMINAL + ("Resolved",)))
        .group_by(Assignment.worker_id))).all())
    return [WorkerOut(id=w.id, name=w.name, phone_masked=mask_phone(w.phone_e164), trades=sorted(skills[w.id]), area=w.area,
                      language=w.language, mode=w.mode, kind=w.kind, active=w.active, workload=load.get(w.id, 0),
                      last_verified=w.last_verified_at, version=w.version) for w in workers]


async def create_worker(db: AsyncSession, p: Principal, body: WorkerIn) -> Worker:
    phone = normalise_phone(body.phone)
    if await db.scalar(select(Worker.id).where(Worker.phone_e164 == phone)):
        raise conflict("phone_exists", "A worker with this number already exists.")
    trade_ids = await _trade_ids(db, body.trades)
    w = Worker(name=" ".join(body.name.split()), phone_e164=phone, area=body.area.strip(), language=body.language,
               mode=body.mode, kind=body.kind, active=True, last_verified_at=now(), version=1)
    db.add(w)
    await db.flush()
    for cid in trade_ids:
        db.add(WorkerSkill(worker_id=w.id, category_id=cid))
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="worker.created", entity_type="worker",
                 entity_id=w.id, after={"name": w.name, "trades": body.trades, "mode": w.mode, "kind": w.kind})
    return w


async def update_worker(db: AsyncSession, p: Principal, w: Worker, body: WorkerPatch) -> Worker:
    if w.version != body.expected_version:
        raise conflict("stale_version", "This worker was changed by someone else. Refresh and try again.")
    before = {"name": w.name, "active": w.active, "mode": w.mode, "area": w.area}
    if body.name is not None:
        w.name = " ".join(body.name.split())
    if body.phone is not None:
        phone = normalise_phone(body.phone)
        if phone != w.phone_e164 and await db.scalar(select(Worker.id).where(Worker.phone_e164 == phone)):
            raise conflict("phone_exists", "A worker with this number already exists.")
        w.phone_e164 = phone
        w.last_verified_at = now()
    for f in ("area", "language", "mode", "kind", "active"):
        v = getattr(body, f)
        if v is not None:
            setattr(w, f, v)
    if body.verified:
        w.last_verified_at = now()
    if body.trades is not None:
        ids = await _trade_ids(db, body.trades)
        for s in (await db.scalars(select(WorkerSkill).where(WorkerSkill.worker_id == w.id))).all():
            await db.delete(s)
        await db.flush()
        for cid in ids:
            db.add(WorkerSkill(worker_id=w.id, category_id=cid))
    w.version += 1
    w.updated_at = now()
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="worker.updated", entity_type="worker",
                 entity_id=w.id, before=before, after={"name": w.name, "active": w.active, "mode": w.mode, "area": w.area})
    return w


# ---------- assignments ----------

async def _place(db: AsyncSession, t: Ticket) -> tuple[str, str]:
    cat = await db.get(Category, t.category_id)
    b = await db.scalar(select(Building).where(Building.code == t.building_code)) if t.building_code else None
    return (cat.name_en if cat else ""), location_text(t, {b.code: b} if b else None)


async def assign(db: AsyncSession, p: Principal, t: Ticket, body: AssignIn) -> None:
    check_version(t, body.expected_version)
    if t.status not in ("Triaged", "OnHold"):
        raise ApiError(409, "invalid_transition", f"Workers can be assigned when a ticket is Triaged or On hold, not {t.status}.")
    if body.lead_worker_id not in body.worker_ids:
        raise validation("The lead must be one of the selected workers.", {"leadWorkerId": "Not selected"})
    ids = list(dict.fromkeys(body.worker_ids))
    workers = {w.id: w for w in (await db.scalars(select(Worker).where(Worker.id.in_(ids)).with_for_update())).all()}
    errors = {}
    for wid in ids:
        w = workers.get(wid)
        if w is None or not w.active:
            errors[str(wid)] = "Inactive or unknown worker"
        elif body.channel == "whatsapp" and w.mode != "whatsapp":
            errors[str(wid)] = f"{w.name} is not on WhatsApp; use SMS"
    if errors:
        raise validation("Some workers cannot receive this job.", errors)

    active = {a.worker_id: a for a in (await db.scalars(
        select(Assignment).where(Assignment.ticket_id == t.id, Assignment.released_at.is_(None)).with_for_update())).all()}
    # Clear the lead first so the one-active-lead index never sees two.
    await db.execute(update(Assignment).where(Assignment.ticket_id == t.id, Assignment.released_at.is_(None))
                     .values(lead=False))
    for wid, a in active.items():
        if wid not in ids:
            a.released_at = now()
            a.release_reason = "Reassigned"
    await db.flush()

    s = get_settings()
    cat_name, place = await _place(db, t)
    names = []
    for wid in ids:
        w = workers[wid]
        a = active.get(wid)
        if a is None:
            a = Assignment(ticket_id=t.id, worker_id=wid, channel=body.channel, assigned_by=p.user.id,
                           delivery="queued" if body.channel in ("whatsapp", "sms") else "not_applicable",
                           ack_due_at=now() + timedelta(minutes=s.accept_timeout_minutes), lead=False)
            db.add(a)
            await db.flush()
            await notify.dispatch_worker(db, t, a, w, cat_name, place)
        a.lead = wid == body.lead_worker_id
        names.append(w.name + (" (lead)" if a.lead else ""))
    old = t.status
    t.status = "Assigned"
    t.hold_reason = t.hold_owner = t.hold_next_action = None
    t.hold_review_date = None
    bump(t)
    add_event(db, t, p.user, "A worker was assigned", from_status=old, to_status="Assigned", public=True)
    add_event(db, t, p.user, "Dispatched", detail=f"{', '.join(names)} by {body.channel}", public=False)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.assigned", entity_type="ticket",
                 entity_id=t.id, after={"workers": [str(i) for i in ids], "lead": str(body.lead_worker_id), "channel": body.channel})
    await notify.notify_reporter(db, t, template="status_assigned", title=f"{t.token}: a worker was assigned", body=t.title)


async def get_assignment(db: AsyncSession, t: Ticket, assignment_id: uuid.UUID) -> Assignment:
    a = await db.get(Assignment, assignment_id, with_for_update=True)
    if a is None or a.ticket_id != t.id:
        raise not_found("Assignment not found.")
    return a


async def accept(db: AsyncSession, t: Ticket, a: Assignment, *, via: str, actor: User | None, worker: Worker) -> bool:
    """Record acceptance. Used by managers (call, in person) and by the WhatsApp Accept button.
    Returns False if nothing changed (already accepted, released, or ticket moved on)."""
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


async def release(db: AsyncSession, p: Principal, t: Ticket, a: Assignment, reason: str) -> None:
    if a.released_at is not None:
        raise ApiError(409, "already_released", "This worker was already released.")
    worker = await db.get(Worker, a.worker_id)
    was_lead = a.lead
    a.released_at = now()
    a.release_reason = reason
    a.lead = False
    await db.flush()
    remaining = (await db.scalars(select(Assignment).where(Assignment.ticket_id == t.id, Assignment.released_at.is_(None))
                                  .order_by(Assignment.assigned_at))).all()
    if was_lead and remaining:
        remaining[0].lead = True
    old = t.status
    if not remaining and t.status in ("Assigned", "InProgress"):
        t.status = "Triaged"
    bump(t)
    add_event(db, t, p.user, "Worker released", detail=f"{worker.name}: {reason}", public=False, from_status=old, to_status=t.status)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="assignment.released", entity_type="assignment",
                 entity_id=a.id, reason=reason, delegated_worker=worker.name)


async def record_assessment(db: AsyncSession, p: Principal, t: Ticket, body: AssessmentIn) -> None:
    check_version(t, body.expected_version)
    if t.status not in ("Assigned", "InProgress"):
        raise ApiError(409, "invalid_transition", "Assessments are recorded while work is assigned or in progress.")
    a = await db.scalar(select(Assignment).where(Assignment.ticket_id == t.id, Assignment.worker_id == body.worker_id,
                                                 Assignment.released_at.is_(None)))
    if a is None:
        raise validation("That worker is not assigned to this ticket.", {"workerId": "Not assigned"})
    worker = await db.get(Worker, body.worker_id)
    t.assessments = sorted(set(body.assessments))
    bump(t)
    add_event(db, t, p.user, "Assessment recorded", detail=f"{', '.join(t.assessments)}: {body.note} (via {body.via})",
              public=False, delegated_worker=worker.name)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.assessed", entity_type="ticket",
                 entity_id=t.id, after={"assessments": t.assessments, "via": body.via}, delegated_worker=worker.name,
                 reason=body.note)


# ---------- proposals and decisions ----------

async def create_proposal(db: AsyncSession, p: Principal, t: Ticket, body: ProposalIn) -> None:
    """Flag C (critical): send the ticket to management. A cost estimate is optional."""
    check_version(t, body.expected_version)
    if t.status not in ("Assigned", "InProgress", "OnHold"):
        raise ApiError(409, "invalid_transition", "Assign a worker before sending this to management.")
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
