"""Worker directory (no logins) and ticket assignments."""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk

WORKER_MODES = ("whatsapp", "sms", "call")
WORKER_KINDS = ("employee", "vendor")
CHANNELS = ("whatsapp", "sms", "call", "card")
DELIVERY = ("queued", "sent", "delivered", "read", "failed", "unknown", "not_applicable")
ACCEPT_VIA = ("whatsapp", "sms", "call", "in_person")


class Worker(Base):
    __tablename__ = "worker"
    __table_args__ = (
        CheckConstraint(f"mode IN ({', '.join(repr(m) for m in WORKER_MODES)})", name="worker_mode_valid"),
        CheckConstraint(f"kind IN ({', '.join(repr(k) for k in WORKER_KINDS)})", name="worker_kind_valid"),
        CheckConstraint(r"phone_e164 ~ '^\+[1-9][0-9]{7,14}$'", name="worker_phone_e164"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone_e164: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    alt_phone_e164: Mapped[str | None] = mapped_column(String(16))
    area: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    language: Mapped[str] = mapped_column(String(8), nullable=False, default="hi")
    mode: Mapped[str] = mapped_column(String(10), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class WorkerSkill(Base):
    __tablename__ = "worker_skill"

    worker_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("worker.id", ondelete="CASCADE"), primary_key=True)
    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("category.id"), primary_key=True)


class Assignment(Base):
    """One worker on one ticket. Released rows stay as history; nothing is overwritten."""

    __tablename__ = "assignment"
    __table_args__ = (
        CheckConstraint(f"channel IN ({', '.join(repr(c) for c in CHANNELS)})", name="assignment_channel_valid"),
        CheckConstraint(f"delivery IN ({', '.join(repr(d) for d in DELIVERY)})", name="assignment_delivery_valid"),
        CheckConstraint(f"accepted_via IS NULL OR accepted_via IN ({', '.join(repr(v) for v in ACCEPT_VIA)})", name="assignment_accepted_via_valid"),
        # Plan 16.1: exactly one active lead per ticket.
        Index("uq_assignment_one_active_lead", "ticket_id", unique=True, postgresql_where=text("lead AND released_at IS NULL")),
        # The same worker cannot hold two active assignments on one ticket.
        Index("uq_assignment_active_worker", "ticket_id", "worker_id", unique=True, postgresql_where=text("released_at IS NULL")),
        Index("ix_assignment_worker_active", "worker_id", postgresql_where=text("released_at IS NULL")),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False)
    worker_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("worker.id"), nullable=False)
    lead: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    channel: Mapped[str] = mapped_column(String(10), nullable=False)
    delivery: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    assigned_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    ack_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_via: Mapped[str | None] = mapped_column(String(10))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    release_reason: Mapped[str | None] = mapped_column(String(500))
    fallback_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
