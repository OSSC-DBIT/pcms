"""Operational dashboard, exports and Team OSSC administration (plan 21.1, 18.2).

GET   /reports                        dashboard counts and response/resolution percentiles
GET   /reports/tickets.csv            ticket export (audited, formula-safe)
GET   /admin/audit                    audit log (admin.audit)
GET   /admin/notifications            messages needing a person (failed or unknown delivery)
POST  /admin/notifications/{id}/retry | /dismiss
POST  /admin/categories   PATCH /admin/categories/{code}
POST  /admin/buildings    PATCH /admin/buildings/{code}
"""

from datetime import datetime, timedelta
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ApiError, conflict, not_found, validation
from app.models.audit import AuditEvent
from app.models.catalog import Building, Category
from app.models.outbox import Outbox
from app.models.rating import TicketRating
from app.models.ticket import TERMINAL, Ticket
from app.models.user import User
from app.models.worker import Worker
from app.schemas import CamelModel
from app.security.deps import Principal, require
from app.security.sessions import now
from app.services import audit
from app.services.csvsafe import to_csv

router = APIRouter(tags=["reports", "admin"])


# ---------- dashboard ----------

class Percentiles(CamelModel):
    count: int
    median_hours: float | None
    p90_hours: float | None


class LowRating(CamelModel):
    ticket_id: uuid.UUID
    token: str
    title: str
    stars: int
    comment: str | None
    created_at: datetime
    category: str | None
    building: str | None
    room: str | None


class RatingReport(CamelModel):
    count: int
    average: float | None
    distribution: dict[str, int]
    low: list[LowRating]


class ReportOut(CamelModel):
    generated_at: datetime
    days: int
    open_by_status: dict[str, int]
    open_by_priority: dict[str, int]
    untriaged: int
    overdue_updates: int
    pending_approvals: int
    holds_by_reason: list[dict]
    disputes: int
    failed_notifications: int
    repeat_faults: list[dict]
    triage_time: Percentiles
    resolution_time: Percentiles
    approved_paise: int
    ratings: RatingReport


async def _percentiles(db: AsyncSession, expr: str, where: str, params: dict) -> Percentiles:
    row = (await db.execute(text(f"""
        SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY h), percentile_cont(0.9) WITHIN GROUP (ORDER BY h)
        FROM (SELECT extract(epoch FROM ({expr})) / 3600.0 AS h FROM ticket t WHERE {where}) x WHERE h IS NOT NULL
    """), params)).one()
    return Percentiles(count=row[0], median_hours=round(row[1], 2) if row[1] is not None else None,
                       p90_hours=round(row[2], 2) if row[2] is not None else None)


