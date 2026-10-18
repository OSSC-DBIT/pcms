"""Request authentication and authorisation dependencies.

Every protected route depends on current_principal (or require(cap)), which:
  1. resolves the session cookie to an active, unexpired session and active user,
  2. requires the second factor for admin-portal roles,
  3. enforces the CSRF double-submit header on unsafe methods.
"""

import hmac
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError, forbidden
from app.models.session import UserSession
from app.models.user import User
from app.security.roles import capabilities_for
from app.security.sessions import load_session

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class Principal:
    user: User
    session: UserSession

    @property
    def capabilities(self) -> list[str]:
        return capabilities_for(self.user.role)

    def can(self, cap: str) -> bool:
        return cap in self.capabilities

    @property
    def label(self) -> str:
        return self.user.name


def unauthenticated(code: str = "unauthenticated", message: str = "Sign in to continue.") -> ApiError:
    return ApiError(401, code, message)


def check_csrf(request: Request, sess: UserSession) -> None:
    if request.method in SAFE_METHODS:
        return
    sent = request.headers.get("x-csrf-token", "")
    if not sent or not hmac.compare_digest(sent, sess.csrf_token):
        raise ApiError(403, "csrf_failed", "Your session check failed. Refresh the page and try again.")


async def _resolve(request: Request, db: AsyncSession) -> tuple[UserSession, User]:
    token = request.cookies.get(get_settings().session_cookie)
    found = await load_session(db, token)
    if found is None:
        raise unauthenticated()
    sess, user = found
    if not user.active:
        raise unauthenticated("suspended", "This account is suspended. Contact Team OSSC.")
    return sess, user


async def pending_principal(request: Request, db: AsyncSession = Depends(get_session)) -> Principal:
    """A signed-in session that may still be waiting for its second factor."""
    sess, user = await _resolve(request, db)
    check_csrf(request, sess)
    return Principal(user=user, session=sess)


async def current_principal(request: Request, db: AsyncSession = Depends(get_session)) -> Principal:
    from app.services.accounts import next_step

    sess, user = await _resolve(request, db)
    step = next_step(user, sess)
    if step == "change_password":
        raise unauthenticated("password_change_required", "Set a new password to continue.")
    if step != "done":
        raise unauthenticated("mfa_required", "Enter the code from your authenticator app.")
    check_csrf(request, sess)
    return Principal(user=user, session=sess)


def require(*caps: str):
    """Dependency factory: the principal must hold every listed capability."""

    async def _dep(p: Principal = Depends(current_principal)) -> Principal:
        if not all(p.can(c) for c in caps):
            raise forbidden()
        return p

    return _dep


def require_any(*caps: str):
    async def _dep(p: Principal = Depends(current_principal)) -> Principal:
        if not any(p.can(c) for c in caps):
            raise forbidden()
        return p

    return _dep
