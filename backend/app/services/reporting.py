"""Reporting filters shared by the dashboard, annual overview and downloads.

Every report, chart and export in PCMS must answer two questions the same way:
which rows are in scope, and where in the period the row was counted. This
module owns both answers so Admin, facility manager and management screens
cannot drift apart.

Scope: reports only read tickets. Nothing here exposes identities, internal
notes or worker names.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import not_found, validation
from app.models import Building, Category
from app.models.ticket import TERMINAL, Ticket
from app.security.sessions import now

MAX_RANGE_DAYS = 731


def window(days: int | None, start: date | None, end: date | None,
           default_days: int = 30) -> tuple[datetime, datetime, str]:
    """The reporting period as [since, until), plus a label for downloads.

    The screens send a From date and a To date. Both are whole days in the campus
    timezone (Asia/Kolkata) and both are included. `days` (the last N days up to
    now) remains only for older callers.
    """
    if start is None and end is None:
        n = days or default_days
        until = now()
        return until - timedelta(days=n), until, period_label(n, until)
    tz = ZoneInfo(get_settings().timezone)
    end = end or datetime.now(tz).date()
    start = start or end - timedelta(days=29)
    if start > end:
        raise validation("The start date must be on or before the end date.", {"from": "After the end date"})
    if (end - start).days > MAX_RANGE_DAYS:
        raise validation("Choose a period of at most two years.", {"from": "Period too long"})
    since = datetime.combine(start, time.min, tz)
    until = datetime.combine(end + timedelta(days=1), time.min, tz)
    return since, until, f"{start:%d %b %Y} - {end:%d %b %Y}"


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


def day_range(start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]:
    """A From and a To date as whole campus-local days, both included. Either may be left open."""
    if start and end and start > end:
        raise validation("The start date must be on or before the end date.", {"from": "After the end date"})
    tz = ZoneInfo(get_settings().timezone)
    return (datetime.combine(start, time.min, tz) if start else None,
            datetime.combine(end + timedelta(days=1), time.min, tz) if end else None)


def file_stamp(since: datetime, until: datetime) -> str:
    """The period in a download's file name, for example 2026-10-01_to_2026-10-31."""
    tz = ZoneInfo(get_settings().timezone)
    first = since.astimezone(tz).date()
    last = (until - timedelta(microseconds=1)).astimezone(tz).date()
    return f"{first:%Y-%m-%d}_to_{last:%Y-%m-%d}"


# ---------- expenditure ----------
#
# One row per expenditure request. When the principal escalates a request, the
# escalated version is carried on as the next version (decided by institute
# management), so it is shown once: on the version that holds the final
# decision, dated from when the request was first raised.
#
# PCMS records the amount each request was approved up to, not invoices, so
# "approved" means the authorised limit.

EXPENDITURE_COLUMNS = ("token", "title", "category", "building", "department", "raised_on", "requested_by",
                       "estimate_inr", "status", "decided_by", "decided_on", "approved_limit_inr",
                       "escalated_to_management", "note")
EXPENDITURE_WIDTHS = (14, 36, 18, 14, 30, 12, 22, 14, 30, 22, 12, 18, 12, 40)
STATUS_TEXT = {"pending_principal": "Awaiting the principal", "pending_management": "Awaiting institute management",
               "approved": "Approved", "rejected": "Rejected", "clarify": "Clarification requested",
               "defer": "Deferred", "superseded": "Superseded"}


def inr(paise: int | None) -> str:
    """Rupees with two decimals, as plain text that every spreadsheet reads as a number."""
    return "" if paise is None else f"{paise / 100:.2f}"


async def expenditure(db: AsyncSession, since: datetime, until: datetime, building: str | None,
                      department: str | None, category_id: int | None) -> dict:
    where, params = raw_scope(building, department, category_id)
    params.update(since=since, until=until)
    rows = (await db.execute(text(f"""
        SELECT t.id, t.token, t.title, cat.name_en, t.building_code, t.department,
               coalesce(prev.created_at, pr.created_at) AS raised_at, req.name,
               pr.total_paise, pr.state, pr.stage, dby.name, d.decided_at, d.ceiling_paise,
               prev.id IS NOT NULL, coalesce(d.reason, d.conditions, pd.reason)
        FROM proposal pr
        JOIN ticket t ON t.id = pr.ticket_id
        JOIN category cat ON cat.id = t.category_id
        JOIN app_user req ON req.id = pr.requested_by
        LEFT JOIN proposal prev ON prev.ticket_id = pr.ticket_id AND prev.version = pr.version - 1
                                AND prev.state = 'escalated'
        LEFT JOIN decision pd ON pd.proposal_id = prev.id
        LEFT JOIN decision d ON d.proposal_id = pr.id
        LEFT JOIN app_user dby ON dby.id = d.decided_by
        WHERE pr.state <> 'escalated'
          AND coalesce(prev.created_at, pr.created_at) >= :since
          AND coalesce(prev.created_at, pr.created_at) < :until{where}
        ORDER BY raised_at DESC, t.token
    """), params)).all()

    items, cats = [], {}
    for (tid, token, title, cat, bcode, dept, raised, req, total, state, stage, dec_name, dec_at, ceiling,
         escalated, note) in rows:
        status = f"pending_{stage}" if state == "pending" else state
        approved = (ceiling or 0) if state == "approved" else None
        items.append(dict(ticket_id=tid, token=token, title=title, category=cat, building=bcode, department=dept,
                          raised_at=raised, requested_by=req, estimate_paise=total, status=status,
                          decided_by=dec_name, decided_at=dec_at, approved_paise=approved, escalated=escalated,
                          note=note))
        c = cats.setdefault(cat, {"category": cat, "requests": 0, "requested_paise": 0, "approved_paise": 0})
        c["requests"] += 1
        c["requested_paise"] += total
        c["approved_paise"] += approved or 0
    pending = [i for i in items if i["status"].startswith("pending")]
    return dict(requests=len(items), requested_paise=sum(i["estimate_paise"] for i in items),
                approved_paise=sum(i["approved_paise"] or 0 for i in items),
                pending_paise=sum(i["estimate_paise"] for i in pending),
                approved_count=sum(i["status"] == "approved" for i in items), pending_count=len(pending),
                rejected_count=sum(i["status"] == "rejected" for i in items),
                by_category=sorted(cats.values(), key=lambda c: -c["requested_paise"]), items=items)


def expenditure_cells(i: dict) -> list[str]:
    tz = ZoneInfo(get_settings().timezone)

    def day(v: datetime | None) -> str:
        return v.astimezone(tz).strftime("%Y-%m-%d") if v else ""

    return [i["token"], i["title"], i["category"], i["building"] or "", i["department"] or "", day(i["raised_at"]),
            i["requested_by"], inr(i["estimate_paise"]), STATUS_TEXT.get(i["status"], i["status"]),
            i["decided_by"] or "", day(i["decided_at"]), inr(i["approved_paise"]),
            "yes" if i["escalated"] else "", i["note"] or ""]
