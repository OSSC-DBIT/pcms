"""Ticket creation, visibility and serialisation.

Visibility rules (plan sections 3 and 18):
  - Faculty see only tickets they reported. Anything else is 404, not 403,
    so a guessed ID or token reveals nothing.
  - Staff with queue.view see every ticket.
  - Faculty never receive internal notes, internal timeline entries, costs,
    or worker phone numbers.
"""

import hashlib
import json
import uuid
from collections import defaultdict
from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import ApiError, conflict, not_found, validation
from app.models.attachment import Attachment
from app.models.catalog import Building, Category
from app.models.proposal import Decision, Proposal, ProposalLine
from app.models.rating import TicketRating
from app.models.ticket import TERMINAL, Ticket, TicketComment, TicketEvent, TokenCounter
from app.models.user import User
from app.schemas.ticket import (
    AttachmentOut, CommentOut, EventOut, LocationOut, ProposalLineIO, ProposalOut, RatingOut, TicketCreateIn,
    TicketOut, TicketSummaryOut,
)
from app.security.deps import Principal
from app.security.sessions import now
from app.services import audit, notify

PRIORITY_FROM_IMPACT = {"safety": "P1", "class_interrupted": "P2", "multiple_areas": "P3", "routine": "P4"}
# Gross next-update targets (plan 9.1). Service hours and holidays are a later refinement.
NEXT_UPDATE = {"P1": timedelta(minutes=30), "P2": timedelta(hours=4), "P3": timedelta(days=2), "P4": timedelta(days=5)}


def ist_year() -> int:
    return now().astimezone(ZoneInfo(get_settings().timezone)).year


def is_staff(p: Principal) -> bool:
    return p.can("queue.view")


def can_see(p: Principal, t: Ticket) -> bool:
    return is_staff(p) or t.reporter_id == p.user.id


async def get_visible(db: AsyncSession, p: Principal, ticket_id: uuid.UUID, *, lock: bool = False) -> Ticket:
    t = await db.get(Ticket, ticket_id, with_for_update=lock)
    if t is None or not can_see(p, t):
        raise not_found("Ticket not found.")
    return t


def check_version(t: Ticket, expected: int) -> None:
    if t.version != expected:
        raise conflict("stale_version", "This ticket was changed by someone else. Refresh and try again.")


def bump(t: Ticket) -> None:
    t.version += 1
    t.updated_at = now()


def add_event(db: AsyncSession, t: Ticket, actor: User | None, action: str, *, detail: str | None = None,
              public: bool = True, from_status: str | None = None, to_status: str | None = None,
              delegated_worker: str | None = None, actor_label: str | None = None) -> None:
    db.add(TicketEvent(ticket_id=t.id, actor_id=actor.id if actor else None,
                       actor_label=actor_label or (actor.name if actor else "PCMS"), action=action,
                       detail=(detail or None) and detail[:1000], public=public, from_status=from_status,
                       to_status=to_status, delegated_worker=delegated_worker))


# ---------- token allocation ----------

def format_token(letter: str, year: int, serial: int) -> str:
    """Type letter first, so the token says what it is: C26-0001 is the first Carpentry ticket of 2026.
    Four digits minimum; a type passing 9999 in a year gains a fifth (plan 7.1)."""
    return f"{letter}{year % 100:02d}-{serial:04d}"


async def allocate_token(db: AsyncSession, category: Category) -> str:
    """Serial from a counter row locked inside the create transaction. Rolled-back serials are released."""
    year = ist_year()
    await db.execute(insert(TokenCounter).values(category_id=category.id, year=year, last_serial=0)
                     .on_conflict_do_nothing(index_elements=["category_id", "year"]))
    counter = await db.scalar(select(TokenCounter).where(TokenCounter.category_id == category.id,
                                                         TokenCounter.year == year).with_for_update())
    counter.last_serial += 1
    return format_token(category.letter, year, counter.last_serial)


# ---------- creation ----------

def request_hash(body: TicketCreateIn) -> str:
    data = body.model_dump(mode="json", exclude={"client_request_id"})
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


