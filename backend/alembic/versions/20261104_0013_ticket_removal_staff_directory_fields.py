"""ticket removal by Team OSSC, department and position on accounts

DBIT, 4 November 2026:
  - Team OSSC can remove any ticket. History is append-only, so a removed ticket
    keeps its rows; it is hidden from every list, report and export and returns 404.
  - The people import takes each person's department and position.

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-04
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ticket", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ticket", sa.Column("deleted_by", sa.UUID(), nullable=True))
    op.add_column("ticket", sa.Column("delete_reason", sa.String(length=500), nullable=True))
    op.create_foreign_key("fk_ticket_deleted_by", "ticket", "app_user", ["deleted_by"], ["id"])
    op.create_check_constraint("ticket_deleted_has_reason", "ticket",
                               "deleted_at IS NULL OR (deleted_by IS NOT NULL AND delete_reason IS NOT NULL)")
    op.create_index("ix_ticket_live", "ticket", ["created_at"], unique=False,
                    postgresql_where=sa.text("deleted_at IS NULL"))

    op.add_column("app_user", sa.Column("department", sa.String(length=120), nullable=True))
    op.add_column("app_user", sa.Column("position", sa.String(length=120), nullable=True))


def downgrade() -> None:
    op.drop_column("app_user", "position")
    op.drop_column("app_user", "department")
    op.drop_index("ix_ticket_live", table_name="ticket")
    op.drop_constraint("ticket_deleted_has_reason", "ticket", type_="check")
    op.drop_constraint("fk_ticket_deleted_by", "ticket", type_="foreignkey")
    op.drop_column("ticket", "delete_reason")
    op.drop_column("ticket", "deleted_by")
    op.drop_column("ticket", "deleted_at")