@router.get("/reports", response_model=ReportOut)
async def report(days: int = Query(30, ge=1, le=366), building: str | None = Query(None, max_length=20),
                 category: str | None = Query(None, max_length=40), _: Principal = Depends(require("queue.view")),
                 db: AsyncSession = Depends(get_session)) -> ReportOut:
    since = now() - timedelta(days=days)
    flt = [Ticket.status.not_in(TERMINAL)]
    sql_where, params = "t.created_at >= :since", {"since": since}
    cid: int | None = None
    if building:
        flt.append(Ticket.building_code == building)
        sql_where += " AND t.building_code = :b"
        params["b"] = building
    if category:
        cid = await db.scalar(select(Category.id).where(Category.code == category))
        flt.append(Ticket.category_id == cid)
        sql_where += " AND t.category_id = :c"
        params["c"] = cid
    open_q = select(Ticket).where(*flt).subquery()

    by_status = dict((await db.execute(select(open_q.c.status, func.count()).group_by(open_q.c.status))).all())
    by_priority = dict((await db.execute(select(open_q.c.priority, func.count()).group_by(open_q.c.priority))).all())
    overdue = await db.scalar(select(func.count()).select_from(open_q).where(open_q.c.next_update_due < now())) or 0
    holds = [{"reason": r, "count": n} for r, n in (await db.execute(
        select(open_q.c.hold_reason, func.count()).where(open_q.c.status == "OnHold")
        .group_by(open_q.c.hold_reason).order_by(func.count().desc()).limit(10))).all()]
    disputes = await db.scalar(text(
        "SELECT count(*) FROM ticket_event e WHERE e.to_status = 'Triaged' AND e.from_status IN ('Resolved','Closed') AND e.at >= :since"),
        {"since": since}) or 0
    failed = await db.scalar(select(func.count()).select_from(Outbox).where(Outbox.state == "action_required", Outbox.acknowledged.is_(False))) or 0
    repeat = [{"building": b, "room": r, "category": c, "count": n} for b, r, c, n in (await db.execute(text(f"""
        SELECT t.building_code, t.room, cat.code, count(*) FROM ticket t JOIN category cat ON cat.id = t.category_id
        WHERE {sql_where} AND NOT t.outdoors GROUP BY 1, 2, 3 HAVING count(*) >= 2 ORDER BY 4 DESC LIMIT 10"""), params)).all()]
    triage = await _percentiles(db, "(SELECT min(e.at) FROM ticket_event e WHERE e.ticket_id = t.id AND e.to_status = 'Triaged') - t.created_at",
                                sql_where, params)
    resolution = await _percentiles(db, "t.resolved_at - t.created_at", sql_where + " AND t.resolved_at IS NOT NULL", params)
    approved = await db.scalar(text("""
        SELECT coalesce(sum(d.ceiling_paise), 0) FROM decision d WHERE d.kind = 'approved' AND d.decided_at >= :since"""),
        {"since": since}) or 0

    # Ratings are on closed tickets, so they use their own window and no open-status filter.
    rating_flt = [TicketRating.created_at >= since]
    if building:
        rating_flt.append(Ticket.building_code == building)
    if cid is not None:
        rating_flt.append(Ticket.category_id == cid)
    rating_join = select(func.count()).select_from(TicketRating).join(
        Ticket, Ticket.id == TicketRating.ticket_id).where(*rating_flt)
    rating_count = await db.scalar(rating_join) or 0
    rating_avg = await db.scalar(select(func.avg(TicketRating.stars)).join(
        Ticket, Ticket.id == TicketRating.ticket_id).where(*rating_flt))
    distribution = {str(stars): 0 for stars in range(1, 6)}
    for stars, n in (await db.execute(select(TicketRating.stars, func.count()).join(
            Ticket, Ticket.id == TicketRating.ticket_id).where(*rating_flt).group_by(TicketRating.stars))).all():
        distribution[str(stars)] = n
    low_rows = (await db.execute(
        select(TicketRating, Ticket, Category.code)
        .join(Ticket, Ticket.id == TicketRating.ticket_id)
        .join(Category, Category.id == Ticket.category_id)
        .where(*rating_flt, TicketRating.stars <= 2)
        .order_by(TicketRating.created_at.desc()).limit(10))).all()
    low = [LowRating(ticket_id=tr.ticket_id, token=t.token, title=t.title, stars=tr.stars, comment=tr.comment,
                     created_at=tr.created_at, category=code, building=t.building_code, room=t.room)
           for tr, t, code in low_rows]

    return ReportOut(generated_at=now(), days=days, open_by_status=by_status, open_by_priority=by_priority,
                     untriaged=by_status.get("Submitted", 0), overdue_updates=overdue,
                     pending_approvals=by_status.get("AwaitingApproval", 0), holds_by_reason=holds, disputes=disputes,
                     failed_notifications=failed, repeat_faults=repeat, triage_time=triage, resolution_time=resolution,
                     approved_paise=int(approved),
                     ratings=RatingReport(count=rating_count, average=round(rating_avg, 2) if rating_avg is not None else None,
                                          distribution=distribution, low=low))


