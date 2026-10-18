"""Server-side sessions and sign-in throttling records."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk


class UserSession(Base):
    __tablename__ = "user_session"
    __table_args__ = (Index("ix_user_session_user", "user_id"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    # SHA-256 of the cookie value; the raw token is never stored.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    # False until an admin-portal user passes TOTP; such a session can only finish MFA.
    mfa_ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    pending_totp_secret: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class ThrottleEvent(Base):
    __tablename__ = "throttle_event"
    __table_args__ = (Index("ix_throttle_event_key_at", "key", "at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
