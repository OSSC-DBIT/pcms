"""Opaque server-side sessions carried in an HttpOnly cookie.

The cookie holds a random token; only its SHA-256 is stored. The CSRF token is
bound to the session and mirrored in a readable cookie for the double-submit
check (header X-CSRF-Token must equal the session's token).
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.session import UserSession
from app.models.user import User


def now() -> datetime:
    return datetime.now(UTC)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def client_ip(request: Request) -> str:
    return (request.client.host if request.client else "unknown")[:64]


async def create_session(db: AsyncSession, user: User, request: Request, *, mfa_ok: bool) -> tuple[UserSession, str]:
    s = get_settings()
    token = secrets.token_urlsafe(32)
    sess = UserSession(
        token_hash=hash_token(token),
        user_id=user.id,
        csrf_token=secrets.token_urlsafe(32),
        mfa_ok=mfa_ok,
        expires_at=now() + timedelta(hours=s.session_hours),
        ip=client_ip(request),
        user_agent=(request.headers.get("user-agent") or "")[:255],
    )
    db.add(sess)
    await db.flush()
    return sess, token


def rotate(sess: UserSession) -> str:
    """Issue a fresh token and CSRF value, e.g. after the second factor succeeds."""
    token = secrets.token_urlsafe(32)
    sess.token_hash = hash_token(token)
    sess.csrf_token = secrets.token_urlsafe(32)
    return token


def set_cookies(response: Response, token: str, csrf: str) -> None:
    s = get_settings()
    max_age = s.session_hours * 3600
    response.set_cookie(s.session_cookie, token, max_age=max_age, httponly=True,
                        secure=s.cookie_secure, samesite="lax", path="/")
    response.set_cookie(s.csrf_cookie, csrf, max_age=max_age, httponly=False,
                        secure=s.cookie_secure, samesite="lax", path="/")


def clear_cookies(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(s.session_cookie, path="/")
    response.delete_cookie(s.csrf_cookie, path="/")


async def load_session(db: AsyncSession, token: str | None) -> tuple[UserSession, User] | None:
    if not token or len(token) > 128:
        return None
    row = (await db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(UserSession.token_hash == hash_token(token),
               UserSession.revoked_at.is_(None),
               UserSession.expires_at > now())
    )).first()
    if row is None:
        return None
    return row[0], row[1]


async def revoke_all_for_user(db: AsyncSession, user_id) -> None:
    await db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now())
    )
