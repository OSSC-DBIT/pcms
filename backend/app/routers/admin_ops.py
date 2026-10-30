"""Operational dashboard, exports and Team OSSC administration (plan 21.1, 18.2).

GET   /reports                        dashboard counts and response/resolution percentiles
GET   /reports/annual                 one calendar year of monthly ticket activity
GET   /reports/tickets.csv            ticket export (audited, formula-safe)
GET   /reports/export.xlsx            multi-sheet workbook export
GET   /reports/export.pdf             management-ready PDF report
GET   /admin/audit                    audit log (admin.audit)
GET   /admin/notifications            messages needing a person (failed or unknown delivery)
POST  /admin/notifications/{id}/retry | /dismiss
POST  /admin/categories   PATCH /admin/categories/{code}
POST  /admin/buildings    PATCH /admin/buildings/{code}
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
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
from app.services import reporting as rep
from app.services.csvsafe import to_csv
from app.services.pdf import MONTHS, ReportPDF
from app.services.tickets import ist_year
from app.services.xlsx import build_report_workbook, ist_stamp

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
                 department: str | None = Query(None, max_length=120), category: str | None = Query(None, max_length=40),
                 _: Principal = Depends(require("queue.view")), db: AsyncSession = Depends(get_session)) -> ReportOut:
    return await build_report(db, days, building, department, category)


async def build_report(db: AsyncSession, days: int, building: str | None,
                       department: str | None, category: str | None) -> ReportOut:
    """The dashboard the Reports page shows, reused by the PDF export."""
    await rep.validate_department(db, building, department)
    cid = await rep.category_id_of(db, category)
    since = now() - timedelta(days=days)
    scope_flt = rep.ticket_filters(building, department, cid)
    scope_sql, scope_params = rep.raw_scope(building, department, cid)
    params = {"since": since, **scope_params}

    flt = [Ticket.status.not_in(TERMINAL), *scope_flt]
    window_where = "t.created_at >= :since" + scope_sql
    open_q = select(Ticket).where(*flt).subquery()

    by_status = dict((await db.execute(select(open_q.c.status, func.count()).group_by(open_q.c.status))).all())
    by_priority = dict((await db.execute(select(open_q.c.priority, func.count()).group_by(open_q.c.priority))).all())
    overdue = await db.scalar(select(func.count()).select_from(open_q).where(open_q.c.next_update_due < now())) or 0
    holds = [{"reason": r, "count": n} for r, n in (await db.execute(
        select(open_q.c.hold_reason, func.count()).where(open_q.c.status == "OnHold")
        .group_by(open_q.c.hold_reason).order_by(func.count().desc()).limit(10))).all()]
    disputes = await db.scalar(text(
        "SELECT count(*) FROM ticket_event e JOIN ticket t ON t.id = e.ticket_id "
        "WHERE e.to_status = 'Triaged' AND e.from_status IN ('Resolved','Closed') "
        "AND e.at >= :since" + scope_sql), params) or 0
    failed = await db.scalar(select(func.count()).select_from(Outbox).where(Outbox.state == "action_required", Outbox.acknowledged.is_(False))) or 0
    repeat = [{"building": b, "room": r, "category": c, "count": n} for b, r, c, n in (await db.execute(text(f"""
        SELECT t.building_code, t.room, cat.code, count(*) FROM ticket t JOIN category cat ON cat.id = t.category_id
        WHERE {window_where} AND NOT t.outdoors GROUP BY 1, 2, 3 HAVING count(*) >= 2 ORDER BY 4 DESC LIMIT 10"""), params)).all()]
    triage = await _percentiles(db, "(SELECT min(e.at) FROM ticket_event e WHERE e.ticket_id = t.id AND e.to_status = 'Triaged') - t.created_at",
                                window_where, params)
    resolution = await _percentiles(db, "t.resolved_at - t.created_at", window_where + " AND t.resolved_at IS NOT NULL", params)
    approved = await db.scalar(text("""
        SELECT coalesce(sum(d.ceiling_paise), 0) FROM decision d WHERE d.kind = 'approved' AND d.decided_at >= :since"""),
        {"since": since}) or 0

    # Ratings are on closed tickets, so they use their own window and no open-status filter.
    rating_flt = [TicketRating.created_at >= since, *scope_flt]
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


class MonthPoint(CamelModel):
    """One calendar month of the annual overview. Buckets use Asia/Kolkata."""
    month: int
    created: int
    resolved: int
    pending: int
    overdue: int
    avg_resolution_hours: float | None


class AnnualOut(CamelModel):
    year: int
    months: list[MonthPoint]
    previous_created: list[int]
    previous_resolved: list[int]
    years: list[int]


@router.get("/reports/annual", response_model=AnnualOut)
async def annual_report(year: int | None = Query(None, ge=2000, le=2100), building: str | None = Query(None, max_length=20),
                        department: str | None = Query(None, max_length=120), category: str | None = Query(None, max_length=40),
                        _: Principal = Depends(require("queue.view")), db: AsyncSession = Depends(get_session)) -> AnnualOut:
    """Monthly aggregates for one calendar year, computed in SQL, never in the browser."""
    await rep.validate_department(db, building, department)
    cid = await rep.category_id_of(db, category)
    years = await rep.available_years(db)
    current = int(datetime.now(ZoneInfo(get_settings().timezone)).year)
    if not years:
        months = [MonthPoint(month=m, created=0, resolved=0, pending=0, overdue=0, avg_resolution_hours=None)
                  for m in range(1, 13)]
        return AnnualOut(year=year or current, months=months, previous_created=[0] * 12,
                         previous_resolved=[0] * 12, years=[])
    y = year if year and year in years else years[-1]
    counts, prev_created, prev_resolved = await rep.annual_counts(db, y, building, department, cid)
    months = [MonthPoint(month=m, created=counts["created"][m - 1], resolved=counts["resolved"][m - 1],
                         pending=counts["pending"][m - 1], overdue=counts["overdue"][m - 1],
                         avg_resolution_hours=counts["avgHours"][m - 1]) for m in range(1, 13)]
    return AnnualOut(year=y, months=months, previous_created=prev_created,
                     previous_resolved=prev_resolved, years=years)


@router.get("/reports/tickets.csv")
async def export_tickets(days: int = Query(90, ge=1, le=731), building: str | None = Query(None, max_length=20),
                         department: str | None = Query(None, max_length=120), category: str | None = Query(None, max_length=40),
                         p: Principal = Depends(require("queue.view")), db: AsyncSession = Depends(get_session)) -> Response:
    await rep.validate_department(db, building, department)
    cid = await rep.category_id_of(db, category)
    since = now() - timedelta(days=days)
    rows = (await db.execute(
        select(Ticket, Category.code, User.email, TicketRating.stars)
        .join(Category, Category.id == Ticket.category_id)
        .join(User, User.id == Ticket.reporter_id)
        .outerjoin(TicketRating, TicketRating.ticket_id == Ticket.id)
        .where(Ticket.created_at >= since, *rep.ticket_filters(building, department, cid))
        .order_by(Ticket.created_at))).all()
    body = to_csv(
        ["token", "created_at", "updated_at", "category", "subtype", "building", "department", "floor", "room",
         "outdoors", "priority", "status", "title", "resolved_at", "resolution_hours", "closed_at",
         "verified_by_reporter", "rating", "reporter_email"],
        [[t.token, t.created_at.isoformat(), t.updated_at.isoformat(), code, t.subtype or "", t.building_code or "",
          t.department or ("" if t.outdoors else t.custom_location or ""), t.floor or "", t.room or t.landmark or "",
          "yes" if t.outdoors else "", t.priority, t.status, t.title,
          t.resolved_at.isoformat() if t.resolved_at else "",
          f"{(t.resolved_at - t.created_at).total_seconds() / 3600.0:.1f}" if t.resolved_at else "",
          t.closed_at.isoformat() if t.closed_at else "",
          "" if t.verified_by_reporter is None else str(t.verified_by_reporter),
          "" if stars is None else str(stars), email]
         for t, code, email, stars in rows])
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="export.tickets", entity_type="export",
                 entity_id="tickets", after={"days": days, "building": building, "department": department,
                                             "category": category, "rows": len(rows)})
    await db.commit()
    return Response(body, media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="PCMS_Report_{now():%Y-%m-%d}.csv"', "Cache-Control": "no-store"})


@router.get("/reports/export.xlsx")
async def export_xlsx(days: int = Query(90, ge=1, le=731), building: str | None = Query(None, max_length=20),
                      department: str | None = Query(None, max_length=120), category: str | None = Query(None, max_length=40),
                      p: Principal = Depends(require("queue.view")), db: AsyncSession = Depends(get_session)) -> Response:
    """A styled multi-sheet workbook of the same filtered dataset as the CSV."""
    await rep.validate_department(db, building, department)
    cid = await rep.category_id_of(db, category)
    since = now() - timedelta(days=days)
    scope_flt = rep.ticket_filters(building, department, cid)
    scope_sql, params = rep.raw_scope(building, department, cid)
    date_col = "AT TIME ZONE '%s'" % get_settings().timezone  # fixed constant, safe to inline

    details = (await db.execute(
        select(Ticket, Category, User.email, TicketRating.stars)
        .join(Category, Category.id == Ticket.category_id)
        .join(User, User.id == Ticket.reporter_id)
        .outerjoin(TicketRating, TicketRating.ticket_id == Ticket.id)
        .where(Ticket.created_at >= since, *scope_flt).order_by(Ticket.created_at))).all()
    sheet_details = ([["token", "created_at", "updated_at", "category", "subtype", "building", "department",
                       "floor", "room", "outdoors", "priority", "status", "title",
                       "resolved_at", "closed_at", "rating", "reporter_email"]]
                     + [[t.token, ist_stamp(t.created_at), ist_stamp(t.updated_at), cat.name_en, t.subtype or "",
                         t.building_code or "", t.department or ("" if t.outdoors else t.custom_location or ""),
                         t.floor or "", t.room or t.landmark or "", "yes" if t.outdoors else "", t.priority, t.status,
                         t.title, ist_stamp(t.resolved_at) if t.resolved_at else "", ist_stamp(t.closed_at) if t.closed_at else "",
                         "" if stars is None else str(stars), email]
                        for t, cat, email, stars in details])

    month_created = dict((await db.execute(text(f"""
        SELECT to_char(t.created_at {date_col}, 'YYYY-MM') AS m, count(*)
        FROM ticket t WHERE t.created_at >= :since{scope_sql} GROUP BY 1 ORDER BY 1"""), {"since": since, **params})).all())
    month_resolved = dict((await db.execute(text(f"""
        SELECT to_char(t.resolved_at {date_col}, 'YYYY-MM') AS m, count(*)
        FROM ticket t WHERE t.resolved_at IS NOT NULL AND t.resolved_at >= :since{scope_sql}
        GROUP BY 1 ORDER BY 1"""), {"since": since, **params})).all())
    months = sorted(set(month_created) | set(month_resolved))
    sheet_months = ([["month", "created", "resolved"]]
                    + [[m, str(month_created.get(m, 0)), str(month_resolved.get(m, 0))] for m in months])

    by_category = (await db.execute(text(f"""
        SELECT cat.code, cat.name_en, count(*) FROM ticket t JOIN category cat ON cat.id = t.category_id
        WHERE t.created_at >= :since{scope_sql} GROUP BY 1, 2 ORDER BY 3 DESC"""), {"since": since, **params})).all()
    sheet_category = ([["category_code", "category", "reports"]]
                      + [[code, name, str(n)] for code, name, n in by_category])

    by_place = (await db.execute(text(f"""
        SELECT coalesce(t.building_code, 'CUSTOM') AS b, coalesce(t.department, '') AS d, count(*)
        FROM ticket t WHERE t.created_at >= :since{scope_sql} GROUP BY 1, 2 ORDER BY 3 DESC"""), {"since": since, **params})).all()
    sheet_place = ([["building", "department", "reports"]]
                   + [[b_code, dept, str(n)] for b_code, dept, n in by_place])

    rating_flt = [TicketRating.created_at >= since, *scope_flt]
    rating_count = await db.scalar(select(func.count()).select_from(TicketRating).join(
        Ticket, Ticket.id == TicketRating.ticket_id).where(*rating_flt)) or 0
    rating_avg = await db.scalar(select(func.avg(TicketRating.stars)).join(
        Ticket, Ticket.id == TicketRating.ticket_id).where(*rating_flt))
    dist = {str(s): 0 for s in range(1, 6)}
    for stars, n in (await db.execute(select(TicketRating.stars, func.count()).join(
            Ticket, Ticket.id == TicketRating.ticket_id).where(*rating_flt).group_by(TicketRating.stars))).all():
        dist[str(stars)] = n
    sheet_ratings = ([["total_rated", "average_stars"], [str(rating_count), f"{rating_avg:.2f}" if rating_avg is not None else ""]]
                     + [[f"{s} stars", str(dist[str(s)])] for s in range(5, 0, -1)])

    wb_bytes = build_report_workbook([
        ("Ticket Details", tuple(sheet_details[0]), sheet_details[1:], (18, 20, 20, 16, 28, 12, 34, 9, 18, 9, 9, 14, 40, 20, 20, 8, 30)),
        ("Monthly Summary", tuple(sheet_months[0]), sheet_months[1:], (14, 11, 11)),
        ("Category Summary", tuple(sheet_category[0]), sheet_category[1:], (16, 34, 11)),
        ("Building and Department Summary", tuple(sheet_place[0]), sheet_place[1:], (18, 38, 10)),
        ("Ratings Summary", tuple(sheet_ratings[0]), sheet_ratings[1:], (16, 14)),
    ])
    stamp = now().strftime("%Y-%m-%d")
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="export.tickets", entity_type="export",
                 entity_id="report.xlsx", after={"days": days, "building": building, "department": department,
                                                 "category": category, "rows": len(details)})
    await db.commit()
    return Response(wb_bytes, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="PCMS_Report_{stamp}.xlsx"',
                             "Cache-Control": "no-store"})


@router.get("/reports/export.pdf")
async def export_pdf(days: int = Query(90, ge=1, le=731), building: str | None = Query(None, max_length=20),
                     department: str | None = Query(None, max_length=120), category: str | None = Query(None, max_length=40),
                     p: Principal = Depends(require("queue.view")), db: AsyncSession = Depends(get_session)) -> Response:
    """A management-ready sheet of the dashboard KPIs, the year's monthly chart and period breakdowns."""
    gen = now()
    ist = ZoneInfo(get_settings().timezone)
    cid = await rep.category_id_of(db, category)
    b_row = (await db.scalar(select(Building).where(Building.code == building))) if building else None
    r = await build_report(db, days, building, department, category)
    since = gen - timedelta(days=days)
    scope_flt = rep.ticket_filters(building, department, cid)
    created_in = await db.scalar(
        select(func.count()).select_from(Ticket).where(Ticket.created_at >= since, *scope_flt)) or 0
    resolved_in = await db.scalar(
        select(func.count()).select_from(Ticket).where(Ticket.resolved_at >= since, *scope_flt)) or 0

    doc = ReportPDF()
    doc.text("PCMS - Campus Maintenance", 9, gray=True)
    doc.text("Don Bosco Institute of Technology, Bengaluru", 12, bold=True)
    doc.rule()
    doc.text("Maintenance Report", 16, bold=True)
    doc.text(f"Period: {rep.period_label(days, gen)}   Place: {rep.filter_label(b_row, building, department)}"
             + (f"   Type: {category}" if category else ""), 10, gray=True)
    doc.text(f"Generated {gen.astimezone(ist):%d %b %Y, %H:%M IST} by {p.user.name}. Open-ticket counts are the "
             "current snapshot; created and resolved counts cover the period above.", 9, gray=True)

    def stars_fmt() -> str:
        return f"{r.ratings.average:.1f} of 5" if r.ratings.average is not None else "not yet rated"

    doc.text("KPI summary", 12, bold=True)
    doc.table(["Metric", "Value"], [
        ["Created in period", str(created_in)],
        ["Resolved in period", str(resolved_in)],
        ["Open now (snapshot)", str(sum(r.open_by_status.values()))],
        ["Untriaged (snapshot)", str(r.untriaged)],
        ["Update overdue (snapshot)", str(r.overdue_updates)],
        ["Waiting approval (snapshot)", str(r.pending_approvals)],
        ["Disputed fixes in period", str(r.disputes)],
        ["Approved spend in period", f"Rs {r.approved_paise / 100:.2f}"],
        ["Fixes rated in period", str(r.ratings.count)],
        ["Average rating", stars_fmt()],
    ], [250, 120])
    doc.text(f"Time to triage - median {_h(r.triage_time.median_hours)}, 90th percentile {_h(r.triage_time.p90_hours)}.", 10)
    doc.text(f"Time to fix - median {_h(r.resolution_time.median_hours)}, 90th percentile {_h(r.resolution_time.p90_hours)}.", 10)

    year = ist_year()
    counts, _, _ = await rep.annual_counts(db, year, building, department, cid)
    doc.text(f"Monthly activity - {year}", 12, bold=True)
    if max(counts["created"] + counts["resolved"]) > 0:
        doc.bars(list(MONTHS), [("Created", counts["created"], "0.22 g"), ("Resolved", counts["resolved"], "0.58 g")])
    else:
        doc.text(f"No tickets were recorded in {year} for this scope.", 10, gray=True)

    doc.text("Open by status (snapshot)", 12, bold=True)
    doc.table(["Status", "Tickets"], sorted((s, str(n)) for s, n in r.open_by_status.items()), [250, 90])
    doc.text("Open by priority (snapshot)", 12, bold=True)
    doc.table(["Priority", "Tickets"], sorted((s, str(n)) for s, n in r.open_by_priority.items()), [250, 90])

    scope_sql, scope_params = rep.raw_scope(building, department, cid)
    by_type = (await db.execute(text(f"""
        SELECT cat.name_en, count(*) FROM ticket t JOIN category cat ON cat.id = t.category_id
        WHERE t.created_at >= :since{scope_sql}
        GROUP BY 1 ORDER BY 2 DESC"""), {"since": since, **scope_params})).all()
    doc.text("Reports by type (period)", 12, bold=True)
    if by_type:
        doc.table(["Category", "Reports"], [[name, str(n)] for name, n in by_type], [250, 90])
    else:
        doc.text("No tickets in the period for this scope.", 10, gray=True)

    where_sql, where_params = scope_sql, scope_params
    by_place = (await db.execute(text(f"""
        SELECT coalesce(t.building_code, 'CUSTOM'), coalesce(t.department, ''), count(*)
        FROM ticket t WHERE t.created_at >= :since{where_sql} GROUP BY 1, 2 ORDER BY 1, 3 DESC"""),
        {"since": since, **where_params})).all()
    doc.text("Reports by building and department (period)", 12, bold=True)
    if by_place:
        doc.table(["Building", "Department", "Reports"],
                  [[b_code, dept or "-", str(n)] for b_code, dept, n in by_place[:120]], [170, 200, 80])
    else:
        doc.text("No tickets in the period for this scope.", 10, gray=True)

    rr = r.ratings
    if rr.count:
        doc.text("Repair ratings (period)", 12, bold=True)
        doc.text(f"{rr.count} reporters rated their repair. Average {rr.average:.2f} of 5. "
                 "Stars: " + ", ".join(f"{s}- {rr.distribution[str(s)]}" for s in range(5, 0, -1)), 10)
        if rr.low:
            doc.table(["Token", "Type", "Stars", "Comment"], [[l.token, l.category, str(l.stars), l.comment or "-"]
                                                              for l in rr.low], [90, 110, 40, 210])

    doc.rule()
    doc.text("Every export is recorded in the audit log. PCMS serves DBIT Bengaluru.", 8.5, gray=True)
    pdf_bytes = doc.bytes()
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="export.tickets", entity_type="export",
                 entity_id="report.pdf", after={"days": days, "building": building, "department": department,
                                                "category": category, "kpi_created": created_in,
                                                "kpi_resolved": resolved_in})
    await db.commit()
    return Response(pdf_bytes, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="PCMS_Report_{gen:%Y-%m-%d}.pdf"', "Cache-Control": "no-store"})


def _h(hours: float | None) -> str:
    """Human hours, used by the report PDF."""
    return f"{hours:.1f} h" if hours is not None else "not yet"



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
    name_kn: str = Field(default="", max_length=80)
    subtypes_en: list[str] = Field(default_factory=list, max_length=30)
    subtypes_hi: list[str] = Field(default_factory=list, max_length=30)
    subtypes_kn: list[str] = Field(default_factory=list, max_length=30)


class CategoryPatch(CamelModel):
    name_en: str | None = Field(default=None, min_length=2, max_length=80)
    name_hi: str | None = Field(default=None, min_length=1, max_length=80)
    name_kn: str | None = Field(default=None, min_length=1, max_length=80)
    subtypes_en: list[str] | None = Field(default=None, max_length=30)
    subtypes_hi: list[str] | None = Field(default=None, max_length=30)
    subtypes_kn: list[str] | None = Field(default=None, max_length=30)
    active: bool | None = None


class BuildingIn(CamelModel):
    code: str = Field(pattern=r"^[A-Za-z0-9_-]{1,20}$")
    name_en: str = Field(min_length=2, max_length=80)
    name_hi: str = Field(min_length=1, max_length=80)
    name_kn: str = Field(default="", max_length=80)
    floors: list[str] = Field(min_length=1, max_length=30)
    departments: list[str] = Field(default_factory=list, max_length=30)
    departments_kn: list[str] = Field(default_factory=list, max_length=30)


class BuildingPatch(CamelModel):
    name_en: str | None = Field(default=None, min_length=2, max_length=80)
    name_hi: str | None = Field(default=None, min_length=1, max_length=80)
    name_kn: str | None = Field(default=None, min_length=1, max_length=80)
    floors: list[str] | None = Field(default=None, min_length=1, max_length=30)
    departments: list[str] | None = Field(default=None, max_length=30)
    departments_kn: list[str] | None = Field(default=None, max_length=30)
    active: bool | None = None


def _clean_list(xs: list[str]) -> list[str]:
    out = [" ".join(x.split())[:80] for x in xs if x.strip()]
    return list(dict.fromkeys(out))


def _localised_name(name_en: str, name: str) -> str:
    return name.strip() or name_en.strip()


def _localised_list(en: list[str], other: list[str]) -> list[str]:
    return other if len(other) == len(en) else en


@router.post("/admin/categories", status_code=204)
async def add_category(body: CategoryIn, p: Principal = Depends(require("admin.catalogs")), db: AsyncSession = Depends(get_session)) -> Response:
    if len(body.subtypes_en) != len(body.subtypes_hi):
        raise validation("Give a Hindi name for each subtype.", {"subtypesHi": "Count mismatch"})
    if body.subtypes_kn and len(body.subtypes_kn) != len(body.subtypes_en):
        raise validation("Give a Kannada name for each subtype.", {"subtypesKn": "Count mismatch"})
    # Letters are never recycled, even from inactive types (plan 7).
    if await db.scalar(select(Category.id).where((Category.code == body.code) | (Category.letter == body.letter))):
        raise conflict("category_exists", "That code or token letter is already used.")
    sort = (await db.scalar(select(func.max(Category.sort_order))) or 0) + 1
    name_en = body.name_en.strip()
    subtypes_en = _clean_list(body.subtypes_en)
    subtypes_kn = _localised_list(subtypes_en, _clean_list(body.subtypes_kn))
    db.add(Category(code=body.code, letter=body.letter, name_en=name_en, name_hi=body.name_hi.strip(),
                    name_kn=_localised_name(name_en, body.name_kn), subtypes_en=subtypes_en,
                    subtypes_hi=_clean_list(body.subtypes_hi), subtypes_kn=subtypes_kn, active=True, sort_order=sort))
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="category.created", entity_type="category",
                 entity_id=body.code, after={"letter": body.letter, "name": name_en})
    await db.commit()
    return Response(status_code=204)