async def _validate_create(db: AsyncSession, body: TicketCreateIn) -> tuple[Category, dict]:
    errors: dict[str, str] = {}
    cat = await db.scalar(select(Category).where(Category.code == body.category_code, Category.active))
    if cat is None:
        errors["categoryCode"] = "Choose a type from the list."
    title = " ".join(body.title.split())
    if not (4 <= len(title) <= 120):
        errors["title"] = "Give the issue a short title of 4 to 120 characters."
    description = body.description.strip()
    if len(description) > 2000:
        errors["description"] = "Keep the details under 2000 characters."
    if cat and body.subtype and body.subtype not in cat.subtypes_en:
        errors["subtype"] = "Choose a part from the list."
    subtype = body.subtype
    other = " ".join((body.other_detail or "").split())
    if cat and (subtype == "Other" or (cat.code == "other" and not subtype)):
        if len(other) < 3:
            errors["otherDetail"] = "Say what it is (for example: water cooler, lift, notice board)."
        subtype = f"Other: {other}"[:80]
    loc = body.location
    fields = {"outdoors": loc.outdoors, "landmark": (loc.landmark or "").strip() or None,
              "building_code": None, "floor": None, "room": None}
    if loc.outdoors:
        if not fields["landmark"]:
            errors["location"] = "Describe where outdoors (a nearby landmark)."
    else:
        b = await db.scalar(select(Building).where(Building.code == loc.building, Building.active))
        room = " ".join(loc.room.split())
        if b is None:
            errors["location"] = "Choose a building from the list."
        elif loc.floor not in b.floors:
            errors["location"] = "Choose a floor of that building."
        elif not room:
            errors["location"] = "Give the room or area."
        fields.update(building_code=loc.building, floor=loc.floor, room=room[:60])
    if errors:
        raise validation("Some details need attention.", errors)
    return cat, {**fields, "title": title, "description": description, "subtype": subtype}


async def create_ticket(db: AsyncSession, p: Principal, body: TicketCreateIn) -> tuple[Ticket, bool]:
    """Returns (ticket, replayed). Same client_request_id and body replays; a changed body conflicts."""
    h = request_hash(body)

    async def existing() -> Ticket | None:
        return await db.scalar(select(Ticket).where(Ticket.reporter_id == p.user.id,
                                                    Ticket.client_request_id == body.client_request_id))

    found = await existing()
    if found is not None:
        if found.request_hash != h:
            raise conflict("idempotency_conflict", "This request ID was already used for a different report.")
        return found, True

    cat, fields = await _validate_create(db, body)
    priority = PRIORITY_FROM_IMPACT[body.impact]
    try:
        async with db.begin_nested():
            token = await allocate_token(db, cat)
            t = Ticket(token=token, reporter_id=p.user.id, original_category_id=cat.id, category_id=cat.id,
                       impact=body.impact, priority=priority, status="Submitted",
                       access_note=body.access_note, alt_contact=body.alt_contact, version=1,
                       next_update_due=now() + NEXT_UPDATE[priority], assessments=[],
                       client_request_id=body.client_request_id, request_hash=h, **fields)
            db.add(t)
            await db.flush()
    except IntegrityError:
        # A concurrent identical request won the race; replay its result.
        found = await existing()
        if found is None:
            raise
        if found.request_hash != h:
            raise conflict("idempotency_conflict", "This request ID was already used for a different report.")
        return found, True

    add_event(db, t, p.user, "Your report was received", to_status="Submitted")
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.created", entity_type="ticket",
                 entity_id=t.id, after={"token": t.token, "category": cat.code, "priority": priority, "impact": body.impact})
    await notify.notify_reporter(db, t, template="receipt", title=f"Report received: {t.token}",
                                 body=f"{t.title}. Keep this token to track progress.")
    await notify.notify_role(db, "facility_manager", t, template="new_ticket",
                             title=f"New {priority} report {t.token}", body=f"{cat.name_en}: {t.title}")
    return t, False


# ---------- serialisation ----------

class Lookups:
    """Batch-loaded names for a set of tickets (avoids N+1 queries)."""

    def __init__(self):
        self.categories: dict[int, Category] = {}
        self.users: dict[uuid.UUID, User] = {}
        self.proposals: dict[uuid.UUID, tuple[Proposal, list[ProposalLine], Decision | None]] = {}

    @classmethod
    async def load(cls, db: AsyncSession, tickets: list[Ticket], staff: bool) -> "Lookups":
        lk = cls()
        if not tickets:
            return lk
        ids = [t.id for t in tickets]
        lk.categories = {c.id: c for c in (await db.scalars(select(Category))).all()}
        user_ids = {t.reporter_id for t in tickets}
        if staff:
            latest = select(Proposal.ticket_id, func.max(Proposal.version).label("v")).where(
                Proposal.ticket_id.in_(ids)).group_by(Proposal.ticket_id).subquery()
            props = (await db.scalars(select(Proposal).join(latest, (Proposal.ticket_id == latest.c.ticket_id)
                                                            & (Proposal.version == latest.c.v)))).all()
            if props:
                pids = [x.id for x in props]
                lines = defaultdict(list)
                for ln in (await db.scalars(select(ProposalLine).where(ProposalLine.proposal_id.in_(pids))
                                            .order_by(ProposalLine.position))).all():
                    lines[ln.proposal_id].append(ln)
                decisions = {d.proposal_id: d for d in (await db.scalars(
                    select(Decision).where(Decision.proposal_id.in_(pids)))).all()}
                for pr in props:
                    lk.proposals[pr.ticket_id] = (pr, lines[pr.id], decisions.get(pr.id))
                    user_ids.add(pr.requested_by)
                    if pr.id in decisions:
                        user_ids.add(decisions[pr.id].decided_by)
        lk.users = {u.id: u for u in (await db.scalars(select(User).where(User.id.in_(user_ids)))).all()}
        return lk

    def name(self, user_id) -> str:
        u = self.users.get(user_id)
        return u.name if u else "Unknown"