@router.get("/reports/tickets.csv")
async def export_tickets(days: int = Query(90, ge=1, le=731), p: Principal = Depends(require("queue.view")),
                         db: AsyncSession = Depends(get_session)) -> Response:
    since = now() - timedelta(days=days)
    rows = (await db.execute(
        select(Ticket, Category.code, User.email).join(Category, Category.id == Ticket.category_id)
        .join(User, User.id == Ticket.reporter_id).where(Ticket.created_at >= since).order_by(Ticket.created_at))).all()
    body = to_csv(
        ["token", "created_at", "status", "priority", "flag", "category", "building", "floor", "room", "title",
         "reporter_email", "resolved_at", "closed_at", "verified_by_reporter"],
        [[t.token, t.created_at.isoformat(), t.status, t.priority, t.flag or "", code, t.building_code or "", t.floor or "",
          t.room or t.landmark or "", t.title, email, t.resolved_at.isoformat() if t.resolved_at else "",
          t.closed_at.isoformat() if t.closed_at else "", "" if t.verified_by_reporter is None else str(t.verified_by_reporter)]
         for t, code, email in rows])
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="export.tickets", entity_type="export",
                 entity_id="tickets", after={"days": days, "rows": len(rows)})
    await db.commit()
    return Response(body, media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="pcms-tickets-{now():%Y%m%d}.csv"', "Cache-Control": "no-store"})


# ---------- audit ----------

class AuditOut(CamelModel):
    id: int
    at: datetime
    actor_label: str
    action: str
    entity_type: str
    entity_id: str
    reason: str | None
    delegated_worker: str | None
    before: dict | None
    after: dict | None
    request_id: str | None


@router.get("/admin/audit", response_model=list[AuditOut])
async def audit_log(action: str | None = Query(None, max_length=80), entity_id: str | None = Query(None, max_length=64, alias="entityId"),
                    before_id: int | None = Query(None, alias="beforeId"), limit: int = Query(100, ge=1, le=500),
                    _: Principal = Depends(require("admin.audit")), db: AsyncSession = Depends(get_session)) -> list[AuditOut]:
    q = select(AuditEvent)
    if action:
        q = q.where(AuditEvent.action.startswith(action))
    if entity_id:
        q = q.where(AuditEvent.entity_id == entity_id)
    if before_id:
        q = q.where(AuditEvent.id < before_id)
    rows = (await db.scalars(q.order_by(AuditEvent.id.desc()).limit(limit))).all()
    return [AuditOut.model_validate(r) for r in rows]


# ---------- notifications needing a person ----------

class NotificationOut(CamelModel):
    id: int
    channel: str
    template: str
    state: str
    attempts: int
    last_error: str | None
    created_at: datetime
    ticket_id: str | None
    ticket_token: str | None
    recipient: str


@router.get("/admin/notifications", response_model=list[NotificationOut])
async def failed_notifications(_: Principal = Depends(require("queue.view")), db: AsyncSession = Depends(get_session)) -> list[NotificationOut]:
    rows = (await db.execute(
        select(Outbox, Ticket.token, Worker.name, User.name).outerjoin(Ticket, Ticket.id == Outbox.ticket_id)
        .outerjoin(Worker, Worker.id == Outbox.worker_id).outerjoin(User, User.id == Outbox.user_id)
        .where(Outbox.state == "action_required", Outbox.acknowledged.is_(False)).order_by(Outbox.id.desc()).limit(200))).all()
    return [NotificationOut(id=o.id, channel=o.channel, template=o.template, state=o.state, attempts=o.attempts,
                            last_error=o.last_error, created_at=o.created_at, ticket_id=str(o.ticket_id) if o.ticket_id else None,
                            ticket_token=token, recipient=wname or uname or "") for o, token, wname, uname in rows]


@router.post("/admin/notifications/{outbox_id}/{op}", status_code=204)
async def act_on_notification(outbox_id: int, op: Literal["retry", "dismiss"], p: Principal = Depends(require("ticket.assign")),
                              db: AsyncSession = Depends(get_session)) -> Response:
    o = await db.get(Outbox, outbox_id, with_for_update=True)
    if o is None or o.state != "action_required":
        raise not_found()
    if op == "retry":
        o.state, o.attempts, o.next_attempt_at, o.last_error = "pending", 0, now(), None
    else:
        o.acknowledged = True
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action=f"notification.{op}", entity_type="outbox", entity_id=o.id)
    await db.commit()
    return Response(status_code=204)


# ---------- catalogs ----------

class CategoryIn(CamelModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,39}$")
    letter: str = Field(pattern=r"^[A-Z]$")
    name_en: str = Field(min_length=2, max_length=80)
    name_hi: str = Field(min_length=1, max_length=80)
    subtypes_en: list[str] = Field(default_factory=list, max_length=30)
    subtypes_hi: list[str] = Field(default_factory=list, max_length=30)


class CategoryPatch(CamelModel):
    name_en: str | None = Field(default=None, min_length=2, max_length=80)
    name_hi: str | None = Field(default=None, min_length=1, max_length=80)
    subtypes_en: list[str] | None = Field(default=None, max_length=30)
    subtypes_hi: list[str] | None = Field(default=None, max_length=30)
    active: bool | None = None


class BuildingIn(CamelModel):
    code: str = Field(pattern=r"^[A-Za-z0-9_-]{1,20}$")
    name_en: str = Field(min_length=2, max_length=80)
    name_hi: str = Field(min_length=1, max_length=80)
    floors: list[str] = Field(min_length=1, max_length=30)


class BuildingPatch(CamelModel):
    name_en: str | None = Field(default=None, min_length=2, max_length=80)
    name_hi: str | None = Field(default=None, min_length=1, max_length=80)
    floors: list[str] | None = Field(default=None, min_length=1, max_length=30)
    active: bool | None = None


def _clean_list(xs: list[str]) -> list[str]:
    out = [" ".join(x.split())[:80] for x in xs if x.strip()]
    return list(dict.fromkeys(out))