@router.patch("/admin/categories/{code}", status_code=204)
async def edit_category(code: str, body: CategoryPatch, p: Principal = Depends(require("admin.catalogs")),
                        db: AsyncSession = Depends(get_session)) -> Response:
    c = await db.scalar(select(Category).where(Category.code == code).with_for_update())
    if c is None:
        raise not_found()
    before = {"name_en": c.name_en, "name_kn": c.name_kn, "active": c.active, "subtypes": c.subtypes_en}
    for f in ("name_en", "name_hi", "name_kn", "active"):
        v = getattr(body, f)
        if v is not None:
            setattr(c, f, v.strip() if isinstance(v, str) else v)
    if body.subtypes_en is not None:
        c.subtypes_en = _clean_list(body.subtypes_en)
    if body.subtypes_hi is not None:
        c.subtypes_hi = _clean_list(body.subtypes_hi)
    if body.subtypes_kn is not None:
        c.subtypes_kn = _clean_list(body.subtypes_kn)
    if len(c.subtypes_en) != len(c.subtypes_hi):
        raise validation("Give a Hindi name for each subtype.", {"subtypesHi": "Count mismatch"})
    c.subtypes_kn = _localised_list(c.subtypes_en, c.subtypes_kn)
    if c.active is False and await db.scalar(select(func.count()).select_from(Category).where(Category.active)) <= 1:
        raise ApiError(409, "last_category", "At least one category must stay active.")
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="category.updated", entity_type="category",
                 entity_id=code, before=before, after={"name_en": c.name_en, "name_kn": c.name_kn,
                                                       "active": c.active, "subtypes": c.subtypes_en})
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
    if body.departments_kn and len(body.departments_kn) != len(body.departments):
        raise validation("Give a Kannada name for each department or area.", {"departmentsKn": "Count mismatch"})
    sort = (await db.scalar(select(func.max(Building.sort_order))) or 0) + 1
    name_en = body.name_en.strip()
    departments = _clean_list(body.departments)
    departments_kn = _localised_list(departments, _clean_list(body.departments_kn))
    db.add(Building(code=body.code, name_en=name_en, name_hi=body.name_hi.strip(),
                    name_kn=_localised_name(name_en, body.name_kn), floors=floors,
                    departments=departments, departments_kn=departments_kn, active=True, sort_order=sort))
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="building.created", entity_type="building",
                 entity_id=body.code, after={"name": name_en, "floors": body.floors,
                                             "departments": body.departments})
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
    before = {"name_en": b.name_en, "name_kn": b.name_kn, "floors": b.floors,
              "departments": b.departments, "active": b.active}
    for f in ("name_en", "name_hi", "name_kn", "active"):
        v = getattr(body, f)
        if v is not None:
            setattr(b, f, v.strip() if isinstance(v, str) else v)
    if body.floors is not None:
        floors = _clean_list(body.floors)
        if not floors:
            raise validation("Give at least one floor or area.", {"floors": "Required"})
        b.floors = floors
    if body.departments is not None:
        b.departments = _clean_list(body.departments)
    if body.departments_kn is not None:
        b.departments_kn = _clean_list(body.departments_kn)
    b.departments_kn = _localised_list(b.departments, b.departments_kn)
    audit.record(db, actor_id=p.user.id, actor_label=p.user.name, action="building.updated", entity_type="building",
                 entity_id=code, before=before, after={"name_en": b.name_en, "name_kn": b.name_kn,
                                                       "floors": b.floors, "departments": b.departments,
                                                       "active": b.active})
    await db.commit()
    return Response(status_code=204)
