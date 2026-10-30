"""Reporting filters shared by the dashboard, annual overview and downloads.

Every report, chart and export in PCMS must answer two questions the same way:
which rows are in scope, and where in the period the row was counted. This
module owns both answers so Admin, facility manager and management screens
cannot drift apart.

Scope: reports only read tickets. Nothing here exposes identities, internal
notes or worker names.
"""

from datetime import datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import not_found, validation
from app.models import Building, Category
from app.models.ticket import TERMINAL, Ticket


async def validate_department(db: AsyncSession, building: str | None, department: str | None) -> None:
    """A department filter is only meaningful with its building (and must exist).

    Retired buildings stay filterable: reports must keep answering questions
    about historical tickets, so only the department must belong to the
    building's stored catalog.
    """
    if not department:
        return
    if not building:
        raise validation("Choose a building before filtering by department.", {"department": "Needs building"})
    b = await db.scalar(select(Building).where(Building.code == building))
    if b is None:
        raise not_found()
    if department not in b.departments:
        raise validation("That department or area does not belong to the selected building.",
                         {"department": "Unknown for building"})


def ticket_filters(building: str | None, department: str | None, category_id: int | None):
    """ORM filters for the Ticket model shared by dashboard queries and exports."""
    flt = []
    if building:
        flt.append(Ticket.building_code == building)
    if department:
        flt.append(Ticket.department == department)
    if category_id is not None:
        flt.append(Ticket.category_id == category_id)
    return flt


def raw_scope(building: str | None, department: str | None, category_id: int | None) -> tuple[str, dict]:
    """WHERE fragments for raw SQL over `ticket t`, for joins into ticket_event."""
    clauses, params = [], {}
    if building:
        clauses.append("t.building_code = :b")
        params["b"] = building
    if department:
        clauses.append("t.department = :dept")
        params["dept"] = department
    if category_id is not None:
        clauses.append("t.category_id = :c")
        params["c"] = category_id
    return ("".join(f" AND {c}" for c in clauses), params)


def year_expr() -> str:
    """Local calendar bucketing with the configured campus timezone."""
    return "AT TIME ZONE :tz"


async def category_id_of(db: AsyncSession, category: str | None) -> int | None:
    if not category:
        return None
    cid = await db.scalar(select(Category.id).where(Category.code == category))
    if cid is None:
        raise not_found()
    return cid


async def available_years(db: AsyncSession) -> list[int]:
    """Calendar years that actually contain tickets, oldest first."""
    rows = (await db.execute(text(
        "SELECT DISTINCT extract(year FROM created_at %s)::int AS y FROM ticket ORDER BY 1" % year_expr()),
        {"tz": get_settings().timezone})).all()
    return [r[0] for r in rows]


async def annual_counts(db: AsyncSession, year: int, building: str | None,
                        department: str | None, category_id: int | None) -> tuple[dict, list[int], list[int]]:
    """One year of monthly maintenance activity, all computed in SQL.

    Definitions (kept deliberately plain, and the same in the UI and PDF):
      created   - tickets raised in that month;
      resolved  - tickets marked fixed in that month, whenever they were raised;
      pending   - tickets raised in that month that are still open today;
      overdue   - open tickets raised in that month whose update is overdue;
      avgHours  - mean hours to fix among tickets resolved in that month;
                  unresolved tickets are never counted as resolutions.

    Returns (months, previous year created, previous year resolved).
    """
    tz = get_settings().timezone
    where, params = raw_scope(building, department, category_id)
    # TERMINAL is a fixed module constant, never user input, so it is safe to inline.
    terminal = "(" + ", ".join(f"'{s}'" for s in TERMINAL) + ")"
    params.update(tz=tz, year=year, prior=year - 1)

    created, pending, overdue = [0] * 12, [0] * 12, [0] * 12
    rows = (await db.execute(text(f"""
        SELECT extract(month FROM t.created_at {year_expr()})::int AS m, count(*),
               count(*) FILTER (WHERE t.status NOT IN {terminal}),
               count(*) FILTER (WHERE t.status NOT IN {terminal} AND t.next_update_due < now())
        FROM ticket t
        WHERE extract(year FROM t.created_at {year_expr()}) = :year{where}
        GROUP BY 1
    """), params)).all()
    for m, n, p, o in rows:
        created[m - 1], pending[m - 1], overdue[m - 1] = n, p, o

    resolved, hours = [0] * 12, [None] * 12
    rows = (await db.execute(text(f"""
        SELECT extract(month FROM t.resolved_at {year_expr()})::int AS m, count(*),
               avg(extract(epoch FROM t.resolved_at - t.created_at)) / 3600.0
        FROM ticket t
        WHERE t.resolved_at IS NOT NULL
          AND extract(year FROM t.resolved_at {year_expr()}) = :year{where}
        GROUP BY 1
    """), params)).all()
    for m, n, h in rows:
        resolved[m - 1] = n
        hours[m - 1] = round(float(h), 1) if h is not None else None

    prev_created, prev_resolved = [0] * 12, [0] * 12
    rows = (await db.execute(text(f"""
        SELECT extract(month FROM t.created_at {year_expr()})::int AS m, count(*),
               count(*) FILTER (WHERE t.resolved_at {year_expr()} IS NOT NULL)
        FROM ticket t
        WHERE extract(year FROM t.created_at {year_expr()}) = :prior{where}
        GROUP BY 1
    """), params)).all()
    for m, n, r in rows:
        prev_created[m - 1], prev_resolved[m - 1] = n, r

    return ({"created": created, "resolved": resolved, "pending": pending, "overdue": overdue,
             "avgHours": hours}, prev_created, prev_resolved)


def filter_label(building_row: Building | None, building: str | None, department: str | None) -> str:
    """Human-readable place filter for exports and PDFs."""
    if not building:
        return "All buildings"
    label = building_row.name_en if building_row else building
    return f"{label}{f' - {department}' if department else ''}"


def period_label(days: int, today: datetime) -> str:
    """Human-readable date window, shown on every download."""
    return f"{today - timedelta(days=days):%d %b %Y} - {today:%d %b %Y}"