@router.post("/admin/categories", status_code=204)
async def add_category(body: CategoryIn, p: Principal = Depends(require("admin.catalogs")), db: AsyncSession = Depends(get_session)) -> Response:
    if len(body.subtypes_en) != len(body.subtypes_hi):
        raise validation("Give a Hindi name for each subtype.", {"subtypesHi": "Count mismatch"})
    # Letters are never recycled, even from inactive types (plan 7).
    if await db.scalar(select(Category.id).where((Category.code == body.code) | (Category.letter == body.letter))):
        raise conflict("category_exists", "That code or token letter is already used.")
    sort = (await db.scalar(select(func.max(Category.sort_order))) or 0) + 1
    db.add(Category(code=body.code, letter=body.letter, name_en=body.name_en.strip(), name_hi=body.name_hi.strip(),
                    subtypes_en=_clean_list(body.subtypes_en), subtypes_hi=_clean_list(body.subtypes_hi), active=True, sort_order=sort))
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="category.created", entity_type="category",
                 entity_id=body.code, after={"letter": body.letter, "name": body.name_en})
    await db.commit()
    return Response(status_code=204)


@router.patch("/admin/categories/{code}", status_code=204)
async def edit_category(code: str, body: CategoryPatch, p: Principal = Depends(require("admin.catalogs")),
                        db: AsyncSession = Depends(get_session)) -> Response:
    c = await db.scalar(select(Category).where(Category.code == code).with_for_update())
    if c is None:
        raise not_found()
    before = {"name_en": c.name_en, "active": c.active, "subtypes": c.subtypes_en}
    for f in ("name_en", "name_hi", "active"):
        v = getattr(body, f)
        if v is not None:
            setattr(c, f, v.strip() if isinstance(v, str) else v)
    if body.subtypes_en is not None:
        c.subtypes_en = _clean_list(body.subtypes_en)
    if body.subtypes_hi is not None:
        c.subtypes_hi = _clean_list(body.subtypes_hi)
    if len(c.subtypes_en) != len(c.subtypes_hi):
        raise validation("Give a Hindi name for each subtype.", {"subtypesHi": "Count mismatch"})
    if c.active is False and await db.scalar(select(func.count()).select_from(Category).where(Category.active)) <= 1:
        raise ApiError(409, "last_category", "At least one category must stay active.")
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="category.updated", entity_type="category",
                 entity_id=code, before=before, after={"name_en": c.name_en, "active": c.active, "subtypes": c.subtypes_en})
    await db.commit()
    return Response(status_code=204)


@router.post("/admin/buildings", status_code=204)
async def add_building(body: BuildingIn, p: Principal = Depends(require("admin.locations")), db: AsyncSession = Depends(get_session)) -> Response:
    if body.code.upper() == "CUSTOM":
        raise validation("CUSTOM is reserved for the Custom Location option.", {"code": "Reserved code"})
    if await db.scalar(select(Building.id).where(Building.code == body.code)):
        raise conflict("building_exists", "That building code is already used.")
    floors = _clean_list(body.floors)
    if not floors:
        raise validation("Give at least one floor or area.", {"floors": "Required"})
    sort = (await db.scalar(select(func.max(Building.sort_order))) or 0) + 1
    db.add(Building(code=body.code, name_en=body.name_en.strip(), name_hi=body.name_hi.strip(), floors=floors,
                    active=True, sort_order=sort))
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="building.created", entity_type="building",
                 entity_id=body.code, after={"name": body.name_en, "floors": body.floors})
    await db.commit()
    return Response(status_code=204)


@router.patch("/admin/buildings/{code}", status_code=204)
async def edit_building(code: str, body: BuildingPatch, p: Principal = Depends(require("admin.locations")),
                        db: AsyncSession = Depends(get_session)) -> Response:
    if code.upper() == "CUSTOM":
        raise not_found()
    b = await db.scalar(select(Building).where(Building.code == code).with_for_update())
    if b is None:
        raise not_found()
    before = {"name_en": b.name_en, "floors": b.floors, "active": b.active}
    for f in ("name_en", "name_hi", "active"):
        v = getattr(body, f)
        if v is not None:
            setattr(b, f, v.strip() if isinstance(v, str) else v)
    if body.floors is not None:
        floors = _clean_list(body.floors)
        if not floors:
            raise validation("Give at least one floor or area.", {"floors": "Required"})
        b.floors = floors
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="building.updated", entity_type="building",
                 entity_id=code, before=before, after={"name_en": b.name_en, "floors": b.floors, "active": b.active})
    await db.commit()
    return Response(status_code=204)
