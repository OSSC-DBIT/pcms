"""Versioned cost proposals and their decisions. Money is INR in integer paise."""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk

PROPOSAL_STATES = ("pending", "approved", "rejected", "clarify", "defer", "superseded")
DECISION_KINDS = ("approved", "rejected", "clarify", "defer")


class Proposal(Base):
    __tablename__ = "proposal"
    __table_args__ = (
        UniqueConstraint("ticket_id", "version", name="proposal_ticket_version_unique"),
        CheckConstraint("total_paise >= 0", name="proposal_total_non_negative"),
        CheckConstraint(f"state IN ({', '.join(repr(s) for s in PROPOSAL_STATES)})", name="proposal_state_valid"),
        # At most one proposal awaiting a decision per ticket.
        Index("uq_proposal_one_pending", "ticket_id", unique=True, postgresql_where=text("state = 'pending'")),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    remedy: Mapped[str] = mapped_column(Text, nullable=False)
    total_paise: Mapped[int] = mapped_column(BigInteger, nullable=False)
    requested_date: Mapped[date] = mapped_column(Date, nullable=False)
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    state: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ProposalLine(Base):
    __tablename__ = "proposal_line"
    __table_args__ = (CheckConstraint("paise >= 0", name="proposal_line_non_negative"),)

    proposal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("proposal.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    paise: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Decision(Base):
    """Exactly one decision per proposal version (unique proposal_id)."""

    __tablename__ = "decision"
    __table_args__ = (
        CheckConstraint(f"kind IN ({', '.join(repr(k) for k in DECISION_KINDS)})", name="decision_kind_valid"),
        CheckConstraint("ceiling_paise IS NULL OR ceiling_paise > 0", name="decision_ceiling_positive"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    proposal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("proposal.id"), unique=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    decided_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ceiling_paise: Mapped[int | None] = mapped_column(BigInteger)
    conditions: Mapped[str | None] = mapped_column(String(500))
    reason: Mapped[str | None] = mapped_column(String(1000))
    review_date: Mapped[date | None] = mapped_column(Date)
