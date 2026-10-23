"""ticket rating and manual worker name

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-20
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ticket", sa.Column("worker_name", sa.String(length=120), nullable=True))

    op.create_table(
        "ticket_rating",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("ticket_id", sa.UUID(), nullable=False),
        sa.Column("reporter_id", sa.UUID(), nullable=False),
        sa.Column("stars", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("stars BETWEEN 1 AND 5", name="ticket_rating_stars"),
        sa.CheckConstraint("char_length(comment) <= 1000", name="ticket_rating_comment_length"),
        sa.ForeignKeyConstraint(["reporter_id"], ["app_user.id"]),
        sa.ForeignKeyConstraint(["ticket_id"], ["ticket.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ticket_id", name="uq_ticket_rating_ticket"),
    )
    op.create_index("ix_ticket_rating_created", "ticket_rating", ["created_at"], unique=False)

    # Keep the name of in-flight work. Old assignments stay untouched.
    op.execute(sa.text("""
        UPDATE ticket t
        SET worker_name = x.name
        FROM (
            SELECT DISTINCT ON (a.ticket_id) a.ticket_id, w.name
            FROM assignment a
            JOIN worker w ON w.id = a.worker_id
            WHERE a.released_at IS NULL
            ORDER BY a.ticket_id, a.lead DESC, a.assigned_at
        ) x
        WHERE t.id = x.ticket_id
          AND t.worker_name IS NULL
    """))

    # No worker message goes out after the cutover. The manager contacts workers directly.
    op.execute(sa.text("""
        UPDATE outbox
        SET state = 'expired',
            last_error = 'Worker dispatch retired; the manager contacts workers directly'
        WHERE channel IN ('whatsapp', 'sms')
          AND state = 'pending'
          AND template IN ('job_dispatch', 'job_fallback')
    """))


def downgrade() -> None:
    op.drop_index("ix_ticket_rating_created", table_name="ticket_rating")
    op.drop_table("ticket_rating")
    op.drop_column("ticket", "worker_name")
