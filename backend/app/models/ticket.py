"""Tickets, token counters, timeline events and comments."""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk

STATUSES = ("Submitted", "Triaged", "Assigned", "InProgress", "OnHold", "AwaitingApproval",
            "Resolved", "Closed", "Cancelled", "Rejected", "Duplicate")
TERMINAL = ("Closed", "Cancelled", "Rejected", "Duplicate")
IMPACTS = ("safety", "class_interrupted", "multiple_areas", "routine")
PRIORITIES = ("P1", "P2", "P3", "P4")
FLAGS = ("I", "C", "P")
ASSESSMENTS = ("simple", "workforce", "parts", "expenditure")


def _in(col: str, values) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class TokenCounter(Base):
    """Per category, per Asia/Kolkata year serial. Row-locked inside ticket creation."""

    __tablename__ = "token_counter"

    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("category.id"), primary_key=True)
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_serial: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Ticket(Base):
    __tablename__ = "ticket"
    __table_args__ = (
        CheckConstraint(_in("status", STATUSES), name="ticket_status_valid"),
        CheckConstraint(_in("impact", IMPACTS), name="ticket_impact_valid"),
        CheckConstraint(_in("priority", PRIORITIES), name="ticket_priority_valid"),
        CheckConstraint(f"flag IS NULL OR {_in('flag', FLAGS)}", name="ticket_flag_valid"),
        CheckConstraint(f"assessments <@ ARRAY[{', '.join(repr(a) for a in ASSESSMENTS)}]::text[]", name="ticket_assessments_valid"),
        CheckConstraint("char_length(title) BETWEEN 4 AND 120", name="ticket_title_length"),
        CheckConstraint("char_length(description) <= 2000", name="ticket_description_length"),
        CheckConstraint("version >= 1", name="ticket_version_positive"),
        CheckConstraint("duplicate_of_id IS NULL OR duplicate_of_id <> id", name="ticket_not_own_duplicate"),
        UniqueConstraint("reporter_id", "client_request_id", name="ticket_reporter_request_unique"),
        Index("ix_ticket_status", "status"),
        Index("ix_ticket_reporter", "reporter_id", "created_at"),
        Index("ix_ticket_category", "category_id"),
        Index("ix_ticket_location", "building_code", "room"),
        Index("ix_ticket_next_update_due", "next_update_due", postgresql_where=text("status NOT IN ('Closed','Cancelled','Rejected','Duplicate')")),
        Index("ix_ticket_created", "created_at"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    token: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    reporter_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    original_category_id: Mapped[int] = mapped_column(Integer, ForeignKey("category.id"), nullable=False)
    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("category.id"), nullable=False)
    subtype: Mapped[str | None] = mapped_column(String(80))

    building_code: Mapped[str | None] = mapped_column(String(20))
    floor: Mapped[str | None] = mapped_column(String(20))
    room: Mapped[str | None] = mapped_column(String(60))
    outdoors: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    landmark: Mapped[str | None] = mapped_column(String(120))

    title: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    impact: Mapped[str] = mapped_column(String(24), nullable=False)
    access_note: Mapped[str | None] = mapped_column(String(200))
    alt_contact: Mapped[str | None] = mapped_column(String(120))

    priority: Mapped[str] = mapped_column(String(2), nullable=False)
    flag: Mapped[str | None] = mapped_column(String(1))
    assessments: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, default=list, server_default="{}")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="Submitted")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    next_update_due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verified_by_reporter: Mapped[bool | None] = mapped_column(Boolean)

    hold_reason: Mapped[str | None] = mapped_column(String(500))
    hold_owner: Mapped[str | None] = mapped_column(String(120))
    hold_next_action: Mapped[str | None] = mapped_column(String(500))
    hold_review_date: Mapped[date | None] = mapped_column(Date)

    duplicate_of_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"))

    # Reporter-scoped idempotency (plan section 6).
    client_request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class TicketEvent(Base):
    """Timeline entries. Append-only (database trigger). public=False hides an entry from the reporter."""

    __tablename__ = "ticket_event"
    __table_args__ = (Index("ix_ticket_event_ticket", "ticket_id", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"))
    actor_label: Mapped[str] = mapped_column(String(160), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(1000))
    public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str | None] = mapped_column(String(20))
    delegated_worker: Mapped[str | None] = mapped_column(String(160))


class TicketComment(Base):
    """Public comments and internal notes. Append-only."""

    __tablename__ = "ticket_comment"
    __table_args__ = (
        Index("ix_ticket_comment_ticket", "ticket_id", "created_at"),
        CheckConstraint("char_length(body) BETWEEN 1 AND 2000", name="ticket_comment_length"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    author_label: Mapped[str] = mapped_column(String(160), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    internal: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
