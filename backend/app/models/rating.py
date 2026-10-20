"""Reporter ratings for completed repairs. One immutable row per ticket."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import uuid_pk


class TicketRating(Base):
    __tablename__ = "ticket_rating"
    __table_args__ = (
        UniqueConstraint("ticket_id", name="uq_ticket_rating_ticket"),
        CheckConstraint("stars BETWEEN 1 AND 5", name="ticket_rating_stars"),
        CheckConstraint("char_length(comment) <= 1000", name="ticket_rating_comment_length"),
        Index("ix_ticket_rating_created", "created_at"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ticket.id"), nullable=False
    )
    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=False
    )
    stars: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