def _summary_fields(t: Ticket, lk: Lookups, staff: bool) -> dict:
    proposal = None
    if staff and t.id in lk.proposals:
        pr, lines, d = lk.proposals[t.id]
        proposal = ProposalOut(
            id=pr.id, version=pr.version, lines=[ProposalLineIO(label=ln.label, paise=ln.paise) for ln in lines],
            total_paise=pr.total_paise, requested_date=pr.requested_date, requested_by=lk.name(pr.requested_by),
            requested_by_id=pr.requested_by, remedy=pr.remedy, state=pr.state,
            ceiling_paise=d.ceiling_paise if d else None, conditions=d.conditions if d else None,
            decided_by=lk.name(d.decided_by) if d else None, decided_at=d.decided_at if d else None,
            reason=d.reason if d else None, review_date=d.review_date if d else None)
    cat = lk.categories.get(t.category_id)
    orig = lk.categories.get(t.original_category_id)
    return dict(
        id=t.id, token=t.token, reporter_id=t.reporter_id, reporter_name=lk.name(t.reporter_id),
        original_category_code=orig.code if orig else "", category_code=cat.code if cat else "",
        subtype=t.subtype,
        location=LocationOut(building=t.building_code or "", floor=t.floor or "", room=t.room or "",
                             outdoors=t.outdoors, landmark=t.landmark),
        title=t.title, impact=t.impact, priority=t.priority, flag=t.flag, assessments=t.assessments,
        status=t.status, version=t.version, created_at=t.created_at, updated_at=t.updated_at,
        next_update_due=t.next_update_due if t.status not in TERMINAL else None,
        duplicate_of=t.duplicate_of_id, verified_by_reporter=t.verified_by_reporter,
        worker_name=t.worker_name if staff else None, proposal=proposal,
    )


def summary_out(t: Ticket, lk: Lookups, staff: bool) -> TicketSummaryOut:
    return TicketSummaryOut(**_summary_fields(t, lk, staff))


async def ticket_out(db: AsyncSession, p: Principal, t: Ticket) -> TicketOut:
    staff = is_staff(p)
    lk = await Lookups.load(db, [t], staff)
    ev_q = select(TicketEvent).where(TicketEvent.ticket_id == t.id).order_by(TicketEvent.id)
    cm_q = select(TicketComment).where(TicketComment.ticket_id == t.id).order_by(TicketComment.created_at)
    if not staff:
        ev_q = ev_q.where(TicketEvent.public)
        cm_q = cm_q.where(TicketComment.internal.is_(False))
    events = (await db.scalars(ev_q)).all()
    comments = (await db.scalars(cm_q)).all()
    atts = (await db.scalars(select(Attachment).where(Attachment.ticket_id == t.id).order_by(Attachment.created_at))).all()
    rating = await db.scalar(select(TicketRating).where(TicketRating.ticket_id == t.id))
    return TicketOut(
        **_summary_fields(t, lk, staff),
        description=t.description, access_note=t.access_note, alt_contact=t.alt_contact,
        hold_reason=t.hold_reason if t.status == "OnHold" else None,
        hold_review_date=t.hold_review_date if t.status == "OnHold" else None,
        rating=RatingOut(stars=rating.stars, comment=rating.comment, created_at=rating.created_at) if rating else None,
        events=[EventOut(id=str(e.id), at=e.at, actor=e.actor_label if staff or e.actor_id == p.user.id else _public_actor(e),
                         action=e.action, detail=e.detail, delegated_worker=e.delegated_worker if staff else None)
                for e in events],
        comments=[CommentOut(id=c.id, at=c.created_at, actor=c.author_label, body=c.body, internal=c.internal) for c in comments],
        attachments=[AttachmentOut(id=a.id, kind=a.kind, name=a.original_name, size_bytes=a.size_bytes, state=a.state,
                                   failure_reason=a.failure_reason,
                                   url=f"/api/v1/attachments/{a.id}/content" if a.state == "available" else None)
                     for a in atts],
    )


def _public_actor(e: TicketEvent) -> str:
    # Faculty see roles, not individual staff or worker names, in their timeline.
    return "Facilities" if e.actor_id else "PCMS"


def ensure_not_terminal(t: Ticket) -> None:
    if t.status in TERMINAL:
        raise ApiError(409, "invalid_transition", f"This ticket is {t.status} and cannot be changed.")
