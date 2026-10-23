"""Ticket endpoints. Every mutation locks the ticket row and checks the expected version."""

import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import conflict, forbidden, validation
from app.models.catalog import Category
from app.models.rating import TicketRating
from app.models.ticket import TERMINAL, Ticket, TicketComment
from app.schemas.ticket import (
    AssessmentIn, CommentIn, DuplicateOut, ProposalIn, RatingIn, StatusName, TicketCreatedOut,
    TicketCreateIn, TicketOut, TicketPage, TransitionIn,
)
from app.security.deps import Principal, current_principal, require
from app.services import audit, lifecycle, notify, tickets as svc, workflow
from app.services.tickets import is_staff

router = APIRouter(prefix="/tickets", tags=["tickets"])


def _like(q: str) -> str:
    """Escape the wildcards so a search for "100%" is not a match-anything pattern."""
    return "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


SORTS = ("newest", "oldest", "priority", "updated")


@router.get("", response_model=TicketPage)
async def list_tickets(scope: str = Query("mine", pattern="^(mine|queue)$"), status: str | None = Query(None, max_length=200),
                       open: bool | None = None, page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=200, alias="pageSize"),
                       search: str | None = Query(None, max_length=120), category: str | None = Query(None, max_length=40),
                       flag: str | None = Query(None, pattern="^[ICP]$"), priority: str | None = Query(None, pattern="^P[1-4]$"),
                       building: str | None = Query(None, max_length=20), worker: str | None = Query(None, max_length=120),
                       sort: str = Query("newest", pattern="^(" + "|".join(SORTS) + ")$"),
                       p: Principal = Depends(current_principal), db: AsyncSession = Depends(get_session)) -> TicketPage:
    stmt = select(Ticket)
    if scope == "queue":
        if not p.can("queue.view"):
            raise forbidden()
    else:
        stmt = stmt.where(Ticket.reporter_id == p.user.id)
    if status:
        wanted = [s for s in status.split(",") if s]
        if any(s not in StatusName.__args__ for s in wanted):
            raise validation("Unknown status filter.", {"status": status})
        stmt = stmt.where(Ticket.status.in_(wanted))
    if open is True:
        stmt = stmt.where(Ticket.status.not_in(TERMINAL))
    elif open is False:
        stmt = stmt.where(Ticket.status.in_(TERMINAL))
    if search:
        like = _like(search)
        stmt = stmt.where(or_(Ticket.title.ilike(like, escape="\\"), Ticket.token.ilike(like, escape="\\"),
                              Ticket.room.ilike(like, escape="\\")))
    if category:
        cid = await db.scalar(select(Category.id).where(Category.code == category))
        if cid is None:
            raise validation("Unknown type filter.", {"category": category})
        stmt = stmt.where(Ticket.category_id == cid)
    if flag:
        stmt = stmt.where(Ticket.flag == flag)
    if priority:
        stmt = stmt.where(Ticket.priority == priority)
    if building:
        stmt = stmt.where(Ticket.building_code == building)
    if worker:
        stmt = stmt.where(Ticket.worker_name.ilike(_like(worker), escape="\\"))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    order = {
        "newest": (Ticket.created_at.desc(), Ticket.id.desc()),
        "oldest": (Ticket.created_at.asc(), Ticket.id.asc()),
        # P1 is the most urgent, so plain ascending text order is right here.
        "priority": (Ticket.priority.asc(), Ticket.created_at.desc()),
        "updated": (Ticket.updated_at.desc(), Ticket.id.desc()),
    }[sort]
    rows = (await db.scalars(stmt.order_by(*order).offset((page - 1) * page_size).limit(page_size))).all()
    staff = scope == "queue" and is_staff(p)
    lk = await svc.Lookups.load(db, list(rows), staff)
    return TicketPage(items=[svc.summary_out(t, lk, staff) for t in rows], total=total, page=page, page_size=page_size)


@router.get("/duplicates", response_model=list[DuplicateOut])
async def duplicates(category: str = Query(..., max_length=40), building: str = Query("", max_length=20),
                     room: str = Query("", max_length=60), outdoors: bool = False,
                     p: Principal = Depends(current_principal), db: AsyncSession = Depends(get_session)) -> list[DuplicateOut]:
    """Open reports for the same place and type. Only token, title and status: no identities or notes."""
    cat_id = await db.scalar(select(Category.id).where(Category.code == category))
    if cat_id is None or (not outdoors and not (building and room.strip())):
        return []
    stmt = select(Ticket).where(Ticket.category_id == cat_id, Ticket.status.not_in(TERMINAL))
    if outdoors:
        stmt = stmt.where(Ticket.outdoors)
    else:
        stmt = stmt.where(Ticket.building_code == building, func.lower(Ticket.room) == room.strip().lower())
    rows = (await db.scalars(stmt.order_by(Ticket.created_at.desc()).limit(5))).all()
    return [DuplicateOut(token=t.token, title=t.title, status=t.status) for t in rows]


