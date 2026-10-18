"""Durable notification outbox (plan section 13).

Rows are written in the same transaction as the business change. A separate
worker process claims them with FOR UPDATE SKIP LOCKED and sends them, so a
provider outage never blocks or loses a ticket update.
"""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

OUTBOX_CHANNELS = ("email", "webpush", "whatsapp", "sms")
OUTBOX_STATES = ("pending", "sending", "sent", "action_required", "cancelled", "expired")


class Outbox(Base):
    __tablename__ = "outbox"
    __table_args__ = (
        CheckConstraint(f"channel IN ({', '.join(repr(c) for c in OUTBOX_CHANNELS)})", name="outbox_channel_valid"),
        CheckConstraint(f"state IN ({', '.join(repr(s) for s in OUTBOX_STATES)})", name="outbox_state_valid"),
        CheckConstraint("(user_id IS NULL) <> (worker_id IS NULL)", name="outbox_one_recipient"),
        Index("ix_outbox_due", "next_attempt_at", postgresql_where=text("state = 'pending'")),
        Index("ix_outbox_ticket", "ticket_id"),
        Index("ix_outbox_assignment", "assignment_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    # Deduplication key: the same business event never produces two messages.
    event_key: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    channel: Mapped[str] = mapped_column(String(10), nullable=False)
    template: Mapped[str] = mapped_column(String(40), nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"))
    worker_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("worker.id"))
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"))
    assignment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("assignment.id"))
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    provider_status: Mapped[str | None] = mapped_column(String(20))
    last_error: Mapped[str | None] = mapped_column(Text)
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeliveryAttempt(Base):
    __tablename__ = "delivery_attempt"
    __table_args__ = (Index("ix_delivery_attempt_outbox", "outbox_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    outbox_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("outbox.id"), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    status_code: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    provider_id: Mapped[str | None] = mapped_column(String(64))


class ProviderEvent(Base):
    """Inbound webhook calls, deduplicated by provider message SID plus event type."""

    __tablename__ = "provider_event"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
