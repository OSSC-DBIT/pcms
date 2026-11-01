"""Machine translations of text people type (titles, descriptions, messages, reasons).

A cache keyed by the source text's SHA-256 and the target language, so the same text
is translated once. The API only reads finished rows; the outbox worker (the only
service with internet access) fills in pending ones. The original text is always kept
on its own row in the ticket tables and is never replaced.
"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

LANGS = ("en", "kn", "hi")
TRANSLATION_STATES = ("pending", "done", "failed")


class TextTranslation(Base):
    __tablename__ = "text_translation"
    __table_args__ = (
        UniqueConstraint("source_sha256", "target", name="uq_text_translation_source_target"),
        CheckConstraint(f"target IN ({', '.join(repr(x) for x in LANGS)})", name="text_translation_target_valid"),
        CheckConstraint(f"source_lang IN ({', '.join(repr(x) for x in LANGS)})", name="text_translation_source_valid"),
        CheckConstraint(f"state IN ({', '.join(repr(x) for x in TRANSLATION_STATES)})", name="text_translation_state_valid"),
        Index("ix_text_translation_pending", "state", "next_attempt_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_lang: Mapped[str] = mapped_column(String(2), nullable=False)
    target: Mapped[str] = mapped_column(String(2), nullable=False)
    source_text: Mapped[str] = mapped_column(Text, nullable=False)
    translated: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(8), nullable=False, server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