@router.post("", response_model=TicketCreatedOut, status_code=201,
             responses={200: {"model": TicketCreatedOut, "description": "Identical retry: the original ticket"}})
async def create(body: TicketCreateIn, response: Response, p: Principal = Depends(require("ticket.create")),
                 db: AsyncSession = Depends(get_session)) -> TicketCreatedOut:
    t, replayed = await svc.create_ticket(db, p, body)
    await db.commit()
    if replayed:
        response.status_code = 200
    return TicketCreatedOut(id=t.id, token=t.token, status=t.status, version=t.version, created_at=t.created_at,
                            attachment_upload_allowed=t.status not in TERMINAL)


@router.get("/{ticket_id}", response_model=TicketOut)
async def get_ticket(ticket_id: uuid.UUID, p: Principal = Depends(current_principal),
                     db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await svc.get_visible(db, p, ticket_id)
    return await svc.ticket_out(db, p, t)


@router.post("/{ticket_id}/rating", response_model=TicketOut)
async def rate(ticket_id: uuid.UUID, body: RatingIn, p: Principal = Depends(current_principal),
               db: AsyncSession = Depends(get_session)) -> TicketOut:
    """One immutable rating from the reporter, after the repair is closed."""
    t = await svc.get_visible(db, p, ticket_id, lock=True)
    if t.reporter_id != p.user.id:
        raise forbidden("Only the person who reported this can rate the repair.")
    if t.status != "Closed":
        raise conflict("invalid_transition", "A repair can be rated after the ticket is closed.")
    if await db.scalar(select(TicketRating.id).where(TicketRating.ticket_id == t.id)):
        raise conflict("already_rated", "You already rated this repair.")
    db.add(TicketRating(ticket_id=t.id, reporter_id=p.user.id, stars=body.stars, comment=body.comment))
    try:
        # The unique constraint is the concurrency guard: never return a 500 for a race.
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise conflict("already_rated", "You already rated this repair.")
    svc.add_event(db, t, p.user, "Rating submitted", detail=f"{body.stars}/5", public=True)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.rated", entity_type="ticket",
                 entity_id=t.id, after={"stars": body.stars, "has_comment": bool(body.comment)})
    if body.stars <= 2:
        await notify.notify_role(db, "facility_manager", t, template="low_rating",
                                 title=f"{t.token}: low rating ({body.stars}/5)",
                                 body="Open the ticket to read the comment.", key_suffix=":rating",
                                 exclude_user=p.user.id)
    await db.commit()
    return await svc.ticket_out(db, p, t)


@router.post("/{ticket_id}/transitions", response_model=TicketOut)
async def transition(ticket_id: uuid.UUID, body: TransitionIn, p: Principal = Depends(current_principal),
                     db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await svc.get_visible(db, p, ticket_id, lock=True)
    await lifecycle.apply_transition(db, p, t, body)
    await db.commit()
    return await svc.ticket_out(db, p, t)


@router.post("/{ticket_id}/comments", response_model=TicketOut)
async def comment(ticket_id: uuid.UUID, body: CommentIn, p: Principal = Depends(current_principal),
                  db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await svc.get_visible(db, p, ticket_id, lock=True)
    staff = is_staff(p)
    # Internal visibility is decided by the server: only staff can write internal notes.
    if body.internal and not staff:
        raise forbidden("Only facilities staff can add internal notes.")
    if not staff and t.reporter_id != p.user.id:
        raise forbidden()
    if not staff:
        svc.ensure_not_terminal(t)
    db.add(TicketComment(ticket_id=t.id, author_id=p.user.id, author_label=p.user.name, body=body.body, internal=body.internal))
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="ticket.commented", entity_type="ticket",
                 entity_id=t.id, after={"internal": body.internal})
    if staff and not body.internal and t.reporter_id != p.user.id:
        await notify.notify_reporter(db, t, template="comment", title=f"{t.token}: message from facilities", body=body.body[:180])
    elif not staff:
        await notify.notify_role(db, "facility_manager", t, template="reporter_comment", title=f"{t.token}: reporter comment", body=body.body[:180])
    await db.commit()
    return await svc.ticket_out(db, p, t)


@router.post("/{ticket_id}/assessments", response_model=TicketOut)
async def assess(ticket_id: uuid.UUID, body: AssessmentIn, p: Principal = Depends(require("ticket.assess")),
                 db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await svc.get_visible(db, p, ticket_id, lock=True)
    await workflow.record_assessment(db, p, t, body)
    await db.commit()
    return await svc.ticket_out(db, p, t)


@router.post("/{ticket_id}/proposals", response_model=TicketOut)
async def propose(ticket_id: uuid.UUID, body: ProposalIn, p: Principal = Depends(require("ticket.escalate")),
                  db: AsyncSession = Depends(get_session)) -> TicketOut:
    t = await svc.get_visible(db, p, ticket_id, lock=True)
    await workflow.create_proposal(db, p, t, body)
    await db.commit()
    return await svc.ticket_out(db, p, t)
