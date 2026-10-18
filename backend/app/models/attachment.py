"""Ticket evidence. Files live on a private volume under random keys; never in the web root."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk

ATTACHMENT_STATES = ("pending", "scanning", "available", "failed")


class Attachment(Base):
    __tablename__ = "attachment"
    __table_args__ = (
        CheckConstraint("kind IN ('photo', 'video')", name="attachment_kind_valid"),
        CheckConstraint(f"state IN ({', '.join(repr(s) for s in ATTACHMENT_STATES)})", name="attachment_state_valid"),
        CheckConstraint("size_bytes > 0", name="attachment_size_positive"),
        Index("ix_attachment_ticket", "ticket_id"),
        Index("ix_attachment_state", "state"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    original_name: Mapped[str] = mapped_column(String(120), nullable=False)
    content_type: Mapped[str] = mapped_column(String(40), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    state: Mapped[str] = mapped_column(String(10), nullable=False, default="pending")
    failure_reason: Mapped[str | None] = mapped_column(String(200))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    retention_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
