"""Machine translations of typed text (English, Kannada, Hindi)

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "text_translation",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source_sha256", sa.String(length=64), nullable=False),
        sa.Column("source_lang", sa.String(length=2), nullable=False),
        sa.Column("target", sa.String(length=2), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=False),
        sa.Column("translated", sa.Text(), nullable=True),
        sa.Column("state", sa.String(length=8), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("target IN ('en', 'kn', 'hi')", name="text_translation_target_valid"),
        sa.CheckConstraint("source_lang IN ('en', 'kn', 'hi')", name="text_translation_source_valid"),
        sa.CheckConstraint("state IN ('pending', 'done', 'failed')", name="text_translation_state_valid"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_sha256", "target", name="uq_text_translation_source_target"),
    )
    op.create_index("ix_text_translation_pending", "text_translation", ["state", "next_attempt_at"])


def downgrade() -> None:
    op.drop_index("ix_text_translation_pending", table_name="text_translation")
    op.drop_table("text_translation")