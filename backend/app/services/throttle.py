"""Sliding-window sign-in throttling stored in PostgreSQL.

Failures are counted per employee ID and per client IP inside a short window.
The window expires on its own, so there is no permanent lockout to abuse.
"""

from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import ApiError
from app.models.session import ThrottleEvent
from app.security.sessions import now

IP_MULTIPLIER = 4


def _keys(employee_id: str, ip: str) -> list[tuple[str, int]]:
    limit = get_settings().signin_max_attempts
    return [(f"emp:{employee_id}", limit), (f"ip:{ip}", limit * IP_MULTIPLIER)]


async def check(db: AsyncSession, employee_id: str, ip: str) -> None:
    window_start = now() - timedelta(seconds=get_settings().signin_window_seconds)
    for key, limit in _keys(employee_id, ip):
        await db.execute(delete(ThrottleEvent).where(ThrottleEvent.key == key, ThrottleEvent.at < window_start))
        count = await db.scalar(select(func.count()).select_from(ThrottleEvent).where(ThrottleEvent.key == key))
        if (count or 0) >= limit:
            raise ApiError(429, "throttled", "Too many sign-in attempts. Wait a few minutes and try again.")


async def record_failure(db: AsyncSession, employee_id: str, ip: str) -> None:
    for key, _ in _keys(employee_id, ip):
        db.add(ThrottleEvent(key=key))


async def clear(db: AsyncSession, employee_id: str) -> None:
    await db.execute(delete(ThrottleEvent).where(ThrottleEvent.key == f"emp:{employee_id}"))
