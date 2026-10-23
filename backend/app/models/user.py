"""Named user accounts provisioned by Team OSSC."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Integer, String, Text, true
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import created_at, updated_at, uuid_pk
from app.security.roles import ROLES

_roles_sql = ", ".join(f"'{r}'" for r in ROLES)


class User(Base):
    __tablename__ = "app_user"
    __table_args__ = (
        CheckConstraint(f"role IN ({_roles_sql})", name="app_user_role_valid"),
        # Stored lowercased so sign-in and uniqueness are case-insensitive.
        CheckConstraint("email = lower(btrim(email))", name="app_user_email_normalised"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    email: Mapped[str] = mapped_column(String(254), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    # Encrypted copy of the temporary password Team OSSC issued. Cleared when
    # the person chooses their own password; chosen passwords are never kept
    # reversibly.
    temp_password_enc: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Second factor for admin-portal roles.
    totp_secret: Mapped[str | None] = mapped_column(String(64))
    totp_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Last accepted TOTP time-step; a code at or before it is a replay.
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger)
    recovery_code_hashes: Mapped[list[str]] = mapped_column(ARRAY(String(255)), nullable=False, default=list)

    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when Team OSSC issues a temporary password (import, create, reset).
    # The person must replace it at first sign-in, before it expires.
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=true())
    temp_password_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Optimistic concurrency for admin edits.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


def normalise_email(raw: str) -> str:
    return raw.strip().lower()
