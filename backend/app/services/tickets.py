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
from app.errors import ApiError, conflict, forbidden, not_found, validation
from app.models.attachment import Attachment
from app.models.catalog import Building, Category
from app.models.proposal import Decision, Proposal, ProposalLine
from app.models.rating import TicketRating
from app.models.ticket import TERMINAL, Ticket, TicketComment, TicketEvent, TokenCounter
from app.models.user import User
from app.schemas.ticket import (
    AttachmentOut, CommentOut, EventOut, LocationOut, ProposalLineIO, ProposalOut, RatingOut, TicketCreateIn,
    TicketOut, TicketRequestIn, TicketSummaryOut, TicketUpdateIn,
)
from app.security.deps import Principal
from app.security.sessions import now
from app.services import audit, notify

PRIORITY_FROM_IMPACT = {"safety": "P1", "class_interrupted": "P2", "multiple_areas": "P3", "routine": "P4"}
# Gross next-update targets (plan 9.1). Service hours and holidays are a later refinement.
NEXT_UPDATE = {"P1": timedelta(minutes=30), "P2": timedelta(hours=4), "P3": timedelta(days=2), "P4": timedelta(days=5)}

# The building dropdown's last option. It is a sentinel, never a Building row.
CUSTOM_BUILDING = "CUSTOM"
# Reporters may correct their request until facilities start work.
EDITABLE_STATUSES = ("Submitted", "Triaged")


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


def _is_other_issue(cat: Category | None, subtype: str | None) -> bool:
    if cat is not None and cat.code == "other" and not subtype:
        return True
    if not subtype:
        return False
    text = subtype.strip().lower()
    return text == "other" or text.startswith("other ")


async def _validate_request(db: AsyncSession, body: TicketRequestIn) -> tuple[Category, dict]:
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

    subtype = body.subtype
    if cat is not None and cat.subtypes_en:
        if subtype is None and cat.code != "other":
            errors["subtype"] = "Choose an issue from the list."
        elif subtype is not None and subtype not in cat.subtypes_en:
            errors["subtype"] = "Choose an issue from the list."

    other = " ".join((body.other_detail or "").split())
    if _is_other_issue(cat, subtype):
        if len(other) < 3:
            errors["otherDetail"] = "Describe the issue briefly."
        base = subtype or "Other"
        subtype = f"{base}: {other}"[:160]

    loc = body.location
    building = " ".join((loc.building or "").split())
    custom = " ".join((loc.custom_location or "").split())
    department = " ".join((loc.department or "").split())
    landmark = " ".join((loc.landmark or "").split()) or None
    floor = " ".join((loc.floor or "").split())
    room = " ".join((loc.room or "").split())
    fields = {"outdoors": loc.outdoors, "landmark": landmark, "building_code": None,
              "custom_location": None, "department": None, "floor": None, "room": None}

    if not building:
        errors["location"] = "Choose a building from the list."
    elif building == CUSTOM_BUILDING:
        if len(custom) < 3:
            errors["location"] = "Enter the building, block, or campus location."
        if loc.outdoors:
            if not landmark:
                errors["location"] = "Describe where outdoors (a nearby landmark)."
        else:
            if len(department) < 2:
                errors["location"] = "Give the department or area."
            elif not floor:
                errors["location"] = "Give the floor or area."
            elif not room:
                errors["location"] = "Give the room or area."
            fields.update(floor=floor[:20] or None, room=room[:60] or None)
        fields["custom_location"] = custom[:120] or None
        fields["department"] = department[:120] or None
    else:
        b = await db.scalar(select(Building).where(Building.code == building, Building.active))
        if b is None:
            errors["location"] = "Choose a building from the list."
        elif custom:
            errors["location"] = "Custom location is only used with Custom Location."
        elif b.departments and not department:
            errors["location"] = "Choose the department or area of that building."
        elif b.departments and department not in b.departments:
            errors["location"] = "Choose a department or area of that building."
        else:
            # Sports Department and other whole-building locations have no
            # subdivision, so ignore any stale department sent by the client.
            if not b.departments:
                department = ""
            if loc.outdoors:
                if not landmark:
                    errors["location"] = "Describe where outdoors (a nearby landmark)."
                fields.update(building_code=building, department=department[:120] or None)
            elif floor not in b.floors:
                errors["location"] = "Choose a floor of that building."
            elif not room:
                errors["location"] = "Give the room or area."
            else:
                fields.update(building_code=building, department=department[:120] or None,
                              floor=floor[:20], room=room[:60])

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

    cat, fields = await _validate_request(db, body)
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


# ---------- reporter edit ----------

def _edit_unavailable_message(status: str) -> str:
    if status in TERMINAL:
        return ("This ticket can no longer be edited because the maintenance request has been closed. "
                "Contact the facility manager if a correction is needed.")
    return (f"This ticket can no longer be edited because work has started ({status}). "
            "Contact the facility manager if a correction is needed.")


def _edit_snapshot(t: Ticket, category_code: str | None) -> dict:
    return {
        "category": category_code,
        "subtype": t.subtype,
        "building": t.building_code,
        "customLocation": t.custom_location,
        "department": t.department,
        "floor": t.floor,
        "room": t.room,
        "outdoors": t.outdoors,
        "landmark": t.landmark,
        "title": t.title,
        "description": t.description,
        "impact": t.impact,
        "priority": t.priority,
        "accessNote": t.access_note,
        "altContact": t.alt_contact,
    }


async def update_ticket(db: AsyncSession, p: Principal, t: Ticket, body: TicketUpdateIn) -> Ticket:
    """The reporter corrects their own request. The token and history never change."""
    if t.reporter_id != p.user.id:
        raise forbidden("Only the person who reported this can edit it.")
    if t.status not in EDITABLE_STATUSES:
        raise ApiError(409, "ticket_not_editable", _edit_unavailable_message(t.status))
    check_version(t, body.expected_version)

    cat, fields = await _validate_request(db, body)
    old_cat = await db.get(Category, t.category_id)
    before = _edit_snapshot(t, old_cat.code if old_cat else None)

    t.category_id = cat.id
    for key, value in fields.items():
        setattr(t, key, value)
    t.impact = body.impact
    t.access_note = body.access_note
    t.alt_contact = body.alt_contact
    if t.status == "Submitted":
        new_priority = PRIORITY_FROM_IMPACT[body.impact]
        if new_priority != t.priority:
            t.priority = new_priority
            t.next_update_due = now() + NEXT_UPDATE[new_priority]

    after = _edit_snapshot(t, cat.code)
    changed = {key: (before[key], after[key]) for key in before if before[key] != after[key]}
    if not changed:
        return t

    bump(t)
    add_event(db, t, p.user, "Ticket details updated by the reporter",
              detail="Changed: " + ", ".join(sorted(changed)), public=True)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.updated_by_reporter",
                 entity_type="ticket", entity_id=t.id,
                 before={key: pair[0] for key, pair in changed.items()},
                 after={key: pair[1] for key, pair in changed.items()})
    await notify.notify_role(db, "facility_manager", t, template="reporter_edit",
                             title=f"{t.token} updated by the reporter",
                             body="The reporter corrected the ticket details.")
    return t


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
        location=LocationOut(building=t.building_code or "", custom_location=t.custom_location,
                             department=t.department or "", floor=t.floor or "", room=t.room or "",
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
